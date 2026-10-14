# trib-mq-sandbox

Sandbox CI for a merge-queue demo. **trib-mq** is the merge queue that uses this repo.

No real code is tested here. Each PR adds a behaviour **directive**, a small JSON file in
`directives/`. A tiny CI runner reads the directives the change adds, then passes, fails or flakes
after a simulated duration. That gives the queue realistic CI to work against: slow runs, failures,
flakes, pairs of changes that only break together, and merge conflicts.

The runner is plain Node (ES modules with JSDoc types). There is no `package.json`, no
dependencies and no install step, and it makes no network or GitHub API calls. It runs on the stock
Node of GitHub's `ubuntu-latest` (Node 20 or newer).

## Layout

```
.github/workflows/ci.yml       the only workflow
.github/ruleset-main.json      ruleset for main, as code (applied once by hand, see the runbook)
runner/rules.mjs               pure rules: validate(), evaluate(), seeded rng; no I/O
runner/run.mjs                 CLI: git plumbing, sleeping, logs, annotations, job summary, exit code
runner/rules.test.mjs          unit tests for rules.mjs (node:test)
runner/run.test.mjs            integration tests: temp git repos + the real run.mjs
schema/directive.schema.json   JSON Schema for directives (documentation only)
examples/*.json                sample directives; inert because they live outside directives/
directives/                    one <id>.json per directive
conflicts/                     conflicts/<key>.txt files that PRs edit to cause merge conflicts
```

## Directives

A directive lives at `directives/<id>.json`:

| field | rule |
|---|---|
| `id` | required; `^[a-z0-9][a-z0-9-]{0,31}$`; must equal the filename stem |
| `title` | required string, 1-120 characters |
| `durationSec` | required integer, 1-600 |
| `outcome` | required: `pass` \| `fail` \| `flake` |
| `flakeRate` | number in (0, 1]. Required when outcome is `flake`; a warning (not an error) with any other outcome |
| `breaksWith` | optional array of ids (default `[]`): at most 10, no self-reference, no duplicates. Symmetric: either side may declare it. An id that does not exist is fine (inert) |
| `conflictKey` | optional, `^[a-z0-9-]{1,32}$`. Validated only; the conflict itself lives in `conflicts/<key>.txt` |
| unknown keys | warning |

The file must hold a JSON object. Invalid JSON is an error. `schema/directive.schema.json`
describes the same format as a JSON Schema, but the runner validates by hand.

The samples in `examples/` can be copied into `directives/` as they are, because each id equals
its filename stem.

`examples/pass.json`:
```json
{
  "id": "pass",
  "title": "Passes after 20 seconds",
  "durationSec": 20,
  "outcome": "pass"
}
```

`examples/fail.json`:
```json
{
  "id": "fail",
  "title": "Fails after 15 seconds",
  "durationSec": 15,
  "outcome": "fail"
}
```

`examples/flake.json`:
```json
{
  "id": "flake",
  "title": "Fails 30% of runs after 45 seconds",
  "durationSec": 45,
  "outcome": "flake",
  "flakeRate": 0.3
}
```

`examples/breaks-with.json` passes on its own but fails whenever `pass` is also present:
```json
{
  "id": "breaks-with",
  "title": "Passes alone, breaks with pass",
  "durationSec": 25,
  "outcome": "pass",
  "breaksWith": ["pass"]
}
```

`examples/conflict.json` passes. A PR that adds it also edits `conflicts/demo.txt`, so two such
PRs conflict with each other:
```json
{
  "id": "conflict",
  "title": "Passes after 10 seconds (conflict key demo)",
  "durationSec": 10,
  "outcome": "pass",
  "conflictKey": "demo"
}
```

## How a run is decided

- **Active vs inert.** A directive is **active** when it was added since the merge-base of `HEAD`
  and the base branch (`origin/main` by default). Directives already on main are **inert**, so a
  directive goes inert once it lands. The runner reads
  `git diff --name-status --no-renames <merge-base> HEAD -- 'directives/*.json'`:
  - added (`A`): active;
  - modified (`M`, or a type change `T`): active, with a warning annotation;
  - deleted (`D`): ignored;
  - renamed: with `--no-renames` this is a delete plus an add, so the new file is active (and its
    `id` must match the new filename).

  Only top-level `directives/*.json` files count; nested directories and other files are ignored.
  Everything is read from the `HEAD` commit, never the working tree, so a local dry-run sees
  exactly what CI sees. Uncommitted changes are invisible.
