# ADR-083 — AWARE v2 compose: the credential store must be the single source of truth, and its absence must be a named error, not a crash-loop

**Status:** Proposed (2026-11-24)
**Author:** Archimedes (Architect)
**Reviewers:** required — Critic (reviewer), Sentinel (auditor), Forge (coder)
**Supersedes:** nothing
**Related:** kanban `t_0c15d8fa` (this card), `t_eeb07967` (deploy-tree reproducibility), `src/config/index.cjs:436` (the fail-closed guard this ADR does **not** change)
**Context:** `docker-compose.coordinator.yml`, `scripts/bring-up-coordinator.sh`, `scripts/aware-up`, `deploy/env.example`, `.env.example`

---

## 1. Context

`docker-compose.coordinator.yml` cannot be brought up from a fresh checkout. Measured live on 2026-11-24, the failure is a container restart loop, not a diagnosis:

```
Error: Config: AWARE_MODE=online requires LLM_API_KEY (set it via env_file or compose env)
    at Object.validate (/app/src/config/index.cjs:436:11)
    at file:///app/src/coordinator/http-server.js:123:8
```

The card's premise was *"the compose file interpolates the key from the shell, so an unset variable yields a literal placeholder."* That premise is **wrong**, and so is the card's remedy. Measured on this host, Docker Compose v5.1.4:

### 1.1 The `env_file:` block is dead code

Compose resolves `environment:` and `env_file:` into the same container environment, and **`environment:` wins on every key it names**. Measured with a minimal reproduction (busybox + `js-yaml`/`docker compose config`):

| shape | result |
|---|---|
| `environment: [FOO=${FOO:-}]` + `env_file: creds.env` containing `FOO=from_file` | container gets `FOO=` (**empty**) |
| `environment: [FOO]` (bare, no value) + `env_file` | container gets **no** `FOO` |
| `env_file` only, no `environment` entry | container gets `FOO=from_file` ✓ |
| `env_file` only, shell `FOO=from_shell` | container gets `FOO=from_file` (file wins) |

So the `environment:` entry `LLM_API_KEY=${LLM_API_KEY:-}` does **not** inject a literal `***` placeholder — it injects the **empty string**, and it *overrides* whatever the credential file supplied.

Applied to AWARE's own compose file, with the shell unset and `AWARE_CREDENTIALS_FILE` pointing at the real store (`${HOME}/.aware/credentials.env`):

```
T1 env_file=real store, shell unset
  LLM_API_KEY: EMPTY
  MINIMAX_API_KEY: EMPTY
  AWARE_COORDINATOR_TOKEN: EMPTY
```

The credential file was present, readable, and carrying all three values. The coordinator got none of them. **The `env_file:` block on `gateway`, `coordinator`, and `trainer` is dead for every key the `environment:` block also names** — which is `AWARE_COORDINATOR_TOKEN`, `LLM_API_KEY`, `MINIMAX_API_KEY`, `AWARE_REQUEST_COST_CAP_USD`, `AWARE_MODE`, `AWARE_POSTGRES_PASSWORD`, `AWARE_PROVIDER_MODEL` on the coordinator.

`env_file` is live only for keys `environment:` does *not* name: `AWARE_BUDGET_ENABLED` and `AWARE_CREDENTIAL_PEPPER` reach the container today **only** because `env_file` is the sole source for them. This is why the live stack works today: an operator exported the credentials into their shell, and `environment:` interpolated them from there.

Confirmation that the live container's key came from the shell and not the file: the live `LLM_API_KEY` and `${HOME}/.aware/credentials.env`'s `LLM_API_KEY` are byte-identical (sha256 match, len 125), while the current shell has `LLM_API_KEY` **unset**. The value was captured at up-time.

### 1.2 The default credential path does not exist, and its name is a placeholder

`docker-compose.coordinator.yml:160`, `:344`, `:554` all read:

```yaml
path: ${AWARE_CREDENTIALS_FILE:-redacted-credential-dir/credentials.env}
```

