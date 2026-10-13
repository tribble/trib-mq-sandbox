#!/usr/bin/env node
// Sandbox CI runner: reads the directives added since the merge-base with the base branch, then
// passes, fails or flakes after a simulated duration. This file is the I/O shell (git, sleeping,
// logs, annotations, summary, exit code); the rules live in rules.mjs.
//
// Usage: node runner/run.mjs [--base origin/main] [--dry-run] [--seed N] [--time-scale 1] [--max-seconds N]

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { describeFailure, evaluate, mulberry32, parseDirective, seedFromRun } from './rules.mjs';

/** @typedef {import('./rules.mjs').Directive} Directive */
/** @typedef {import('./rules.mjs').Evaluation} Evaluation */

const USAGE = [
  'Usage: node runner/run.mjs [--base origin/main] [--dry-run] [--seed N] [--time-scale 1] [--max-seconds N]',
  '  --base <ref>         branch to compare against (default origin/main)',
  '  --dry-run            print the results table and exit by the outcome; no sleep, no summary',
  '  --seed <n>           flake seed, an integer 0..4294967295 (default: from GITHUB_RUN_ID, else random)',
  '  --time-scale <x>     real seconds per simulated second, >= 0 (default 1; 0 = no sleep)',
  '  --max-seconds <n>    cap the sleep at n simulated seconds, >= 0 (the outcome is unchanged)',
].join('\n');
const DIRECTIVE_PATH = /^directives\/[^/]+\.json$/;
const HEARTBEAT_MS = 10_000;
const MAX_UINT32 = 4294967295;
const TABLE_HEADERS = ['Directive', 'Title', 'Spec', 'Result', 'At'];

class UsageError extends Error {}

/**
 * @typedef {object} Options
 * @property {string} base
 * @property {boolean} dryRun
 * @property {number | undefined} seed
 * @property {number} timeScale
 * @property {number | undefined} maxSeconds
 * @property {boolean} help
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        base: { type: 'string', default: 'origin/main' },
        'dry-run': { type: 'boolean', default: false },
        seed: { type: 'string' },
        'time-scale': { type: 'string', default: '1' },
        'max-seconds': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const base = /** @type {string} */ (values.base);
  if (base === '' || base.startsWith('-')) throw new UsageError(`--base must be a git ref (got "${base}")`);

  /** @type {number | undefined} */
  let seed;
  if (values.seed !== undefined) {
    const text = /** @type {string} */ (values.seed);
    if (!/^\d+$/.test(text) || Number(text) > MAX_UINT32) {
      throw new UsageError(`--seed must be an integer from 0 to ${MAX_UINT32} (got "${text}")`);
    }
    seed = Number(text);
  }

  const timeScale = parseNonNegative('--time-scale', /** @type {string} */ (values['time-scale']));
  const maxSeconds =
    values['max-seconds'] === undefined
      ? undefined
      : parseNonNegative('--max-seconds', /** @type {string} */ (values['max-seconds']));

  return {
    base,
    dryRun: Boolean(values['dry-run']),
    seed,
    timeScale,
    maxSeconds,
    help: Boolean(values.help),
  };
}

/**
 * @param {string} flag
 * @param {string} text
 */
function parseNonNegative(flag, text) {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value < 0) {
    throw new UsageError(`${flag} must be a finite number >= 0 (got "${text}")`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Workflow commands (annotations)

/** @param {string} text */
function escapeData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** @param {string} text */
function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * @param {'error' | 'warning' | 'notice'} level
 * @param {string} message
 * @param {{ file?: string, title?: string }} [props]
 */
function annotate(level, message, props = {}) {
  const parts = [];
  if (props.file !== undefined) parts.push(`file=${escapeProperty(props.file)}`);
  if (props.title !== undefined) parts.push(`title=${escapeProperty(props.title)}`);
  const head = parts.length > 0 ? `::${level} ${parts.join(',')}` : `::${level}`;
  console.log(`${head}::${escapeData(message)}`);
}

// ---------------------------------------------------------------------------------------------
// Git plumbing. All reads come from commits (never the working tree), so local dry-runs match CI.

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {string} [input]
 * @returns {Buffer}
 */
function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ ok: true, out: string } | { ok: false, err: string }}
 */
function tryGit(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args).toString('utf8') };
  } catch (err) {
    const e = /** @type {{ stderr?: Buffer, message?: string }} */ (err);
    const stderr = e.stderr ? e.stderr.toString('utf8').trim() : '';
    return { ok: false, err: stderr || String(e.message ?? err) };
  }
}

/**
 * Every top-level directives/*.json blob in HEAD, with its contents, sorted by path.
 * @param {string} root
 * @returns {Map<string, string>} path -> text
 */
