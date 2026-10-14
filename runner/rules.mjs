// Pure rules for the sandbox CI runner: directive validation, evaluation and seeded randomness.
// No I/O, no environment access. run.mjs is the I/O shell around this module.

/**
 * @typedef {'pass' | 'fail' | 'flake'} Outcome
 *
 * @typedef {object} Directive
 * @property {string} id
 * @property {string} title
 * @property {number} durationSec
 * @property {Outcome} outcome
 * @property {number} [flakeRate]   only set when outcome is 'flake'
 * @property {string[]} breaksWith
 * @property {string} [conflictKey]
 *
 * @typedef {object} Validation
 * @property {Directive | null} directive   non-null iff errors is empty
 * @property {string[]} errors
 * @property {string[]} warnings
 *
 * @typedef {'fail' | 'flake' | 'breaksWith'} FailureKind
 *
 * @typedef {object} Failure
 * @property {FailureKind} kind
 * @property {string[]} ids    active directives that fail (sorted)
 * @property {string[]} with   for breaksWith: with[i] is the partner of ids[i]; otherwise []
 * @property {number} at       virtual second of the failure
 *
 * @typedef {'passed' | 'failed' | 'flaked' | 'broke' | 'not-reached'} RowStatus
 *
 * @typedef {object} Row
 * @property {string} id
 * @property {string} title
 * @property {string} spec
 * @property {string} result
 * @property {RowStatus} status
 * @property {number | null} at   virtual second the row finished; null when not reached
 * @property {number} [roll]      the flake roll, for flake directives
 *
 * @typedef {object} Evaluation
 * @property {boolean} ok
 * @property {number} endsAt    virtual second the run ends (the failure, or runTime)
 * @property {number} runTime   max durationSec of the active directives (times the duration factor,
 *                              once applyDurationFactor has scaled the evaluation)
 * @property {Failure | null} failure
 * @property {Row[]} rows       one per active directive, sorted by id
 * @property {string} [note]
 */

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CONFLICT_KEY_PATTERN = /^[a-z0-9-]{1,32}$/;
export const OUTCOMES = /** @type {const} */ (['pass', 'fail', 'flake']);
export const KNOWN_KEYS = /** @type {const} */ ([
  'id',
  'title',
  'durationSec',
  'outcome',
  'flakeRate',
  'breaksWith',
  'conflictKey',
]);
export const MAX_TITLE = 120;
export const MIN_DURATION = 1;
export const MAX_DURATION = 600;
export const MAX_BREAKS_WITH = 10;
export const NO_ACTIVE_NOTE = 'No active directives - nothing to test';

/** @type {Record<FailureKind, number>} */
const KIND_ORDER = { fail: 0, flake: 1, breaksWith: 2 };

/**
 * Locale-independent string comparison.
 * @param {string} a
 * @param {string} b
 */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Short JSON rendering of a value for error messages.
 * @param {unknown} value
 */
