// Integration tests: build throwaway git repos under the OS temp dir and spawn the real run.mjs.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { durationFactor, fnv1a } from './rules.mjs';

const RUN = fileURLToPath(new URL('./run.mjs', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const execFileAsync = promisify(execFile);

/** @type {string} */
let tmpRoot;
/** @type {Record<string, string>} */
let baseEnv;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sandbox-runner-test-'));
  const gitConfig = join(tmpRoot, 'gitconfig');
  writeFileSync(gitConfig, '');
  // An explicit environment: nothing leaks in from the host or from GitHub Actions (GITHUB_*),
  // and the user's git config (hooks, signing, default branch) cannot interfere.
  baseEnv = {
    PATH: process.env.PATH ?? '',
    HOME: tmpRoot,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_AUTHOR_NAME: 'Runner Test',
    GIT_AUTHOR_EMAIL: 'runner-test@example.com',
    GIT_COMMITTER_NAME: 'Runner Test',
    GIT_COMMITTER_EMAIL: 'runner-test@example.com',
  };
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * A temp git repo on branch main with one initial commit, plus a summary file path next to it.
 */
async function makeRepo() {
  const caseDir = mkdtempSync(join(tmpRoot, 'case-'));
  const dir = join(caseDir, 'repo');
  mkdirSync(dir);
  const git = async (/** @type {string[]} */ ...args) =>
    (await execFileAsync('git', args, { cwd: dir, env: baseEnv, encoding: 'utf8' })).stdout;

  await git('-c', 'init.defaultBranch=main', 'init', '-q');

  const repo = {
    dir,
    summary: join(caseDir, 'summary.md'),
    /**
     * Apply file changes and commit them. Objects are written as JSON; null deletes the file.
     * @param {string} message
     * @param {Record<string, unknown>} [files]
     */
    async commit(message, files = {}) {
      for (const [rel, content] of Object.entries(files)) {
        const file = join(dir, rel);
        if (content === null) {
          rmSync(file);
        } else {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
        }
      }
      await git('add', '-A');
      await git('commit', '-q', '--allow-empty', '-m', message);
    },
    /** @param {string} name */
    async branch(name) {
      await git('checkout', '-q', '-b', name);
    },
  };
  await repo.commit('init', { 'README.md': 'test repo\n' });
  return repo;
}

/**
 * A valid directive object.
 * @param {string} id
 * @param {Record<string, unknown>} [over]
 */
function directive(id, over = {}) {
  return { id, title: `Directive ${id}`, durationSec: 10, outcome: 'pass', ...over };
}

/**
 * Spawn run.mjs in `cwd` with an explicit environment.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runner(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUN, ...args], {
      cwd,
      env: { ...baseEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Start a command that runs run.mjs, wait until the runner is sleeping, then send `signal` to the
 * started process only (the Actions runner does the same on cancel) and wait for it to exit.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: Record<string, string>, signal: NodeJS.Signals }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, msToExit: number }>}
 */
function signalDuringSleep(command, args, { cwd, env, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let scheduled = false;
    let signalledAt = Number.NaN;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      if (!scheduled && /^Simulating /m.test(stdout)) {
        scheduled = true;
        setTimeout(() => {
          signalledAt = Date.now();
          child.kill(signal);
        }, 300);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, msToExit: Date.now() - signalledAt });
    });
  });
}

/**
 * The table row for a directive id in plain-text stdout.
 * @param {string} stdout
 * @param {string} id
 */
function rowFor(stdout, id) {
  return stdout.split('\n').find((line) => line.startsWith(`${id} `));
}

// Seed 64 has a duration factor of exactly 1.00, so in the dry runs that use it every time equals the
// declared durationSec. Other tests below use seeds with other factors.
const UNIT_SEED = 64;
const DRY = ['--dry-run', '--base', 'main', '--seed', String(UNIT_SEED)];

