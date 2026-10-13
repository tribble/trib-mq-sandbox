import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  describeFailure,
  evaluate,
  fnv1a,
  formatSpec,
  mulberry32,
  NO_ACTIVE_NOTE,
  parseDirective,
  seedFromRun,
  validate,
} from './rules.mjs';

/** @typedef {import('./rules.mjs').Directive} Directive */

const repoFile = (/** @type {string} */ rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/**
 * A valid directive (already normalised, as validate() returns it).
 * @param {string} id
 * @param {Partial<Directive>} [over]
 * @returns {Directive}
 */
function d(id, over = {}) {
  return { id, title: `Directive ${id}`, durationSec: 10, outcome: 'pass', breaksWith: [], ...over };
}

/**
 * @param {Directive[]} active
 * @param {Array<Directive | [string, null]>} [inert]
 * @returns {Map<string, Directive | null>}
 */
function presentOf(active, inert = []) {
  /** @type {Map<string, Directive | null>} */
  const map = new Map();
  for (const x of [...active, ...inert]) {
    if (Array.isArray(x)) map.set(x[0], x[1]);
    else map.set(x.id, x);
  }
  return map;
}

/** An rng that must not be called. */
const noRng = () => {
  throw new Error('rng should not be called');
};

/**
 * An rng that returns the given values in order and counts calls.
 * @param {...number} values
 */
function seq(...values) {
  const rng = () => {
    if (rng.calls >= values.length) throw new Error('rng called too many times');
    return values[rng.calls++];
  };
  rng.calls = 0;
  return rng;
}

/**
 * @param {Directive[]} active
 * @param {Array<Directive | [string, null]>} [inert]
 * @param {() => number} [rng]
 */
function run(active, inert = [], rng = noRng) {
  return evaluate({ active, present: presentOf(active, inert), rng });
}

/** @param {ReturnType<typeof evaluate>} result */
function rowsById(result) {
  return Object.fromEntries(result.rows.map((r) => [r.id, r]));
}

describe('evaluate', () => {
  test('empty active set passes at t=0 with a note', () => {
    const result = run([], [d('old', { outcome: 'fail' })]);
    assert.deepEqual(result, {
      ok: true,
      endsAt: 0,
      runTime: 0,
      failure: null,
      rows: [],
      note: NO_ACTIVE_NOTE,
    });
    assert.equal(NO_ACTIVE_NOTE, 'No active directives - nothing to test');
  });

  test('runTime is the max duration and a passing run ends at runTime', () => {
    const result = run([d('a', { durationSec: 20 }), d('b', { durationSec: 45 }), d('c', { durationSec: 5 })]);
    assert.equal(result.ok, true);
    assert.equal(result.runTime, 45);
    assert.equal(result.endsAt, 45);
    assert.equal(result.failure, null);
    assert.equal(result.note, undefined);
    assert.deepEqual(
      result.rows.map((r) => [r.id, r.result, r.at, r.status]),
      [
        ['a', 'passed', 20, 'passed'],
        ['b', 'passed', 45, 'passed'],
        ['c', 'passed', 5, 'passed'],
      ],
    );
  });

  test('rows are sorted by id and carry title and spec', () => {
    const result = run([d('zz', { title: 'Last' }), d('aa', { title: 'First', durationSec: 3 })]);
    assert.deepEqual(
      result.rows.map((r) => [r.id, r.title, r.spec]),
      [
        ['aa', 'First', 'pass 3s'],
        ['zz', 'Last', 'pass 10s'],
      ],
    );
  });

  test('fail-fast: the earliest failure wins and later directives are not reached', () => {
    const result = run([
      d('late-fail', { outcome: 'fail', durationSec: 30 }),
      d('early-fail', { outcome: 'fail', durationSec: 15 }),
      d('quick', { durationSec: 10 }),
      d('slow', { durationSec: 40 }),
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.runTime, 40);
    assert.equal(result.endsAt, 15);
    assert.deepEqual(result.failure, { kind: 'fail', ids: ['early-fail'], with: [], at: 15 });
    const rows = rowsById(result);
    assert.deepEqual([rows['early-fail'].result, rows['early-fail'].at], ['failed', 15]);
    assert.deepEqual([rows.quick.result, rows.quick.at], ['passed', 10]);
    assert.deepEqual([rows['late-fail'].result, rows['late-fail'].at], ['not reached', null]);
    assert.deepEqual([rows.slow.result, rows.slow.at, rows.slow.status], ['not reached', null, 'not-reached']);
    assert.equal(describeFailure(result), 'early-fail failed at t=15s');
  });

  test('fail-fast: an exact time tie breaks by id and the loser is not reached', () => {
    const result = run([
      d('b', { outcome: 'fail', durationSec: 15 }),
      d('a', { outcome: 'fail', durationSec: 15 }),
      d('c', { durationSec: 15 }),
    ]);
    assert.deepEqual(result.failure, { kind: 'fail', ids: ['a'], with: [], at: 15 });
    const rows = rowsById(result);
    assert.equal(rows.a.result, 'failed');
    assert.equal(rows.b.result, 'not reached');
    assert.equal(rows.b.at, null);
    // A directive with no failure of its own that finishes exactly at endsAt passed.
    assert.deepEqual([rows.c.result, rows.c.at], ['passed', 15]);
  });

  test('fail-fast: at the same time and first id, kind order fail < flake < breaksWith decides', () => {
    // 'a' both fails and breaks with inert 'z' at 10s: the fail candidate wins.
    const result = run([d('a', { outcome: 'fail', durationSec: 10, breaksWith: ['z'] })], [d('z')]);
    assert.equal(result.failure?.kind, 'fail');
    assert.equal(rowsById(result).a.result, 'failed');
  });

  test('flake that rolls under its rate fails, and the roll is shown', () => {
    const rng = seq(0.12);
    const result = run([d('f', { outcome: 'flake', flakeRate: 0.3, durationSec: 45 })], [], rng);
    assert.equal(rng.calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.endsAt, 45);
    assert.deepEqual(result.failure, { kind: 'flake', ids: ['f'], with: [], at: 45 });
    const row = result.rows[0];
    assert.deepEqual(
      [row.result, row.at, row.roll, row.status, row.spec],
      ['flaked (roll 0.12 < 0.30)', 45, 0.12, 'flaked', 'flake 30% 45s'],
    );
    assert.equal(describeFailure(result), 'f flaked (roll 0.12 < 0.30) at t=45s');
  });

  test('flake that rolls at or above its rate passes, and the roll is shown', () => {
    const result = run([d('f', { outcome: 'flake', flakeRate: 0.3, durationSec: 45 })], [], seq(0.71));
    assert.equal(result.ok, true);
    assert.equal(result.endsAt, 45);
    assert.deepEqual([result.rows[0].result, result.rows[0].at], ['passed (roll 0.71 >= 0.30)', 45]);
    // Exactly at the rate counts as a pass (the rule is roll < flakeRate).
    const edge = run([d('f', { outcome: 'flake', flakeRate: 0.5 })], [], seq(0.5));
    assert.equal(edge.ok, true);
    assert.equal(edge.rows[0].result, 'passed (roll 0.50 >= 0.50)');
  });

  test('flake rolls are drawn once per flake, in id order, and never for pass or fail', () => {
    const rng = seq(0.1, 0.9);
    const result = run(
      [
        d('b-flake', { outcome: 'flake', flakeRate: 0.5, durationSec: 20 }),
        d('c-pass', { durationSec: 5 }),
        d('a-flake', { outcome: 'flake', flakeRate: 0.5, durationSec: 30 }),
        d('d-fail', { outcome: 'fail', durationSec: 50 }),
      ],
      [],
      rng,
    );
    assert.equal(rng.calls, 2);
    const rows = rowsById(result);
    assert.equal(rows['a-flake'].roll, 0.1);
    assert.equal(rows['b-flake'].roll, 0.9);
    assert.equal(rows['a-flake'].result, 'flaked (roll 0.10 < 0.50)');
    assert.equal(rows['b-flake'].result, 'passed (roll 0.90 >= 0.50)');
    assert.equal(rows['c-pass'].result, 'passed');
    assert.equal(rows['d-fail'].result, 'not reached');
    assert.equal(result.endsAt, 30);
  });

  test('a flake that is not reached shows no roll', () => {
    const result = run(
      [d('a', { outcome: 'fail', durationSec: 5 }), d('f', { outcome: 'flake', flakeRate: 0.3, durationSec: 9 })],
      [],
      seq(0.9),
    );
    assert.deepEqual([rowsById(result).f.result, rowsById(result).f.at], ['not reached', null]);
  });

  describe('breaksWith', () => {
    test('an active directive declaring an inert partner fails at its own duration', () => {
      const result = run([d('new', { durationSec: 25, breaksWith: ['old'] })], [d('old', { durationSec: 99 })]);
      assert.equal(result.ok, false);
      assert.deepEqual(result.failure, { kind: 'breaksWith', ids: ['new'], with: ['old'], at: 25 });
      assert.deepEqual([result.rows[0].result, result.rows[0].at, result.rows[0].status], ['broke with old', 25, 'broke']);
      assert.equal(describeFailure(result), 'new broke with old at t=25s');
    });

    test('an inert directive declaring an active partner fails too (symmetry)', () => {
      const result = run([d('new', { durationSec: 12 })], [d('old', { breaksWith: ['new'] })]);
      assert.equal(result.ok, false);
      assert.deepEqual(result.failure, { kind: 'breaksWith', ids: ['new'], with: ['old'], at: 12 });
      assert.equal(result.rows[0].result, 'broke with old');
    });

    test('both active fails at the max of both durations and each row names the other', () => {
      const result = run([
        d('p07', { durationSec: 20 }),
        d('p03', { durationSec: 35, breaksWith: ['p07'] }),
        d('p09', { durationSec: 30 }),
        d('p11', { durationSec: 50 }),
      ]);
      assert.equal(result.ok, false);
      assert.equal(result.endsAt, 35);
      assert.deepEqual(result.failure, { kind: 'breaksWith', ids: ['p03', 'p07'], with: ['p07', 'p03'], at: 35 });
      const rows = rowsById(result);
      assert.deepEqual([rows.p03.result, rows.p03.at], ['broke with p07', 35]);
      assert.deepEqual([rows.p07.result, rows.p07.at], ['broke with p03', 35]);
      assert.deepEqual([rows.p09.result, rows.p09.at], ['passed', 30]);
      assert.deepEqual([rows.p11.result, rows.p11.at], ['not reached', null]);
      assert.equal(describeFailure(result), 'p03 broke with p07; p07 broke with p03 at t=35s');
    });

    test('a pair declared by both sides is counted once', () => {
      const result = run([d('a', { breaksWith: ['b'] }), d('b', { breaksWith: ['a'] })]);
      assert.deepEqual(result.failure, { kind: 'breaksWith', ids: ['a', 'b'], with: ['b', 'a'], at: 10 });
      assert.deepEqual(
        result.rows.map((r) => r.result),
        ['broke with b', 'broke with a'],
      );
    });

    test('BOTH INERT must not fail', () => {
      const result = run([d('fresh', { durationSec: 7 })], [d('x', { breaksWith: ['y'] }), d('y', { breaksWith: ['x'] })]);
      assert.equal(result.ok, true);
      assert.equal(result.failure, null);
      assert.equal(result.endsAt, 7);
      assert.equal(result.rows[0].result, 'passed');
    });

    test('a partner absent from the tree never fails', () => {
      const result = run([d('new', { breaksWith: ['ghost'] })], [d('other')]);
      assert.equal(result.ok, true);
      assert.equal(result.rows[0].result, 'passed');
    });

    test('a malformed (null) present partner still counts as present', () => {
      const result = run([d('new', { durationSec: 8, breaksWith: ['broken'] })], [['broken', null]]);
      assert.equal(result.ok, false);
      assert.deepEqual(result.failure, { kind: 'breaksWith', ids: ['new'], with: ['broken'], at: 8 });
      assert.equal(result.rows[0].result, 'broke with broken');
    });

    test('a malformed (null) present directive declares nothing', () => {
      // 'broken' cannot declare a pair because it has no parsed content.
      const result = run([d('new')], [['broken', null]]);
      assert.equal(result.ok, true);
    });

    test('an earlier failure beats a breaksWith pair, whose members are then not reached', () => {
      const result = run([
        d('a', { durationSec: 20, breaksWith: ['b'] }),
        d('b', { durationSec: 25 }),
        d('c', { outcome: 'fail', durationSec: 22 }),
      ]);
      assert.deepEqual(result.failure, { kind: 'fail', ids: ['c'], with: [], at: 22 });
      const rows = rowsById(result);
      // 'a' finished its own work at 20s; the pair would only break at 25s.
      assert.deepEqual([rows.a.result, rows.b.result, rows.c.result], ['passed', 'not reached', 'failed']);
    });

    test('a breaksWith candidate that loses a tie is not reached', () => {
      const result = run([
        d('b', { durationSec: 10, breaksWith: ['old'] }),
        d('a', { outcome: 'fail', durationSec: 10 }),
      ], [d('old')]);
      assert.deepEqual(result.failure, { kind: 'fail', ids: ['a'], with: [], at: 10 });
      assert.equal(rowsById(result).b.result, 'not reached');
    });

    test('active directives missing from present are still treated as present', () => {
      const result = evaluate({
        active: [d('a', { breaksWith: ['b'] }), d('b')],
        present: new Map(),
        rng: noRng,
      });
      assert.equal(result.failure?.kind, 'breaksWith');
    });
  });

  test('not-reached rows: everything after the failure time, with a blank time', () => {
    const result = run([
      d('a', { durationSec: 5 }),
      d('b', { outcome: 'fail', durationSec: 6 }),
      d('c', { durationSec: 7 }),
      d('e', { outcome: 'flake', flakeRate: 1, durationSec: 8 }),
    ], [], seq(0.5));
    assert.deepEqual(
      result.rows.map((r) => [r.id, r.result, r.at]),
      [
        ['a', 'passed', 5],
        ['b', 'failed', 6],
        ['c', 'not reached', null],
        ['e', 'not reached', null],
      ],
    );
  });
});

describe('formatSpec', () => {
  test('pass, fail and flake with optional breaksWith and conflictKey', () => {
    assert.equal(formatSpec(d('a', { durationSec: 20 })), 'pass 20s');
    assert.equal(formatSpec(d('a', { outcome: 'fail', durationSec: 15 })), 'fail 15s');
    assert.equal(formatSpec(d('a', { outcome: 'flake', flakeRate: 0.3, durationSec: 45 })), 'flake 30% 45s');
    assert.equal(formatSpec(d('a', { outcome: 'flake', flakeRate: 0.125, durationSec: 1 })), 'flake 12.5% 1s');
    assert.equal(
      formatSpec(d('a', { breaksWith: ['p03', 'p07'], conflictKey: 'cfg' })),
      'pass 10s breaksWith p03,p07 conflict cfg',
    );
  });
});

describe('validate', () => {
  const base = { id: 'good', title: 'A good directive', durationSec: 30, outcome: 'pass' };

  /**
   * @param {Record<string, unknown>} over
   * @param {string[]} [drop]
   */
  function check(over, drop = []) {
    /** @type {Record<string, unknown>} */
    const value = { ...base, ...over };
    for (const key of drop) delete value[key];
    return validate(value, 'good');
  }

  /**
   * Assert exactly one error matching `pattern` and a null directive.
   * @param {ReturnType<typeof validate>} result
   * @param {RegExp} pattern
   */
  function oneError(result, pattern) {
    assert.equal(result.directive, null);
    assert.equal(result.errors.length, 1, `expected one error, got ${JSON.stringify(result.errors)}`);
    assert.match(result.errors[0], pattern);
  }

  test('a valid directive has no errors or warnings and is normalised', () => {
    const result = check({});
    assert.deepEqual(result, {
      directive: { id: 'good', title: 'A good directive', durationSec: 30, outcome: 'pass', breaksWith: [] },
      errors: [],
      warnings: [],
    });
  });

  test('a valid directive with every optional field', () => {
    const result = check({ outcome: 'flake', flakeRate: 1, breaksWith: ['a', 'b-2'], conflictKey: 'cfg-1' });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.directive, {
      id: 'good',
      title: 'A good directive',
      durationSec: 30,
      outcome: 'flake',
      flakeRate: 1,
      breaksWith: ['a', 'b-2'],
      conflictKey: 'cfg-1',
    });
  });

  test('top-level value must be an object', () => {
    oneError(validate([], 'good'), /must be a JSON object \(got array\)/);
    oneError(validate(null, 'good'), /must be a JSON object \(got null\)/);
    oneError(validate('x', 'good'), /must be a JSON object \(got string\)/);
    oneError(validate(3, 'good'), /must be a JSON object \(got number\)/);
  });

  test('invalid JSON is an error', () => {
    const result = parseDirective('{"id": "good",', 'good');
    oneError(result, /^invalid JSON: /);
    assert.deepEqual(result.warnings, []);
  });

  test('parseDirective parses valid JSON (with or without a BOM)', () => {
    assert.deepEqual(parseDirective(JSON.stringify(base), 'good').errors, []);
    assert.deepEqual(parseDirective(`﻿${JSON.stringify(base)}`, 'good').errors, []);
  });

  test('id: missing, invalid, and not equal to the filename stem', () => {
    oneError(check({}, ['id']), /^id is required$/);
    oneError(check({ id: 'Bad_Id' }), /^id must be a string matching/);
    oneError(check({ id: '-leading' }), /^id must be a string matching/);
    oneError(check({ id: 'a'.repeat(33) }), /^id must be a string matching/);
    oneError(check({ id: 42 }), /^id must be a string matching .* \(got 42\)$/);
    oneError(check({ id: 'other' }), /^id "other" must equal the filename stem "good"$/);
  });

  test('id: 32 characters is allowed', () => {
    const id = `a${'-'.repeat(31)}`;
    assert.deepEqual(validate({ ...base, id }, id).errors, []);
  });

  test('title: missing, non-string, empty and too long', () => {
    oneError(check({}, ['title']), /^title is required$/);
    oneError(check({ title: 5 }), /^title must be a string \(got number\)$/);
    oneError(check({ title: '' }), /^title must be 1-120 characters long \(got 0\)$/);
    oneError(check({ title: 'x'.repeat(121) }), /^title must be 1-120 characters long \(got 121\)$/);
    assert.deepEqual(check({ title: 'x'.repeat(120) }).errors, []);
  });

  test('durationSec: missing, non-integer, 0 and 601', () => {
    oneError(check({}, ['durationSec']), /^durationSec is required$/);
    oneError(check({ durationSec: 1.5 }), /^durationSec must be an integer from 1 to 600 \(got 1\.5\)$/);
    oneError(check({ durationSec: '30' }), /^durationSec must be an integer from 1 to 600/);
    oneError(check({ durationSec: 0 }), /^durationSec must be an integer from 1 to 600 \(got 0\)$/);
    oneError(check({ durationSec: 601 }), /^durationSec must be an integer from 1 to 600 \(got 601\)$/);
    assert.deepEqual(check({ durationSec: 1 }).errors, []);
    assert.deepEqual(check({ durationSec: 600 }).errors, []);
  });

  test('outcome: missing and invalid', () => {
    oneError(check({}, ['outcome']), /^outcome is required$/);
    oneError(check({ outcome: 'maybe' }), /^outcome must be one of pass, fail, flake \(got "maybe"\)$/);
  });

  test('flakeRate: required for flake, must be in (0, 1]', () => {
    oneError(check({ outcome: 'flake' }), /^flakeRate is required when outcome is flake$/);
    oneError(check({ outcome: 'flake', flakeRate: 0 }), /^flakeRate must be a number greater than 0 and at most 1 \(got 0\)$/);
    oneError(check({ outcome: 'flake', flakeRate: 1.01 }), /^flakeRate must be a number greater than 0 and at most 1/);
    oneError(check({ outcome: 'flake', flakeRate: '0.5' }), /^flakeRate must be a number/);
  });

  test('flakeRate with another outcome is a warning, not an error', () => {
    const result = check({ outcome: 'pass', flakeRate: 0.5 });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^flakeRate is ignored because outcome is "pass"/);
    assert.notEqual(result.directive, null);
    assert.equal(result.directive?.flakeRate, undefined);
  });

  test('breaksWith: not an array, too many, self, bad id, duplicate', () => {
    oneError(check({ breaksWith: 'other' }), /^breaksWith must be an array of directive ids \(got string\)$/);
    const eleven = Array.from({ length: 11 }, (_, i) => `p${i}`);
    oneError(check({ breaksWith: eleven }), /^breaksWith may list at most 10 ids \(got 11\)$/);
    oneError(check({ breaksWith: ['a', 'good'] }), /^breaksWith\[1\] must not reference the directive itself \("good"\)$/);
    oneError(check({ breaksWith: ['Not-An-Id'] }), /^breaksWith\[0\] must be a directive id matching/);
    oneError(check({ breaksWith: [7] }), /^breaksWith\[0\] must be a directive id matching .* \(got 7\)$/);
    oneError(check({ breaksWith: ['a', 'b', 'a'] }), /^breaksWith\[2\] duplicates "a"$/);
    assert.deepEqual(check({ breaksWith: Array.from({ length: 10 }, (_, i) => `p${i}`) }).errors, []);
    assert.deepEqual(check({ breaksWith: [] }).directive?.breaksWith, []);
  });

  test('conflictKey: must match the pattern', () => {
    oneError(check({ conflictKey: 'Bad Key' }), /^conflictKey must be a string matching/);
    oneError(check({ conflictKey: '' }), /^conflictKey must be a string matching/);
    oneError(check({ conflictKey: 'k'.repeat(33) }), /^conflictKey must be a string matching/);
    oneError(check({ conflictKey: 3 }), /^conflictKey must be a string matching/);
    assert.deepEqual(check({ conflictKey: '-ok-' }).errors, []);
  });

  test('an unknown key is a warning, not an error', () => {
    const result = check({ colour: 'blue' });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^unknown key "colour" is ignored/);
    assert.notEqual(result.directive, null);
  });

  test('several errors are all reported', () => {
    const result = validate({ id: 'x', durationSec: 0, outcome: 'nope' }, 'y');
    assert.equal(result.directive, null);
    assert.equal(result.errors.length, 4);
  });
});