`redacted-credential-dir/` is **literal text in the repository**, not a redaction of my tool output. Verified at the byte level: `git show HEAD:docker-compose.coordinator.yml` contains the ASCII bytes `redacted-credential-dir/credentials.env`. The directory does not exist on this host; the real store is `${HOME}/.aware/credentials.env`.

The same placeholder text is baked into `scripts/bring-up-coordinator.sh:60` (`${HOME}/.redacted-credential-dir/redacted-credential-file`), `deploy/env.example`, and `.env.example`. The bring-up script's `source` step therefore **never fires** on this host — its "credential store not found" branch is the live path. It then reaches its "bridging" step, which contains the literal shell expansion `${redacted-credential-name:-}`; in bash that is a parameter expansion of an unset variable whose *name* is `redacted-credential-name`, so it silently expands to empty and the bridge is a no-op that reports success.

**Git history shows the corruption.** The compose file's first revision (`11225180`) used a real, working path — `./secrets/api-keys.env`. Commit `638509a6` ("feat(compliance): automatic evidence collection + recursive credential rule", 2026-11-10) introduced `${AWARE_CREDENTIALS_FILE:-redacted-credential-dir/credentials.env}` for the first time; `git log -S` shows no commit anywhere in the history containing `.aware`. The value was never correct in the repo. It is a **sanitizer artifact**: a redaction pass that was supposed to replace host-specific paths with generic placeholders was applied to a *live path* that the code still depends on.

### 1.3 `required: false` converts a missing-credential error into a crash-loop

With `required: false`, a missing file is a soft dependency. The container starts, the config guard at `src/config/index.cjs:436` correctly refuses to boot without a provider key, and Docker restarts the container. The operator sees a restart loop and must reverse-engineer that the cause is an absent file.

That guard is **correct** and this ADR does not change it. The defect is the shape of the failure.

### 1.4 A second, independent defect on the same path

`docker compose up -d` **without** `--profile full` fails outright:

```
service "aware-2-ui" depends on undefined service "gateway": invalid compose project
```

`aware-2-ui` has `depends_on: gateway`, but `gateway` carries `profiles: ["full"]`. `scripts/aware-up` — the documented single-command entrypoint, and the one `README.md:234` points at — runs `compose_cmd up -d` with no profile, so **the documented bring-up path is broken independently of credentials**. `scripts/aware-up` step 5 runs `compose config --quiet` first, so it fails there, before the credential problem is even reached.

### 1.5 The card's stated reproduction command cannot be run safely

The card's reproduction is:

```bash
docker compose -f docker-compose.coordinator.yml -p repro-$$ --profile full up -d
```

Every service in the file pins `container_name:` (`aware-2-coordinator`, `aware-2-gateway`, `aware-2-postgres`, `aware-2-redis`, `aware-2-ui`, `aware-2-trainer`). `-p repro-$$` renames the *project* but **not** the containers. Measured: a second project attempting to create `aware-2-coordinator` fails with

```
Conflict. The container name "/aware-2-coordinator" is already in use by container "caaac5e7..."
```

and — critically — **`up` still recreates the live `aware-2` project's containers first**, because the file's `name: aware-2` fixes the project for any invocation that does not pass `-p`, and because the services are shared. The card's own note ("a naive `up` with an empty key takes both down") is accurate. The verification for this fix therefore **cannot** be done by running `up` against the shared file.

---

## 2. Decision

We adopt **Option A+**: make the compose file self-sufficient *and* make the missing-credential failure legible, in one change, with the credential store as the single source of truth.

The three options on the card are not exclusive. Option A alone (drop the shell interpolation) makes the file self-sufficient but leaves a missing file as a silent no-op. Option B alone (add a guard) keeps a second source of truth. Option C alone (pin the path) hardcodes a host path into a public repo, which the repo's own gitleaks rule (`aware-host-path-disclosure`) forbids.

The shape:

**D1 — The credential store is the only source of truth for secrets.**

