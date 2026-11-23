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

```
node --test --test-force-exit 'test/unit/**/*.test.js'

                 BEFORE      AFTER
tests              877        996      (+119 ACS tests)
pass               840        959      (+119)
fail                37         37      (unchanged)
```

**The failing set is byte-identical.** The 73 failing test-case lines were
diffed before and after; the set difference is empty in both directions. So
every one of the 119 new tests passes and nothing that passed before
fails now.

```
$ comm -23 after.txt before.txt    # failures new to the branch
$ comm -13 after.txt before.txt    # failures fixed by the branch
                                   # both empty
```

The integration suite is also unchanged: 28 tests, 22 pass, 4 fail, with
the same failing set as the base commit `df9483f3` measured in a separate
worktree.

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