describe('seeded randomness', () => {
  test('fnv1a known vectors', () => {
    assert.equal(fnv1a(''), 0x811c9dc5);
    assert.equal(fnv1a('a'), 0xe40c292c);
    assert.equal(fnv1a('foobar'), 0xbf9cf968);
    // Hashes UTF-8 bytes, not UTF-16 code units: "é" is the two bytes 0xC3 0xA9.
    const overBytes = (/** @type {number[]} */ bytes) => {
      let h = 0x811c9dc5;
      for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
      return h >>> 0;
    };
    assert.equal(fnv1a('é'), overBytes([0xc3, 0xa9]));
    assert.notEqual(fnv1a('é'), overBytes([0xe9]));
  });

  test('mulberry32 is deterministic for a seed and stays in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    const zs = Array.from({ length: 1000 }, () => c());
    assert.deepEqual(xs, ys);
    assert.notDeepEqual(xs, zs);
    for (const x of [...xs, ...zs]) assert.ok(x >= 0 && x < 1, `${x} out of range`);
    for (const seed of [0, 4294967295]) {
      const r = mulberry32(seed)();
      assert.ok(r >= 0 && r < 1);
    }
  });

  test('seedFromRun hashes "runId:attempt"', () => {
    assert.equal(seedFromRun('123', '1'), fnv1a('123:1'));
    assert.equal(seedFromRun(123, 1), fnv1a('123:1'));
  });

  test('same run id and attempt give the same rolls; a different attempt gives different rolls', () => {
    const flakes = Array.from({ length: 8 }, (_, i) =>
      d(`f${i}`, { outcome: 'flake', flakeRate: 0.5, durationSec: 10 + i }),
    );
    const rollsFor = (/** @type {string} */ runId, /** @type {string} */ attempt) =>
      run(flakes, [], mulberry32(seedFromRun(runId, attempt))).rows.map((r) => r.roll);
    assert.deepEqual(rollsFor('9876543210', '1'), rollsFor('9876543210', '1'));
    assert.notDeepEqual(rollsFor('9876543210', '1'), rollsFor('9876543210', '2'));
    assert.notDeepEqual(rollsFor('9876543210', '1'), rollsFor('9876543211', '1'));
  });
});