- **Run time** is the longest `durationSec` among the active directives, times the duration factor.
- **Duration factor.** Each run draws one factor, uniform over 0.50, 0.51, ..., 1.00, and every
  directive time (the run time, the failure times below and the `At` column) is multiplied by it,
  so a run takes between half and all of its declared time. That lets a later batch that is up to
  twice as long finish before the batch ahead of it.
  One factor scales every time equally, so the outcome, which directive fails first and the
  tie-breaks are unchanged. The factor comes from the same seed as the flake rolls (below) but
  from a separate generator, so the rolls do not depend on it. It is printed as
  `Duration factor:` in the log, the dry-run output and the job summary.
- **Fail fast.** A `fail` directive fails at its `durationSec`, and the run stops at the earliest
  failure. Two failures at the same second are decided by id (alphabetical), and the loser is
  reported as `not reached`. Directives due after the failure are `not reached` too.
- **Flakes re-roll on every run.** Each active `flake` directive draws one roll in [0, 1), in id
  order, and fails at its `durationSec` if the roll is below `flakeRate`. The rolls come from a
  seeded PRNG (mulberry32). In CI the seed is FNV-1a of `"<GITHUB_RUN_ID>:<GITHUB_RUN_ATTEMPT>"`,
  so a re-run (a new attempt) re-rolls, while the same attempt always reproduces. The seed is
  logged, and `--seed` replays it (rolls and duration factor) locally.
- **breaksWith is symmetric.** A pair `{a, b}` declared by either side fails when **both** files
  are present in the tree **and at least one is active**. It fails at the longest duration among
  its active members, and each active member reports `broke with <partner>`. So a pair of two
  inert directives never fails, and a partner that does not exist never fails. A partner whose file
  is malformed still counts as present (but a malformed file declares nothing itself).
- **Malformed directives.** An invalid **active** directive fails the run at t=0, with one
  `::error file=directives/<id>.json,title=Invalid directive::...` annotation per problem and the
  error list in the job summary. An invalid **inert** directive only produces a warning and is
  ignored, so a bad file on main can never block the queue.
- **Conflicts.** `conflicts/` holds plain text files. A PR with a `conflictKey` also edits
  `conflicts/<key>.txt`, so two PRs with the same key cause a real git merge conflict. The runner
  only validates the key.
- **PR runs are fast.** On `pull_request` the workflow passes `--max-seconds 5`, so the sleep is
  capped at 5 seconds. The outcome is unchanged; it is only reported sooner. Queue runs sleep for
  the full simulated time.

The results table has one row per active directive:

| Result | Meaning |
|---|---|
| `passed` | finished before the run ended (flake rows show the roll, e.g. `passed (roll 0.71 >= 0.30)`) |
| `failed` | the `fail` directive that ended the run |
| `flaked (roll 0.12 < 0.30)` | the `flake` directive that ended the run |
| `broke with <id>` | a member of the `breaksWith` pair that ended the run |
| `not reached` | due after the run ended, or its own failure lost the tie-break |

The `At` column is the simulated second the row finished, after the duration factor; the `Spec`
column shows the declared `durationSec`. The runner exits 0 when the run passes, 1 when it fails
(or the setup is broken, for example no merge-base), 2 for bad arguments, and 130 or 143 when it is
cancelled (see the workflow section).

### Edge cases

- **`workflow_dispatch` on main:** `HEAD` is the merge-base, so nothing is active and the run
  passes ("No active directives - nothing to test").
- **A directive pushed straight to main:** inert, but it still counts for `breaksWith`.
- **The same directive twice:** identical content merges cleanly and is evaluated once; different
  content is a real add/add conflict, so the queue ejects it; the same id in two different files
  is caught by the id-equals-filename rule.
- **A deleted directive** can break nothing. Deleting one can even fix a `breaksWith` pair.
- **A renamed directive** is handled as a delete plus an add.

## Workflow

`.github/workflows/ci.yml` runs one job, `test`, which runs the unit tests and then the runner.