function show(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

/** @param {unknown} value */
function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate an already-parsed JSON value as the directive stored in `directives/<fileStem>.json`.
 * @param {unknown} value
 * @param {string} fileStem
 * @returns {Validation}
 */
export function validate(value, fileStem) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (typeName(value) !== 'object') {
    errors.push(`directive must be a JSON object (got ${typeName(value)})`);
    return { directive: null, errors, warnings };
  }
  const obj = /** @type {Record<string, unknown>} */ (value);
  const has = (/** @type {string} */ key) => Object.prototype.hasOwnProperty.call(obj, key);

  // id
  if (!has('id')) {
    errors.push('id is required');
  } else if (typeof obj.id !== 'string' || !ID_PATTERN.test(obj.id)) {
    errors.push(`id must be a string matching ${ID_PATTERN.source} (got ${show(obj.id)})`);
  } else if (obj.id !== fileStem) {
    errors.push(`id "${obj.id}" must equal the filename stem "${fileStem}"`);
  }

  // title
  if (!has('title')) {
    errors.push('title is required');
  } else if (typeof obj.title !== 'string') {
    errors.push(`title must be a string (got ${typeName(obj.title)})`);
  } else {
    const length = [...obj.title].length;
    if (length < 1 || length > MAX_TITLE) {
      errors.push(`title must be 1-${MAX_TITLE} characters long (got ${length})`);
    }
  }

  // durationSec
  if (!has('durationSec')) {
    errors.push('durationSec is required');
  } else if (
    typeof obj.durationSec !== 'number' ||
    !Number.isInteger(obj.durationSec) ||
    obj.durationSec < MIN_DURATION ||
    obj.durationSec > MAX_DURATION
  ) {
    errors.push(
      `durationSec must be an integer from ${MIN_DURATION} to ${MAX_DURATION} (got ${show(obj.durationSec)})`,
    );
  }

  // outcome
  /** @type {Outcome | undefined} */
  let outcome;
  if (!has('outcome')) {
    errors.push('outcome is required');
  } else if (typeof obj.outcome !== 'string' || !OUTCOMES.includes(/** @type {any} */ (obj.outcome))) {
    errors.push(`outcome must be one of ${OUTCOMES.join(', ')} (got ${show(obj.outcome)})`);
  } else {
    outcome = /** @type {Outcome} */ (obj.outcome);
  }

  // flakeRate
  if (has('flakeRate')) {
    const rate = obj.flakeRate;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
      errors.push(`flakeRate must be a number greater than 0 and at most 1 (got ${show(rate)})`);
    }
    if (outcome !== undefined && outcome !== 'flake') {
      warnings.push(`flakeRate is ignored because outcome is "${outcome}" (it only applies to flake)`);
    }
  } else if (outcome === 'flake') {
    errors.push('flakeRate is required when outcome is flake');
  }

  // breaksWith
  /** @type {string[]} */
  const breaksWith = [];
  if (has('breaksWith')) {
    const list = obj.breaksWith;
    if (!Array.isArray(list)) {
      errors.push(`breaksWith must be an array of directive ids (got ${typeName(list)})`);
    } else {
      if (list.length > MAX_BREAKS_WITH) {
        errors.push(`breaksWith may list at most ${MAX_BREAKS_WITH} ids (got ${list.length})`);
      }
      const self = typeof obj.id === 'string' ? obj.id : fileStem;
      list.forEach((entry, i) => {
        if (typeof entry !== 'string' || !ID_PATTERN.test(entry)) {
          errors.push(`breaksWith[${i}] must be a directive id matching ${ID_PATTERN.source} (got ${show(entry)})`);
        } else if (entry === self) {
          errors.push(`breaksWith[${i}] must not reference the directive itself ("${entry}")`);
        } else if (breaksWith.includes(entry)) {
          errors.push(`breaksWith[${i}] duplicates "${entry}"`);
        } else {
          breaksWith.push(entry);
        }
      });
    }
  }

  // conflictKey
  if (has('conflictKey')) {
    if (typeof obj.conflictKey !== 'string' || !CONFLICT_KEY_PATTERN.test(obj.conflictKey)) {
      errors.push(
        `conflictKey must be a string matching ${CONFLICT_KEY_PATTERN.source} (got ${show(obj.conflictKey)})`,
      );
    }
  }

  // unknown keys
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.includes(/** @type {any} */ (key))) {
      warnings.push(`unknown key "${key}" is ignored (known keys: ${KNOWN_KEYS.join(', ')})`);
    }
  }

  if (errors.length > 0) return { directive: null, errors, warnings };

  /** @type {Directive} */
  const directive = {
    id: /** @type {string} */ (obj.id),
    title: /** @type {string} */ (obj.title),
    durationSec: /** @type {number} */ (obj.durationSec),
    outcome: /** @type {Outcome} */ (outcome),
    breaksWith,
  };
  if (outcome === 'flake') directive.flakeRate = /** @type {number} */ (obj.flakeRate);
  if (has('conflictKey')) directive.conflictKey = /** @type {string} */ (obj.conflictKey);
  return { directive, errors, warnings };
}

/**
 * Parse JSON text, then validate it.
 * @param {string} text
 * @param {string} fileStem
 * @returns {Validation}
 */
export function parseDirective(text, fileStem) {
  let value;
  try {
    value = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { directive: null, errors: [`invalid JSON: ${reason}`], warnings: [] };
  }
  return validate(value, fileStem);
}

/**
 * 32-bit FNV-1a hash over the UTF-8 bytes of `str`.
 * @param {string} str
 * @returns {number} uint32
 */