describe('repository files', () => {
  test('every example validates with zero errors and zero warnings', () => {
    const dir = repoFile('examples/');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    assert.deepEqual(files, ['breaks-with.json', 'conflict.json', 'fail.json', 'flake.json', 'pass.json']);
    /** @type {Record<string, Directive>} */
    const byId = {};
    for (const file of files) {
      const stem = file.slice(0, -'.json'.length);
      const result = parseDirective(readFileSync(`${dir}${file}`, 'utf8'), stem);
      assert.deepEqual(result.errors, [], file);
      assert.deepEqual(result.warnings, [], file);
      assert.ok(result.directive, file);
      byId[stem] = result.directive;
    }
    assert.equal(byId.pass.outcome, 'pass');
    assert.equal(byId.fail.outcome, 'fail');
    assert.equal(byId.flake.outcome, 'flake');
    assert.deepEqual(byId['breaks-with'].breaksWith, ['pass']);
    assert.equal(typeof byId.conflict.conflictKey, 'string');
  });

  test('the directive schema is valid JSON describing the same fields', () => {
    const schema = JSON.parse(readFileSync(repoFile('schema/directive.schema.json'), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      'breaksWith',
      'conflictKey',
      'durationSec',
      'flakeRate',
      'id',
      'outcome',
      'title',
    ]);
    assert.deepEqual(schema.required, ['id', 'title', 'durationSec', 'outcome']);
  });

  test('the ruleset is valid JSON with the expected rules and the single App bypass', () => {
    const ruleset = JSON.parse(readFileSync(repoFile('.github/ruleset-main.json'), 'utf8'));
    assert.equal(ruleset.target, 'branch');
    assert.equal(ruleset.enforcement, 'active');
    assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
    assert.deepEqual(
      ruleset.rules.map((/** @type {{ type: string }} */ r) => r.type),
      ['update', 'deletion', 'non_fast_forward'],
    );
    assert.deepEqual(ruleset.bypass_actors, [
      { actor_id: 5295072, actor_type: 'Integration', bypass_mode: 'always' },
    ]);
    assert.deepEqual(ruleset, {
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
        { type: 'deletion' },
        { type: 'non_fast_forward' },
      ],
      bypass_actors: [{ actor_id: 5295072, actor_type: 'Integration', bypass_mode: 'always' }],
    });
  });
});