- **Triggers:** pushes to `mq/**` (the queue's test branches), `pull_request` and
  `workflow_dispatch`. There is no `paths` filter. Pushes to main trigger nothing, so the queue's
  fast-forward of main costs no runner.
- **On `pull_request`**, `HEAD` is `refs/pull/N/merge`, so the merge-base is main's tip and the
  active set is exactly that PR's directives.
- **Concurrency:** queue runs never cancel each other, because each run gets its own group
  (`run-<run_id>`). PR runs share one group per PR (`pr-<number>`) with `cancel-in-progress`, so a
  new push to a PR cancels its stale run.
- **Cancellation:** to cancel a run, the Actions runner sends SIGINT, then SIGTERM, to the step's
  process only. The runner step starts with `exec`, so that process is node itself rather than
  bash, which would hold back SIGINT until node finished and, on SIGTERM, exit and leave node
  sleeping as an orphan. On either signal the runner prints
  `Run cancelled (SIGINT) at t=<s> of <s>; exiting without a result.`, writes no job summary and
  exits at once with 130 (SIGINT) or 143 (SIGTERM). GitHub itself takes a while to pass a cancel
  on to the runner (about 28 seconds when we measured it).
- The checkout uses `fetch-depth: 0` because the runner needs history to find the merge-base.

## Local usage

Run the tests (about a second; they need `git` and Node 20 or newer):

```sh
node --test runner/*.test.mjs
```

The runner:

```
node runner/run.mjs [--base origin/main] [--dry-run] [--seed N] [--time-scale 1] [--max-seconds N]
```

- `--base <ref>`: the branch to compare against (default `origin/main`).
- `--dry-run`: print the results table and exit by the outcome, without sleeping or writing a job
  summary.
- `--seed <0..4294967295>`: fix the flake rolls and the duration factor. Without it the seed comes
  from `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`, or is random outside Actions. Every run prints a
  `Reproduce:` line with the seed it used.
- `--time-scale <x>`: real seconds per simulated second (default 1; `0` means don't sleep).
- `--max-seconds <n>`: cap the sleep at n simulated seconds. The run then says
  `sleep capped at <n>s; outcome unchanged`.

### Dry-run on a scratch branch

The runner only sees committed changes, like CI, so commit the directives first. In a fresh clone
(with no directives on main yet):

```sh
git switch -c scratch
cp examples/*.json directives/
git add directives
git commit -m "Try the examples"
node runner/run.mjs --dry-run --base main --seed 7
```

```
Base: main
Seed: 7 (from --seed)
Duration factor: 0.76 (from the seed; scales every durationSec)
Active directives: 5 (breaks-with, conflict, fail, flake, pass)

Directive    Title                                        Spec                      Result       At
-----------  -------------------------------------------  ------------------------  -----------  -----
breaks-with  Passes alone, breaks with pass               pass 25s breaksWith pass  not reached  -
conflict     Passes after 10 seconds (conflict key demo)  pass 10s conflict demo    passed       7.6s
fail         Fails after 15 seconds                       fail 15s                  failed       11.4s
flake        Fails 30% of runs after 45 seconds           flake 30% 45s             not reached  -
pass         Passes after 20 seconds                      pass 20s                  not reached  -

Result: FAIL - fail failed at t=11.4s (run time 34.2s)
0 inert directives on main
Reproduce: node runner/run.mjs --dry-run --base main --seed 7
```

The `fail` directive stops the run at 11.4s (its 15s times the factor 0.76). Drop it and the
`breaksWith` pair fails next:

```sh
git rm -q directives/fail.json
git commit -m "Drop fail"
node runner/run.mjs --dry-run --base main --seed 7
```

```
Base: main
Seed: 7 (from --seed)
Duration factor: 0.76 (from the seed; scales every durationSec)
Active directives: 4 (breaks-with, conflict, flake, pass)

Directive    Title                                        Spec                      Result                  At
-----------  -------------------------------------------  ------------------------  ----------------------  ----
breaks-with  Passes alone, breaks with pass               pass 25s breaksWith pass  broke with pass         19s
conflict     Passes after 10 seconds (conflict key demo)  pass 10s conflict demo    passed                  7.6s
flake        Fails 30% of runs after 45 seconds           flake 30% 45s             not reached             -
pass         Passes after 20 seconds                      pass 20s                  broke with breaks-with  19s

Result: FAIL - breaks-with broke with pass; pass broke with breaks-with at t=19s (run time 34.2s)
0 inert directives on main
Reproduce: node runner/run.mjs --dry-run --base main --seed 7
```

Drop `breaks-with` too, and only the flake is left to decide. Seed 7 rolls 0.01 (flaked) and
seed 1 rolls 0.63 (passed):

```sh
git rm -q directives/breaks-with.json
git commit -m "Drop breaks-with"
node runner/run.mjs --dry-run --base main --seed 7
```

```
Base: main
Seed: 7 (from --seed)
Duration factor: 0.76 (from the seed; scales every durationSec)
Active directives: 3 (conflict, flake, pass)

Directive  Title                                        Spec                    Result                     At
---------  -------------------------------------------  ----------------------  -------------------------  -----
conflict   Passes after 10 seconds (conflict key demo)  pass 10s conflict demo  passed                     7.6s
flake      Fails 30% of runs after 45 seconds           flake 30% 45s           flaked (roll 0.01 < 0.30)  34.2s
pass       Passes after 20 seconds                      pass 20s                passed                     15.2s

Result: FAIL - flake flaked (roll 0.01 < 0.30) at t=34.2s (run time 34.2s)
0 inert directives on main
Reproduce: node runner/run.mjs --dry-run --base main --seed 7
```

```sh
node runner/run.mjs --dry-run --base main --seed 1
```

```
Base: main
Seed: 1 (from --seed)
Duration factor: 0.77 (from the seed; scales every durationSec)
Active directives: 3 (conflict, flake, pass)

Directive  Title                                        Spec                    Result                      At
---------  -------------------------------------------  ----------------------  --------------------------  -----
conflict   Passes after 10 seconds (conflict key demo)  pass 10s conflict demo  passed                      7.7s
flake      Fails 30% of runs after 45 seconds           flake 30% 45s           passed (roll 0.63 >= 0.30)  34.6s
pass       Passes after 20 seconds                      pass 20s                passed                      15.4s

Result: PASS at t=34.6s
0 inert directives on main
Reproduce: node runner/run.mjs --dry-run --base main --seed 1
```

Directives already on main show up in the `N inert directives on main` count (and can matter
through `breaksWith`), so on a clone where main already has directives that line differs.

### A fast real run

Without `--dry-run` the runner sleeps until the outcome is due, logging a heartbeat at least every
10 real seconds, and appends a Markdown summary to `$GITHUB_STEP_SUMMARY` when that is set.
`--time-scale 0.1` makes each simulated second take 0.1 real seconds:

```sh
node runner/run.mjs --base main --seed 1 --time-scale 0.1
```

```
Base: main
Merge-base: <sha of main>
Seed: 1 (from --seed)
Duration factor: 0.77 (from the seed; scales every durationSec)
Active directives: 3 (conflict, flake, pass)
Simulating 34.6s at time scale 0.1 (3.5s real)
t=34.6s of 34.6s

Directive  Title                                        Spec                    Result                      At
---------  -------------------------------------------  ----------------------  --------------------------  -----
conflict   Passes after 10 seconds (conflict key demo)  pass 10s conflict demo  passed                      7.7s
flake      Fails 30% of runs after 45 seconds           flake 30% 45s           passed (roll 0.63 >= 0.30)  34.6s
pass       Passes after 20 seconds                      pass 20s                passed                      15.4s

Result: PASS at t=34.6s
0 inert directives on main
Reproduce: node runner/run.mjs --dry-run --base main --seed 1
```

Ctrl-C (SIGINT) or SIGTERM during the sleep stops the run at once with exit code 130 or 143, and
no job summary is written. For the same command without `--time-scale`, stopped after 5 seconds,
the log ends with:

```
Simulating 34.6s at time scale 1 (34.6s real)
Run cancelled (SIGINT) at t=4.9s of 34.6s; exiting without a result.
```

When you are done: `git switch main && git branch -D scratch`.

## Setup runbook

- [x] 1. Create the public repo `tribble/trib-mq-sandbox`.
- [x] 2. Set Actions workflow permissions to read-only (Settings > Actions > General > Workflow
  permissions).
- [x] 3. Install App #1 (`trib-mq`, app id 5295072), the queue.
- [ ] Merge the PR that adds this runner **before** the ruleset exists. Once the ruleset is active,
  only App #1 can update main.
- [ ] 4. Apply the ruleset:

  ```sh
  gh api repos/tribble/trib-mq-sandbox/rulesets -X POST --input .github/ruleset-main.json
  ```

  `.github/ruleset-main.json` targets the default branch (`~DEFAULT_BRANCH`) with enforcement
  `active` and three rules: `update` (Restrict updates: only a bypass actor can update main),
  `deletion` (main cannot be deleted) and `non_fast_forward` (no force pushes). There is **no**
  `pull_request` rule and **no** linear-history rule. The only bypass actor is App #1
  (`actor_type: Integration`, `actor_id: 5295072`, `bypass_mode: always`), so the queue is the
  only way to update main.
- [x] 5. Create the `mq:queue` label.
- [x] 6. Install App #2 (`trib-mq-demo`), the demo bot, and do **not** add it to the bypass list.
- [ ] 7. Smoke test: open a PR that copies `examples/fail.json` into `directives/`. Its PR check
  should fail quickly (the sleep is capped at 5s). Then enqueue it (`mq:queue` label) and check
  that the `mq/line` run fails at about `durationSec` times the duration factor (7.5-15s) plus ~15s
  of runner startup, and that the queue ejects the PR.
- [ ] 8. From then on, sandbox changes (including changes to this runner and the workflow) go
  through the queue.