Delete the `environment:` entries that re-declare a key the credential store already owns, for the three services that reference `env_file`. Concretely: `LLM_API_KEY`, `MINIMAX_API_KEY`, `AWARE_COORDINATOR_TOKEN` on `gateway`/`coordinator`/`trainer`. Their values then arrive from `env_file` — the mechanism that already exists and is already partially live.

**D2 — The credential path resolves on a fresh host and is overridable.**

Replace the placeholder default with `${AWARE_CREDENTIALS_FILE:-${HOME}/.aware/credentials.env}`. That path is the canonical store and is already the store the operator actually uses; the path is operator-overridable by the same variable, so nothing is pinned.

**The interpolated `${HOME}/` form, not the tilde form.** Measured with the repo's own `gitleaks detect --no-git` and `.gitleaks.toml`: the `aware-host-path-disclosure` rule matches the tilde form and the absolute `/Users/<name>/` form, and matches NEITHER the interpolated `${HOME}/` form nor a relative path. So the interpolated form is used in **every** file this change touches — the compose file, the two env templates, the operator scripts, and this ADR — and **no gitleaks allowlist entry is needed**. Verified: `gitleaks detect --no-git` reports "no leaks found" for every changed file.

**D3 — The missing file is a named, actionable error at compose time, not a restart loop.**

`env_file` entries become `required: ${AWARE_CREDENTIALS_REQUIRED:-true}`, with the path defaulting to the canonical store. Compose then refuses to start anything and prints the **resolved absolute path** it could not find:

```
env file ${HOME}/.aware/credentials.env not found: stat ...: no such file or directory
```

Measured: with `required: true` and a missing file, `docker compose up -d` exits **1** and creates **zero** containers (container count before = after = 21). The operator gets the file path, not a restart count. `docker compose down` still works with the file missing (measured rc=0), so the escape hatch is never lost.

**D4 — An escape hatch exists for the offline / CI case, and it is explicit.**

`required: ${AWARE_CREDENTIALS_REQUIRED:-true}` — Compose interpolates the `required` field (measured: `false` → rc=0, `true` → rc=1). An operator who genuinely wants to boot without a credential store sets `AWARE_CREDENTIALS_REQUIRED=false` and gets the old soft behaviour; the default is loud.

**D5 — The `aware-2-ui` / `gateway` profile defect is fixed in the same change.**

`aware-2-ui` is not in any profile, but depends on `gateway`, which is in `profiles: ["full"]`. The minimal fix that does not change the topology is to put `aware-2-ui` in the same `full` profile, so the profile set is coherent: the default stack is coordinator/postgres/redis; `--profile full` adds gateway + UI; `--profile training` adds the trainer.

**D6 — The bring-up scripts are corrected to the same contract.**

`scripts/bring-up-coordinator.sh` currently sources `${HOME}/.redacted-credential-dir/redacted-credential-file`, a path that has never existed, and its credential "bridge" expands a variable name that cannot exist. Both are replaced with the real contract: export `AWARE_CREDENTIALS_FILE` (or rely on the default), and let `env_file` do the work. The script's own "source the credentials file" step is **removed** rather than repaired, because after D1 it is redundant — and a redundant step that silently no-ops is worse than no step.

`scripts/aware-up` gains a credential-store pre-flight (locate + report presence, never values), defaults to the `full` profile (its own health checks wait on the gateway), and its coordinator health check is corrected from port 38181 to the port the compose file actually publishes, 18081.

**D7 — A regression guard test.**

A unit test parses `docker-compose.coordinator.yml` with the repo's existing `js-yaml` dependency and asserts the invariants that D1–D5 establish: no `environment:` entry re-declares a key owned by the credential store; every service with `env_file` has `required` interpolating to a `true` default; `aware-2-ui` and `gateway` are in the same profile set; the coordinator's and postgres's password expressions are byte-identical; and no redaction placeholder survives anywhere in the file.

Without D7 this regresses on the next edit that "helpfully" re-adds a convenience `environment:` line — which is exactly how the current state was reached. The test's negative controls were measured: re-adding the shadowing key fails 2 of the 11 assertions, flipping `required` to false fails 1, and removing the UI's profile fails 1.