describe('run.mjs', { concurrency: 8 }, () => {
  test('the seed of the dry runs below has a duration factor of 1.00', () => {
    assert.equal(durationFactor(UNIT_SEED), 1);
  });

  test('an added directive is active', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', { 'directives/added.json': directive('added', { durationSec: 12 }) });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Active directives: 1 \(added\)/);
    assert.match(rowFor(stdout, 'added') ?? '', /Directive added\s+pass 12s\s+passed\s+12s$/);
    assert.match(stdout, /^Result: PASS at t=12s$/m);
    assert.match(stdout, /^0 inert directives on main$/m);
    assert.doesNotMatch(stdout, /::(error|warning)/);
  });

  test('a modified directive is active with a ::warning', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/mod.json': directive('mod') });
    await repo.branch('feature');
    await repo.commit('modify', { 'directives/mod.json': directive('mod', { outcome: 'fail', durationSec: 7 }) });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^::warning file=directives\/mod\.json::Modified directive .* treated as active/m);
    assert.match(rowFor(stdout, 'mod') ?? '', /fail 7s\s+failed\s+7s$/);
    assert.match(stdout, /^Result: FAIL - mod failed at t=7s \(run time 7s\)$/m);
  });

  test('a deleted directive is ignored', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/gone.json': directive('gone', { outcome: 'fail' }) });
    await repo.branch('feature');
    await repo.commit('delete', { 'directives/gone.json': null });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Active directives: none/);
    assert.match(stdout, /No active directives - nothing to test/);
    assert.equal(rowFor(stdout, 'gone'), undefined);
    assert.match(stdout, /^0 inert directives on main$/m);
  });

  test('a rename is treated as delete plus add', async () => {
    const repo = await makeRepo();
    const content = { title: 'Same content', durationSec: 9 };
    await repo.commit('on main', { 'directives/old-name.json': directive('old-name', content) });
    await repo.branch('feature');
    await repo.commit('rename', {
      'directives/old-name.json': null,
      'directives/new-name.json': directive('new-name', content),
    });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Active directives: 1 \(new-name\)/);
    assert.match(rowFor(stdout, 'new-name') ?? '', /passed\s+9s$/);
    assert.equal(rowFor(stdout, 'old-name'), undefined);
    assert.doesNotMatch(stdout, /Modified directive/);
  });

  test('a pure file rename is an add whose id no longer matches the filename', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/before.json': directive('before') });
    await repo.branch('feature');
    await repo.commit('mv', { 'directives/before.json': null, 'directives/after.json': directive('before') });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 1, stdout);
    assert.match(
      stdout,
      /^::error file=directives\/after\.json,title=Invalid directive::id "before" must equal the filename stem "after"$/m,
    );
  });

  test('a malformed active directive fails at t=0 with ::error, without sleeping, and writes the summary', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', {
      'directives/bad.json': { id: 'bad', durationSec: 0 },
      'directives/fine.json': directive('fine', { durationSec: 600 }),
    });
    const started = Date.now();
    // time-scale 1 on purpose: a 600s sleep would hit the spawn timeout, so this proves no sleep happens.
    const { code, stdout } = await runner(repo.dir, ['--base', 'main', '--seed', '1'], {
      GITHUB_STEP_SUMMARY: repo.summary,
    });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^::error file=directives\/bad\.json,title=Invalid directive::title is required$/m);
    assert.match(
      stdout,
      /^::error file=directives\/bad\.json,title=Invalid directive::durationSec must be an integer from 1 to 600 \(got 0\)$/m,
    );
    assert.match(stdout, /^::error file=directives\/bad\.json,title=Invalid directive::outcome is required$/m);
    assert.match(stdout, /^Result: FAIL - invalid active directives at t=0s$/m);
    const md = readFileSync(repo.summary, 'utf8');
    assert.match(md, /^## Sandbox CI: fail$/m);
    assert.match(md, /^- directives\/bad\.json: title is required$/m);
    assert.match(md, /^0 inert directives on main$/m);
  });

  test('a malformed active directive in dry-run mode also fails with ::error', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('junk', { 'directives/junk.json': '{ not json' });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^::error file=directives\/junk\.json,title=Invalid directive::invalid JSON: /m);
  });

  test('a malformed inert directive warns and does not fail', async () => {
    const repo = await makeRepo();
    await repo.commit('broken on main', { 'directives/broken.json': '{ "id": ' });
    await repo.branch('feature');
    await repo.commit('add ok', { 'directives/ok.json': directive('ok') });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^::warning file=directives\/broken\.json,title=Invalid inert directive::invalid JSON: /m);
    assert.doesNotMatch(stdout, /::error/);
    assert.match(rowFor(stdout, 'ok') ?? '', /passed/);
    assert.match(stdout, /^1 inert directives on main$/m);
  });

  test('a breaksWith against a directive on main fails', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/landed.json': directive('landed', { durationSec: 99 }) });
    await repo.branch('feature');
    await repo.commit('add', {
      'directives/newer.json': directive('newer', { durationSec: 20, breaksWith: ['landed'] }),
    });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 1, stdout);
    assert.match(rowFor(stdout, 'newer') ?? '', /pass 20s breaksWith landed\s+broke with landed\s+20s$/);
    assert.match(stdout, /^Result: FAIL - newer broke with landed at t=20s \(run time 20s\)$/m);
    assert.match(stdout, /^1 inert directives on main$/m);
  });

  test('a directive on main that breaks with a new one fails too (symmetry)', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/landed.json': directive('landed', { breaksWith: ['newer'] }) });
    await repo.branch('feature');
    await repo.commit('add', { 'directives/newer.json': directive('newer', { durationSec: 5 }) });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 1, stdout);
    assert.match(rowFor(stdout, 'newer') ?? '', /broke with landed\s+5s$/);
  });

  test('no active directives exits 0 with the note (workflow_dispatch on main)', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/landed.json': directive('landed', { outcome: 'fail' }) });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /No active directives - nothing to test/);
    assert.match(stdout, /^Result: PASS at t=0s$/m);
    assert.match(stdout, /^1 inert directives on main$/m);
  });

  test('nested files and non-json files under directives/ are ignored', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('noise', {
      'directives/sub/nested.json': directive('nested', { outcome: 'fail' }),
      'directives/notes.txt': 'hello',
    });
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Active directives: none/);
  });

  test('only committed changes count, not the working tree', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    mkdirSync(join(repo.dir, 'directives'));
    writeFileSync(join(repo.dir, 'directives/uncommitted.json'), JSON.stringify(directive('uncommitted')));
    const { code, stdout } = await runner(repo.dir, DRY);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Active directives: none/);
  });

  test('--dry-run --seed is deterministic across invocations', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    /** @type {Record<string, unknown>} */
    const files = {};
    for (let i = 0; i < 6; i++) {
      files[`directives/f${i}.json`] = directive(`f${i}`, { outcome: 'flake', flakeRate: 0.5, durationSec: 10 + i });
    }
    await repo.commit('flakes', files);
    const args = ['--dry-run', '--base', 'main', '--seed', '424242'];
    const first = await runner(repo.dir, args);
    const second = await runner(repo.dir, args);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.code, second.code);
    assert.match(first.stdout, /^Seed: 424242 \(from --seed\)$/m);
    assert.match(first.stdout, /\(roll 0\.\d\d (<|>=) 0\.50\)/);
    assert.match(first.stdout, /^Reproduce: node runner\/run\.mjs --dry-run --base main --seed 424242$/m);
    // --seed wins over the GitHub run id.
    const withRunId = await runner(repo.dir, args, { GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' });
    assert.equal(withRunId.stdout, first.stdout);
  });

  test('the seed comes from GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT when --seed is absent', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', { 'directives/a.json': directive('a') });
    const args = ['--dry-run', '--base', 'main'];
    const [withAttempt, noAttempt, random] = await Promise.all([
      runner(repo.dir, args, { GITHUB_RUN_ID: '555', GITHUB_RUN_ATTEMPT: '3' }),
      runner(repo.dir, args, { GITHUB_RUN_ID: '555' }),
      runner(repo.dir, args),
    ]);
    assert.ok(withAttempt.stdout.includes(`Seed: ${fnv1a('555:3')} (from GITHUB_RUN_ID=555, GITHUB_RUN_ATTEMPT=3)`));
    assert.ok(noAttempt.stdout.includes(`Seed: ${fnv1a('555:1')} (from GITHUB_RUN_ID=555, GITHUB_RUN_ATTEMPT=1)`));
    assert.match(random.stdout, /^Seed: \d+ \(random\)$/m);
    // The duration factor follows the seed, whatever its source.
    const factorLine = (/** @type {number} */ seed) =>
      `Duration factor: ${durationFactor(seed).toFixed(2)} (from the seed; scales every durationSec)`;
    assert.ok(withAttempt.stdout.includes(factorLine(fnv1a('555:3'))), withAttempt.stdout);
    assert.ok(noAttempt.stdout.includes(factorLine(fnv1a('555:1'))), noAttempt.stdout);
    const randomSeed = Number(/^Seed: (\d+) \(random\)$/m.exec(random.stdout)?.[1]);
    assert.ok(random.stdout.includes(factorLine(randomSeed)), random.stdout);
  });

  test('a non-dry run with --time-scale 0 appends the summary table', async () => {
    const repo = await makeRepo();
    await repo.commit('on main', { 'directives/landed.json': directive('landed') });
    await repo.branch('feature');
    await repo.commit('add', {
      'directives/a-pass.json': directive('a-pass', { title: 'Pipe | in title', durationSec: 20 }),
      'directives/b-fail.json': directive('b-fail', { outcome: 'fail', durationSec: 30 }),
    });
    writeFileSync(repo.summary, '# Existing content\n');
    // Seed 9 has a duration factor of 0.98.
    const { code, stdout } = await runner(repo.dir, ['--base', 'main', '--seed', '9', '--time-scale', '0'], {
      GITHUB_STEP_SUMMARY: repo.summary,
    });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^Merge-base: [0-9a-f]{40}$/m);
    assert.match(stdout, /^Duration factor: 0\.98 \(from the seed; scales every durationSec\)$/m);
    assert.match(stdout, /^::error title=Directive failed::b-fail failed at t=29\.4s$/m);
    const md = readFileSync(repo.summary, 'utf8');
    assert.ok(md.startsWith('# Existing content\n'), 'summary is appended, not overwritten');
    assert.match(md, /^## Sandbox CI: fail$/m);
    assert.match(md, /^b-fail failed at t=29\.4s \(run time 29\.4s\)\.$/m);
    assert.match(md, /^\| Directive \| Title \| Spec \| Result \| At \|$/m);
    // Spec keeps the declared durationSec; At is on the scaled timeline.
    assert.match(md, /^\| a-pass \| Pipe \\\| in title \| pass 20s \| passed \| 19\.6s \|$/m);
    assert.match(md, /^\| b-fail \| Directive b-fail \| fail 30s \| failed \| 29\.4s \|$/m);
    assert.match(md, /^- Seed: `9` \(from --seed\)$/m);
    assert.match(md, /^- Duration factor: `0\.98` \(from the seed; scales every durationSec\)$/m);
    assert.match(md, /^- Base: `main`, merge-base `[0-9a-f]{40}`$/m);
    assert.match(md, /^1 inert directives on main$/m);
  });

  test('a passing non-dry run with no active directives writes the note to the summary', async () => {
    const repo = await makeRepo();
    const { code, stdout } = await runner(repo.dir, ['--base', 'main', '--time-scale', '0'], {
      GITHUB_STEP_SUMMARY: repo.summary,
    });
    assert.equal(code, 0, stdout);
    const md = readFileSync(repo.summary, 'utf8');
    assert.match(md, /^## Sandbox CI: pass$/m);
    assert.match(md, /^No active directives - nothing to test$/m);
    assert.match(md, /^0 inert directives on main$/m);
  });

  test('a real (scaled) sleep logs heartbeats and passes', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', { 'directives/quick.json': directive('quick', { durationSec: 2 }) });
    // Seed 1 has a duration factor of 0.77, so the 2s directive takes 1.54s.
    const { code, stdout } = await runner(repo.dir, ['--base', 'main', '--seed', '1', '--time-scale', '0.01']);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^Simulating 1\.5s at time scale 0\.01 /m);
    assert.match(stdout, /^t=1\.5s of 1\.5s$/m);
    assert.match(stdout, /^Result: PASS at t=1\.5s$/m);
  });

  test('--max-seconds caps the sleep and says so', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', { 'directives/long.json': directive('long', { outcome: 'fail', durationSec: 30 }) });
    // Seed 1 has a duration factor of 0.77: the failure is due at 23.1s and the cap still applies.
    const args = ['--base', 'main', '--seed', '1', '--time-scale', '0', '--max-seconds', '5'];
    const { code, stdout } = await runner(repo.dir, args, { GITHUB_STEP_SUMMARY: repo.summary });
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^Simulating 5s at time scale 0 /m);
    assert.match(stdout, /^sleep capped at 5s; outcome unchanged \(--max-seconds 5; the outcome is due at t=23\.1s\)$/m);
    const md = readFileSync(repo.summary, 'utf8');
    assert.match(md, /sleep capped at 5s; outcome unchanged/);
    assert.match(md, /^\| long \| Directive long \| fail 30s \| failed \| 23\.1s \|$/m);
  });

  test('--max-seconds above the run time does not add a cap note', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', { 'directives/short.json': directive('short', { durationSec: 3 }) });
    const { code, stdout } = await runner(repo.dir, ['--base', 'main', '--time-scale', '0', '--max-seconds', '5']);
    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /capped/);
  });

  test('the dry-run shows the duration factor and scales every time except the Spec column', async () => {
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', {
      'directives/early-fail.json': directive('early-fail', { outcome: 'fail', durationSec: 15 }),
      'directives/quick.json': directive('quick', { durationSec: 10 }),
      'directives/slow.json': directive('slow', { durationSec: 20 }),
    });
    // Seed 7 has a duration factor of 0.76.
    const { code, stdout } = await runner(repo.dir, ['--dry-run', '--base', 'main', '--seed', '7']);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^Seed: 7 \(from --seed\)\nDuration factor: 0\.76 \(from the seed; scales every durationSec\)$/m);
    assert.match(rowFor(stdout, 'early-fail') ?? '', /fail 15s\s+failed\s+11\.4s$/);
    assert.match(rowFor(stdout, 'quick') ?? '', /pass 10s\s+passed\s+7\.6s$/);
    assert.match(rowFor(stdout, 'slow') ?? '', /pass 20s\s+not reached\s+-$/);
    assert.match(stdout, /^Result: FAIL - early-fail failed at t=11\.4s \(run time 15\.2s\)$/m);
    assert.match(stdout, /^Reproduce: node runner\/run\.mjs --dry-run --base main --seed 7$/m);
  });

  for (const [signal, exitCode] of /** @type {const} */ ([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])) {
    test(`${signal} during the sleep stops the run at once with exit code ${exitCode} and no summary`, async () => {
      const repo = await makeRepo();
      await repo.branch('feature');
      await repo.commit('add', { 'directives/slow.json': directive('slow', { durationSec: 300 }) });
      // Seed 1 has a duration factor of 0.77, so the run would sleep for 231s.
      const result = await signalDuringSleep(process.execPath, [RUN, '--base', 'main', '--seed', '1'], {
        cwd: repo.dir,
        env: { GITHUB_STEP_SUMMARY: repo.summary },
        signal,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, exitCode, output);
      assert.ok(result.msToExit < 2000, `exited ${result.msToExit}ms after ${signal}`);
      assert.match(
        result.stdout,
        new RegExp(`^Run cancelled \\(${signal}\\) at t=\\d+(\\.\\d)?s of 231s; exiting without a result\\.$`, 'm'),
      );
      assert.doesNotMatch(result.stdout, /^Result:/m);
      assert.doesNotMatch(result.stdout, /::error/);
      assert.equal(existsSync(repo.summary), false, 'no job summary is written');
    });
  }

  test('under the workflow shell, SIGINT sent only to the shell stops the runner because the step uses exec', async () => {
    // The Actions runner runs the step as `bash -e <script>` and signals only that process.
    assert.match(readFileSync(WORKFLOW, 'utf8'), /^ {6}- run: exec node runner\/run\.mjs /m);
    const repo = await makeRepo();
    await repo.branch('feature');
    await repo.commit('add', { 'directives/slow.json': directive('slow', { durationSec: 300 }) });
    const script = join(dirname(repo.dir), 'step.sh');
    writeFileSync(script, `exec "${process.execPath}" "${RUN}" --base main --seed 1\n`);
    const result = await signalDuringSleep('bash', ['-e', script], {
      cwd: repo.dir,
      env: { GITHUB_STEP_SUMMARY: repo.summary },
      signal: 'SIGINT',
    });
    assert.equal(result.code, 130, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.msToExit < 2000, `exited ${result.msToExit}ms after SIGINT`);
    assert.match(result.stdout, /^Run cancelled \(SIGINT\) at t=\d+(\.\d)?s of 231s; exiting without a result\.$/m);
    assert.equal(existsSync(repo.summary), false, 'no job summary is written');
  });

  test('a missing base ref exits non-zero with the fetch-depth hint', async () => {
    const repo = await makeRepo();
    const { code, stdout } = await runner(repo.dir, ['--dry-run', '--base', 'origin/does-not-exist']);
    assert.notEqual(code, 0);
    assert.equal(code, 1);
    assert.match(stdout, /^::error title=No merge-base::.*origin\/does-not-exist.*fetch-depth: 0/m);
  });

  test('outside a git repository it fails with an error', async () => {
    const dir = mkdtempSync(join(tmpRoot, 'not-a-repo-'));
    const { code, stdout } = await runner(dir, ['--dry-run'], { GIT_CEILING_DIRECTORIES: tmpRoot });
    assert.equal(code, 1);
    assert.match(stdout, /^::error title=Runner setup::Not inside a git repository/m);
  });

  test('an unknown argument exits 2', async () => {
    const repo = await makeRepo();
    const { code, stderr } = await runner(repo.dir, ['--bogus']);
    assert.equal(code, 2);
    assert.match(stderr, /bogus/);
    assert.match(stderr, /^Usage: node runner\/run\.mjs/m);
    const help = await runner(repo.dir, ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: node runner\/run\.mjs/m);
  });

  test('bad argument values exit 2', async () => {
    const repo = await makeRepo();
    const cases = [
      ['--seed', '-1'],
      ['--seed', '4294967296'],
      ['--seed', '1.5'],
      ['--seed', 'abc'],
      ['--time-scale', '-1'],
      ['--time-scale', 'fast'],
      ['--time-scale', ''],
      ['--max-seconds', 'Infinity'],
      ['--base', '--evil'],
      ['positional'],
    ];
    const results = await Promise.all(cases.map((args) => runner(repo.dir, ['--dry-run', ...args])));
    results.forEach((result, i) => {
      assert.equal(result.code, 2, `expected exit 2 for ${JSON.stringify(cases[i])}`);
    });
    assert.equal((await runner(repo.dir, ['--dry-run', '--base', 'main', '--seed', '4294967295'])).code, 0);
  });
});
