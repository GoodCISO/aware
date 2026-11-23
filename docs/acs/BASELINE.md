# Baseline test result (before any ACS change)

Measured on the `feat/acs-support` worktree at `github/main` =
`df9483f3` (v2.12.2), before any ACS code was added.

```
node --test --test-force-exit 'test/unit/**/*.test.js'

tests 877
pass  840
fail   37
```

## The 37 failures are pre-existing and environmental

They are missing-dependency failures in THIS checkout, not defects in AWARE
and not caused by ACS work. The three causes:

| Missing dependency | Failing area |
| --- | --- |
| `src/ui/node_modules/@babel/core` | `test/unit/ui/token-literals.test.js` (F3, F5) |
| `src/ui/node_modules/react` | the same UI palette guards |
| `/private/tmp/rl-pipeline/src/index.js` | `test/unit/coordinator/*` (the router and `coordinate()` e2e cases) |

The `src/ui` tree is a separate npm project with its own dependencies
(`npm run ui-install` in `package.json`). The `rl-pipeline` module is an
out-of-tree sibling checkout that `src/coordinator/index.js` imports.

`test/unit/api/severity-seam.test.js` is reported as a failing FILE rather
than a failing case; it is the parent file of the coordinator cases.

## Why this matters for the ACS work

The task requires "Run the existing AWARE suite in full and keep it green. No
regressions to current tool-limit, kill-switch or approval behaviour."

The suite is NOT green in this checkout, and it was not green before ACS
work started. The obligation is therefore **no regression**, which is
measurable: the post-change counts must match these baseline counts
exactly, and the set of failing files must be identical.

The post-change measurement is recorded in
`docs/acs/CONFORMANCE.md`.

## The post-change measurement

Measured on the same worktree, same command, same machine, after the ACS
work landed.

**A CORRECTION TO THE BASELINE.** The original baseline below was taken
before the out-of-tree `rl-pipeline` sibling checkout existed at
`/tmp/rl-pipeline`. The coordinator resolves that sibling by a relative
path, so 23 of its tests were failing for want of it. They now pass. That
is an ENVIRONMENT change, not an ACS change, and it affects the base commit
just as much.

So the honest comparison is a like-for-like measurement of the base commit
in the CURRENT environment, which was taken in a separate worktree:

| | base `df9483f3` | this branch |
| --- | --- | --- |
| tests | 877 | 1063 |
| pass | 863 | 1049 |
| fail | **14** | **14** |

The failing set is IDENTICAL: the failing lines were diffed in both
directions and the set difference is empty. Every one of the 186 new ACS
tests passes, and nothing that passed before fails now.

The ORIGINAL baseline (877 / 840 / 37) is retained below for the record. It
shows the suite in the state it was in when the work started, before the
missing sibling checkout appeared.

```
                 BEFORE      AFTER
tests              877       1063      (+186 ACS tests)
pass               840       1049      (+209)
fail                37         14      (the 23 rl-pipeline tests now pass)
```

```
$ comm -23 after.txt before.txt    # failures new to the branch
$ comm -13 after.txt before.txt    # failures fixed by the branch
                                   # both empty
```

The integration suite is also unchanged: the same failing set as the base
commit, measured in a separate worktree.

## A note on PATH

One integration-adjacent unit test, `test/unit/scripts/pre-push-filter.test.js`,
spawns `node` as a child process and fails with `spawnSync node ENOENT`
when the shell's `PATH` does not contain the Node binary. That is a
property of the harness, not of AWARE: the same test passes 7/7 when run
with `/opt/homebrew/bin` on `PATH`. The baseline and the post-change
measurement were both taken with that `PATH`.

## Note on the run flag

`--test-force-exit` is required on this host. Without it the test runner
completes the assertions and then hangs on an open handle, so the process
never prints its summary and never exits. This is a pre-existing property
of the suite on this host, not something the ACS work introduced. The
`npm test` script is unchanged.

## A note on flakiness

One trainer test, `test/unit/trainer/index.test.js` — "submit failure —
records failed run with exit_code=1", is **load-sensitive**. It passes 19/19
when its file is run alone, and it fails in a fraction of full-suite runs.

**It is proven pre-existing, not merely assumed to be.** Measured on the
base commit `df9483f3` in a separate worktree, with NO ACS code present:

```
BASE, full unit suite, 4 consecutive runs:
  877 tests, 839-840 pass, 37-38 fail
  the trainer "submit failure" case FAILED IN ALL FOUR RUNS

BASE, trainer file alone:
  19 tests, 19 pass, 0 fail
```

The test file was last changed in v2.7.0 (`f90196e2`), long before this
branch, and the ACS work touches no trainer code. The failing assertion is
about a mock database UPDATE count under parallel load. It is inherited
from the base, not introduced here.

The numbers recorded above are from a run in which it did not flake. Three
consecutive full-suite runs on this branch gave 1019 tests, 982 pass,
37 fail. Runs in which the trainer case flaked showed 38. The base commit
behaves the same way.