export function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(str)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * mulberry32 PRNG.
 * @param {number} seed uint32
 * @returns {() => number} returns floats in [0, 1)
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed for a GitHub Actions run: same run id and attempt give the same rolls.
 * @param {string | number} runId
 * @param {string | number} runAttempt
 * @returns {number} uint32
 */
export function seedFromRun(runId, runAttempt) {
  return fnv1a(`${runId}:${runAttempt}`);
}

// The duration factor is a whole number of hundredths, so the printed factor is exactly the one used.
const FACTOR_MIN_HUNDREDTHS = 50;
const FACTOR_MAX_HUNDREDTHS = 100;

/**
 * The run's duration factor: every directive takes durationSec x factor. It is uniform over
 * 0.50, 0.51, ..., 1.00 and comes from the same seed as the flake rolls, but from a separate
 * generator, so the flake rolls are the same as they would be without it.
 * @param {number} seed uint32
 * @returns {number}
 */
export function durationFactor(seed) {
  const draw = mulberry32(fnv1a(`duration-factor:${seed}`))();
  const choices = FACTOR_MAX_HUNDREDTHS - FACTOR_MIN_HUNDREDTHS + 1;
  return (FACTOR_MIN_HUNDREDTHS + Math.floor(draw * choices)) / 100;
}

/**
 * A time on the scaled timeline. Whole seconds times a two-decimal factor has at most two decimals,
 * so rounding to hundredths only removes floating-point noise.
 * @param {number} seconds
 * @param {number} factor
 */
export function scaleSeconds(seconds, factor) {
  return Math.round(seconds * factor * 100) / 100;
}

/**
 * The evaluation with every time multiplied by the duration factor. One factor keeps all times in
 * the same order, so the outcome, the failure and its tie-breaks are exactly those of `evaluation`.
 * @param {Evaluation} evaluation
 * @param {number} factor
 * @returns {Evaluation}
 */
export function applyDurationFactor(evaluation, factor) {
  const scale = (/** @type {number} */ seconds) => scaleSeconds(seconds, factor);
  return {
    ...evaluation,
    endsAt: scale(evaluation.endsAt),
    runTime: scale(evaluation.runTime),
    failure: evaluation.failure && { ...evaluation.failure, at: scale(evaluation.failure.at) },
    rows: evaluation.rows.map((row) => ({ ...row, at: row.at === null ? null : scale(row.at) })),
  };
}

/**
 * Seconds for display, with at most one decimal: 45 -> "45s", 22.5 -> "22.5s".
 * @param {number} seconds
 */
export function formatSeconds(seconds) {
  return `${Number(seconds.toFixed(1))}s`;
}

/**
 * Human-readable rate: 0.3 -> "30%".
 * @param {number} rate
 */
function percent(rate) {
  return `${Number((rate * 100).toPrecision(12))}%`;
}

/**
 * Compact description of a directive, e.g. "flake 30% 45s breaksWith p03,p07 conflict cfg".
 * @param {Directive} d
 */
export function formatSpec(d) {
  let spec =
    d.outcome === 'flake'
      ? `flake ${percent(/** @type {number} */ (d.flakeRate))} ${d.durationSec}s`
      : `${d.outcome} ${d.durationSec}s`;
  if (d.breaksWith.length > 0) spec += ` breaksWith ${d.breaksWith.join(',')}`;
  if (d.conflictKey !== undefined) spec += ` conflict ${d.conflictKey}`;
  return spec;
}

/**
 * Decide the outcome of a run.
 *
 * `present` holds every directive file in the tree, keyed by filename stem, including the active
 * ones; the value is null when the file is malformed. Active directives are treated as present
 * even if the caller left them out. `rng` is called exactly once per active flake, in id order.
 *
 * @param {{ active: Directive[], present: Map<string, Directive | null>, rng: () => number }} input
 * @returns {Evaluation}
 */
