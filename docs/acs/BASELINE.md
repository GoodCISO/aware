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

## Note on the run flag

`--test-force-exit` is required on this host. Without it the test runner
completes the assertions and then hangs on an open handle, so the process
never prints its summary and never exits. This is a pre-existing property
of the suite on this host, not something the ACS work introduced. The
`npm test` script is unchanged.