function readPresent(root) {
  const listing = git(root, ['ls-tree', '-z', 'HEAD', '--', 'directives/']).toString('utf8');
  /** @type {{ path: string, oid: string }[]} */
  const entries = [];
  for (const record of listing.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type === 'blob' && DIRECTIVE_PATH.test(path)) entries.push({ path, oid });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /** @type {Map<string, string>} */
  const present = new Map();
  if (entries.length === 0) return present;
  const batch = git(root, ['cat-file', '--batch'], `${entries.map((e) => e.oid).join('\n')}\n`);
  let pos = 0;
  for (const { path, oid } of entries) {
    const newline = batch.indexOf(0x0a, pos);
    const header = batch.toString('utf8', pos, newline).split(' ');
    if (header[0] !== oid || header[1] !== 'blob') {
      throw new Error(`git cat-file returned "${header.join(' ')}" for ${path}`);
    }
    const size = Number(header[2]);
    present.set(path, batch.toString('utf8', newline + 1, newline + 1 + size));
    pos = newline + 1 + size + 1;
  }
  return present;
}

/**
 * Directive files changed between the merge-base and HEAD.
 * @param {string} root
 * @param {string} mergeBase
 * @returns {{ status: string, path: string }[]}
 */
function readChanges(root, mergeBase) {
  const out = git(root, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    mergeBase,
    'HEAD',
    '--',
    'directives/*.json',
  ]).toString('utf8');
  const fields = out.split('\0');
  /** @type {{ status: string, path: string }[]} */
  const changes = [];
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++];
    if (status === '') continue;
    // Renames and copies carry two paths; --no-renames means they should not appear.
    if (status[0] === 'R' || status[0] === 'C') {
      i++;
    }
    const path = fields[i++];
    if (path !== undefined && DIRECTIVE_PATH.test(path)) changes.push({ status: status[0], path });
  }
  return changes;
}

/** @param {string} path */
function stemOf(path) {
  return path.slice('directives/'.length, -'.json'.length);
}

// ---------------------------------------------------------------------------------------------
// Output formatting

/** @param {string} text */
function oneLine(text) {
  return text.replace(/[\r\n]+/g, ' ');
}

/** @param {number | null} at */
function formatAt(at) {
  return at === null ? '-' : `${at}s`;
}

/** @param {number} seconds */
function formatSeconds(seconds) {
  return `${Number(seconds.toFixed(1))}s`;
}

/**
 * @param {Evaluation} evaluation
 * @returns {string[][]}
 */
function tableCells(evaluation) {
  return evaluation.rows.map((r) => [r.id, oneLine(r.title), r.spec, r.result, formatAt(r.at)]);
}

/**
 * Plain-text table with aligned columns.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function textTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** @param {string} text */