export function evaluate({ active, present, rng }) {
  if (active.length === 0) {
    return { ok: true, endsAt: 0, runTime: 0, failure: null, rows: [], note: NO_ACTIVE_NOTE };
  }

  const sorted = [...active].sort((a, b) => cmp(a.id, b.id));
  const activeById = new Map(sorted.map((d) => [d.id, d]));
  const runTime = Math.max(...sorted.map((d) => d.durationSec));

  /** @type {Failure[]} */
  const candidates = [];
  /** @type {Map<string, number>} */
  const rolls = new Map();

  for (const d of sorted) {
    if (d.outcome === 'fail') {
      candidates.push({ kind: 'fail', ids: [d.id], with: [], at: d.durationSec });
    } else if (d.outcome === 'flake') {
      const roll = rng();
      rolls.set(d.id, roll);
      if (roll < /** @type {number} */ (d.flakeRate)) {
        candidates.push({ kind: 'flake', ids: [d.id], with: [], at: d.durationSec });
      }
    }
  }

  /** @type {Map<string, Directive | null>} */
  const all = new Map(present);
  for (const d of sorted) if (!all.has(d.id)) all.set(d.id, d);

  // Unordered breaksWith pairs declared by any parseable directive in the tree.
  /** @type {Map<string, [string, string]>} */
  const pairs = new Map();
  for (const d of all.values()) {
    if (!d) continue;
    for (const other of d.breaksWith) {
      if (other === d.id) continue;
      const pair = /** @type {[string, string]} */ ([d.id, other].sort(cmp));
      pairs.set(pair.join(' '), pair);
    }
  }
  for (const key of [...pairs.keys()].sort(cmp)) {
    const [a, b] = /** @type {[string, string]} */ (pairs.get(key));
    if (!all.has(a) || !all.has(b)) continue;
    const ids = [a, b].filter((id) => activeById.has(id));
    if (ids.length === 0) continue;
    const partners = ids.map((id) => (id === a ? b : a));
    const at = Math.max(...ids.map((id) => /** @type {Directive} */ (activeById.get(id)).durationSec));
    candidates.push({ kind: 'breaksWith', ids, with: partners, at });
  }

  candidates.sort(
    (x, y) =>
      x.at - y.at ||
      cmp(x.ids[0], y.ids[0]) ||
      KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
      cmp(x.ids.join(','), y.ids.join(',')) ||
      cmp(x.with.join(','), y.with.join(',')),
  );
  const failure = candidates.length > 0 ? candidates[0] : null;
  const endsAt = failure ? failure.at : runTime;

  // Directives whose own failure was due by endsAt but lost the tie-break are not reached.
  /** @type {Set<string>} */
  const losers = new Set();
  for (const c of candidates) {
    if (c !== failure && c.at <= endsAt) for (const id of c.ids) losers.add(id);
  }

  const rows = sorted.map((d) => {
    const roll = rolls.get(d.id);
    const rate = /** @type {number} */ (d.flakeRate);
    const rollText =
      roll === undefined ? '' : ` (roll ${roll.toFixed(2)} ${roll < rate ? '<' : '>='} ${rate.toFixed(2)})`;
    /** @type {Row} */
    const row = { id: d.id, title: d.title, spec: formatSpec(d), result: '', status: 'not-reached', at: null };
    if (roll !== undefined) row.roll = roll;

    const index = failure ? failure.ids.indexOf(d.id) : -1;
    if (failure && index >= 0) {
      row.at = failure.at;
      if (failure.kind === 'fail') {
        row.status = 'failed';
        row.result = 'failed';
      } else if (failure.kind === 'flake') {
        row.status = 'flaked';
        row.result = `flaked${rollText}`;
      } else {
        row.status = 'broke';
        row.result = `broke with ${failure.with[index]}`;
      }
    } else if (!losers.has(d.id) && d.durationSec <= endsAt) {
      row.status = 'passed';
      row.result = `passed${rollText}`;
      row.at = d.durationSec;
    } else {
      row.result = 'not reached';
    }
    return row;
  });

  return { ok: failure === null, endsAt, runTime, failure, rows };
}

/**
 * One-line description of the failure, e.g. "fail failed at t=15s".
 * @param {Evaluation} evaluation
 * @returns {string | null} null when the run passed
 */
export function describeFailure(evaluation) {
  const { failure, rows } = evaluation;
  if (!failure) return null;
  const parts = failure.ids.map((id) => {
    const row = rows.find((r) => r.id === id);
    return `${id} ${row ? row.result : failure.kind}`;
  });
  return `${parts.join('; ')} at t=${formatSeconds(failure.at)}`;
}