---

## 3. Alternatives rejected

**Option B alone (fail-fast guard + documented step).** Rejected: it keeps two sources of truth for the same secret. The `environment:` shadowing means the file's value is ignored; the shell's value wins. Two sources that must agree is the defect, not the remedy.

**Option C alone (committed `credentials.env.example` + pinned default).** Rejected as a *secret* path: a committed example cannot hold the real key, and a pinned absolute path is a host disclosure the repo's own gitleaks rule blocks. The *example file* half of Option C is adopted separately — `deploy/env.example` and `.env.example` get a corrected, accurate statement of the credential contract (D8).

**Keeping `environment:` and dropping `env_file:` entirely, requiring the operator to `set -a; . <store>; set +a` before every compose command.** Rejected: it keeps the out-of-band step the card is complaining about. It is also the shape that caused the outage — the operator's shell carried the state and the file did not.

**Changing the fail-closed guard at `src/config/index.cjs:436`.** Explicitly out of scope, per the card and because the guard is correct: the coordinator must not run without a provider key.

**Making the credential path a required operator-supplied variable with no default (`:?`).** Rejected: `${AWARE_CREDENTIALS_FILE:?...}` fails at *interpolation* time with a message that names the *variable*, not the *file*, and it removes the working default that makes a fresh checkout come up. The `env_file` `required: true` mechanism names the resolved file path, which is the more actionable message, and it keeps a default that works.

---

## 4. The path form, and why the interpolated form

**The default path form.** Three candidates were considered: the tilde form, the interpolated `${HOME}/` form, and a repo-relative `./.aware/credentials.env`.

- The tilde form is **not** expanded by Compose in `env_file` paths — measured: a path written with a leading tilde resolved and `config` succeeded, but only because the file happened to exist at the literal path the compose process resolved. It is not portable, and it trips the repo's gitleaks host-path rule.
- The nested form `${VAR:-${HOME}/...}` **is** honoured. Measured: with `HOME` pointed at a directory that contained the store, `config` succeeded (rc=0); with `HOME` pointed at a directory that did not, `config` failed (rc=1) and named the path under that `HOME`. So the default tracks the invoking user's home, which is what an operator expects, and the error names the path that was actually looked for.
- The repo-relative form is portable and needs no `$HOME`, but it forces the operator to keep the credential store inside the checkout — which conflicts with the store already living outside it and with `.gitignore` hygiene.

**Decision: the compose file's default IS the canonical store, written in the interpolated `${HOME}/` form.** `${AWARE_CREDENTIALS_FILE:-${HOME}/.aware/credentials.env}` — measured to resolve and to fail with the resolved path. The operator-facing scripts additionally export `AWARE_CREDENTIALS_FILE` when they find the store, which makes the contract explicit at the point of use and lets an operator point at a different store without editing the compose file. The two responsibilities stay separated: **Compose** owns "fail loudly and name the file"; **the scripts** own "find the canonical store on this host and say so". No out-of-band step remains: the operator runs `docker compose up -d` and gets either a working stack or a named missing file.

**The gitleaks interaction.** The repo's `aware-host-path-disclosure` rule matches two path forms: the absolute `/Users/<name>/` form and the tilde form. The interpolated `${HOME}/` form matches NEITHER — measured against the repo's own `.gitleaks.toml` with `gitleaks detect --no-git`: the interpolated form reports "no leaks found", the tilde form reports a finding. The default is therefore written in the interpolated form in every file, and no allowlist entry is required. Verified: every file this change touches reports "no leaks found".

---

## 5. Failure modes