function escapeCell(text) {
  return oneLine(text).replace(/\|/g, '\\|');
}

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function markdownTable(headers, rows) {
  const line = (/** @type {string[]} */ cells) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [line(headers), `|${headers.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

/** @param {number} n */
function inertLine(n) {
  return `${n} inert directives on main`;
}

// ---------------------------------------------------------------------------------------------
// Main

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>} exit code
 */
async function main(argv, env) {
  /** @type {Options} */
  let opts;
  try {
    opts = parseOptions(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`run.mjs: ${err.message}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const top = tryGit(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    annotate('error', `Not inside a git repository: ${top.err}`, { title: 'Runner setup' });
    return 1;
  }
  const root = top.out.trim();

  const mb = tryGit(root, ['merge-base', 'HEAD', opts.base]);
  if (!mb.ok) {
    annotate(
      'error',
      `Could not find a merge-base between HEAD and "${opts.base}" (${mb.err || 'no common ancestor'}). ` +
        'The base ref must exist locally, and in CI the checkout needs full history ' +
        '(actions/checkout with fetch-depth: 0).',
      { title: 'No merge-base' },
    );
    return 1;
  }
  const mergeBase = mb.out.trim();

  /** @type {number} */
  let seed;
  /** @type {string} */
  let seedSource;
  if (opts.seed !== undefined) {
    seed = opts.seed;
    seedSource = 'from --seed';
  } else if (env.GITHUB_RUN_ID) {
    const attempt = env.GITHUB_RUN_ATTEMPT || '1';
    seed = seedFromRun(env.GITHUB_RUN_ID, attempt);
    seedSource = `from GITHUB_RUN_ID=${env.GITHUB_RUN_ID}, GITHUB_RUN_ATTEMPT=${attempt}`;
  } else {
    seed = randomBytes(4).readUInt32BE(0);
    seedSource = 'random';
  }
  const reproduce = `node runner/run.mjs --dry-run --base ${opts.base} --seed ${seed}`;

  console.log(`Base: ${opts.base}`);
  if (!opts.dryRun) console.log(`Merge-base: ${mergeBase}`);
  console.log(`Seed: ${seed} (${seedSource})`);

  const files = readPresent(root);
  /** @type {string[]} */
  const activePaths = [];
  for (const { status, path } of readChanges(root, mergeBase)) {
    if (status === 'A') {
      activePaths.push(path);
    } else if (status === 'M' || status === 'T') {
      activePaths.push(path);
      annotate('warning', `Modified directive ${path} is treated as active (it changed since the merge-base).`, {
        file: path,
      });
    }
    // D (deleted) is ignored: a deleted directive can break nothing.
  }
  activePaths.sort();
  const activeSet = new Set(activePaths);

  /** @type {Map<string, Directive | null>} */
  const present = new Map();
  /** @type {Directive[]} */
  const active = [];
  /** @type {{ path: string, message: string }[]} */
  const activeErrors = [];
  for (const [path, text] of files) {
    const { directive, errors, warnings } = parseDirective(text, stemOf(path));
    present.set(stemOf(path), directive);
    if (activeSet.has(path)) {
      for (const message of errors) {
        annotate('error', message, { file: path, title: 'Invalid directive' });
        activeErrors.push({ path, message });
      }
      for (const message of warnings) annotate('warning', message, { file: path });
      if (directive) active.push(directive);
    } else {
      for (const message of errors) annotate('warning', message, { file: path, title: 'Invalid inert directive' });
    }
  }
  for (const path of activePaths) {
    if (!files.has(path)) {
      const message = 'directive is not a regular file in HEAD';
      annotate('error', message, { file: path, title: 'Invalid directive' });
      activeErrors.push({ path, message });
    }
  }
  const inertCount = present.size - activePaths.filter((p) => files.has(p)).length;

  console.log(
    activePaths.length === 0
      ? 'Active directives: none'
      : `Active directives: ${activePaths.length} (${activePaths.map(stemOf).join(', ')})`,
  );

  /** @type {string[]} */
  const summaryInfo = [
    `- Seed: \`${seed}\` (${seedSource})`,
    `- Base: \`${opts.base}\`, merge-base \`${mergeBase}\``,
  ];

  if (activeErrors.length > 0) {
    const list = activeErrors.map((e) => `${e.path}: ${oneLine(e.message)}`);
    console.log('');
    console.log(`Invalid active directives, failing at t=0s (${list.length} errors):`);
    for (const item of list) console.log(`  - ${item}`);
    console.log('');
    console.log('Result: FAIL - invalid active directives at t=0s');
    console.log(inertLine(inertCount));
    if (!opts.dryRun && env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        [
          '## Sandbox CI: fail',
          '',
          'Invalid active directives: failing at t=0s.',
          '',
          ...summaryInfo,
          '',
          '**Errors**',
          '',
          ...list.map((item) => `- ${item}`),
          '',
          inertLine(inertCount),
          '',
        ].join('\n'),
      );
    }
    return 1;
  }

  const evaluation = evaluate({ active, present, rng: mulberry32(seed) });
  const failureText = describeFailure(evaluation);
  const resultLine = evaluation.ok
    ? `Result: PASS at t=${evaluation.endsAt}s`
    : `Result: FAIL - ${failureText} (run time ${evaluation.runTime}s)`;

  const printResults = () => {
    console.log('');
    console.log(textTable(TABLE_HEADERS, tableCells(evaluation)));
    if (evaluation.note) console.log(evaluation.note);
    console.log('');
    console.log(resultLine);
    console.log(inertLine(inertCount));
    console.log(`Reproduce: ${reproduce}`);
  };

  if (opts.dryRun) {
    printResults();
    return evaluation.ok ? 0 : 1;
  }

  // Simulate the run: sleep until the outcome is due, optionally capped.
  const target = Math.min(evaluation.endsAt, opts.maxSeconds ?? Number.POSITIVE_INFINITY);
  const capped = target < evaluation.endsAt;
  const capNote = capped ? `sleep capped at ${formatSeconds(target)}; outcome unchanged` : null;
  const realMs = target * opts.timeScale * 1000;
  console.log(
    `Simulating ${formatSeconds(target)} at time scale ${opts.timeScale} (${formatSeconds(realMs / 1000)} real)`,
  );
  if (capNote) {
    console.log(`${capNote} (--max-seconds ${opts.maxSeconds}; the outcome is due at t=${evaluation.endsAt}s)`);
  }
  let elapsedMs = 0;
  while (elapsedMs < realMs) {
    const step = Math.min(HEARTBEAT_MS, realMs - elapsedMs);
    await sleep(step);
    elapsedMs += step;
    console.log(`t=${formatSeconds(elapsedMs / 1000 / opts.timeScale)} of ${formatSeconds(target)}`);
  }

  printResults();
  if (capNote) console.log(capNote);
  if (failureText) annotate('error', failureText, { title: 'Directive failed' });

  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Sandbox CI: ${evaluation.ok ? 'pass' : 'fail'}`,
      '',
      evaluation.ok
        ? `Passed at t=${evaluation.endsAt}s.`
        : `${failureText} (run time ${evaluation.runTime}s).`,
      '',
      ...summaryInfo,
    ];
    if (capNote) lines.push(`- Note: ${capNote}`);
    lines.push('', markdownTable(TABLE_HEADERS, tableCells(evaluation)), '');
    if (evaluation.note) lines.push(evaluation.note, '');
    lines.push(inertLine(inertCount), '', `Reproduce locally: \`${reproduce}\``, '');
    appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  }

  return evaluation.ok ? 0 : 1;
}

main(process.argv.slice(2), process.env).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    annotate('error', err instanceof Error ? (err.stack ?? err.message) : String(err), {
      title: 'Runner crashed',
    });
    process.exitCode = 1;
  },
);