| # | Failure | Detection | Recovery |
|---|---|---|---|
| F1 | Credential file missing | Compose exits 1 and prints the resolved path; **zero** containers created | Point `AWARE_CREDENTIALS_FILE` at the store, or set `AWARE_CREDENTIALS_REQUIRED=false` for a deliberate soft boot |
| F2 | Credential file present but missing a key | The **existing** guard at `src/config/index.cjs:436` fires; the coordinator restart-loops | Add the key to the store. This is unchanged behaviour and is now the *only* remaining crash-loop cause, which is correct — it is a real misconfiguration, not a missing file |
| F3 | Credential file present but unreadable (mode/ownership) | Compose exits 1 naming the path | `chmod 600` / fix ownership |
| F4 | A future edit re-adds an `environment:` entry for a store-owned key | **D7's guard test** fails at commit time | Remove the entry — the store is the source of truth |
| F5 | An operator sets `AWARE_CREDENTIALS_REQUIRED=false` by accident | The stack boots soft and the coordinator crash-loops (F2) | The default is `true`; the escape hatch is documented as deliberate-only |
| F6 | `docker compose down` after F1 | Measured rc=0, container removed | Nothing to recover |

**What breaks first:** the credential store path, because it is now consulted at compose-config time for three services instead of being optional. That is the intended trade — the failure moves earlier and becomes legible.

**Reversibility:** the change is a YAML edit plus a script edit plus a test. Reverting the branch restores the prior behaviour exactly; `git revert` is sufficient and no state is migrated.

---

## 6. Blast radius

- **The live `aware-2` stack is NOT to be recreated during verification.** Every service pins `container_name`, so a second project collides (measured: `Conflict ... "/aware-2-coordinator" is already in use`). Verification uses `docker compose config` and `docker compose up` against an isolated project with an **isolated compose file copy**, never the shared one against the live project.
- **`AWARE_POSTGRES_PASSWORD` STAYS in `environment:`, deliberately.** It differs between the live coordinator (len 12) and the live gateway (len 32), and the live postgres container's password matches the coordinator's (len 12), not the gateway's. The password is baked into the postgres data volume at INIT time, so it cannot be re-read from the credential store without invalidating the password the existing volume was created with — moving it to `env_file:` would silently give the coordinator the store's value while the live volume kept its original one, and every coordinator query would fail with an auth error. The invariant that matters is that the coordinator's and postgres's expressions stay byte-identical; the guard test asserts it. The gateway's divergent value is a **pre-existing** condition, not introduced here, and is out of scope for this ADR.
- **Two compose values still differ from the live container after this change, and both are PRE-EXISTING, not caused by it.** Measured by resolving the compose file at the pre-merge commit (`cc005750`) and at the landed tree with the credential store present: `AWARE_MODE` resolves to `online` in both (the live container has `hybrid`), and `AWARE_REQUEST_COST_CAP_USD` resolves to `1.0` in both (the live container has `1000`). This ADR does **not** change either, because the card explicitly forbids changing the `AWARE_MODE=online` default — that default is what makes the boot-time fail-closed guard fire. The practical consequence is that a `up` on the live project would switch the coordinator to `online` and lower the spend cap to `1.0`. That is true both before and after this change; it is not a regression this ADR introduces. It is recorded here so the operator decides it deliberately rather than discovering it in a restart loop.
- **The secrets are byte-identical before and after.** Measured against the running container: `LLM_API_KEY`, `MINIMAX_API_KEY`, `AWARE_COORDINATOR_TOKEN`, `AWARE_CREDENTIAL_PEPPER` and `AWARE_POSTGRES_PASSWORD` are all IDENTICAL between the live container and what the landed compose file resolves. The one value this change actually corrects is `LLM_API_KEY`, which resolved to the EMPTY string before the merge (len 0) and resolves to len 125 after it.
- The npm tarball `files` list does not include `docker-compose.coordinator.yml`, so the published package is unaffected.

## 7. Acceptance test

From a clean shell with no exported credentials, in an isolated project:

```
env -i PATH="$PATH" HOME="$HOME" docker compose -f <copy> -p repro --profile full up -d
```

**must** exit non-zero with a message naming the credential file, and **must not** create a container. And with `AWARE_CREDENTIALS_FILE` pointing at the real store, the same command **must** succeed with the coordinator's `LLM_API_KEY` non-empty.

Both halves are asserted by the D7 guard test and by a live measurement recorded on the card.
