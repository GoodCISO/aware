#!/usr/bin/env python3
"""
azr/executor.py — Sandboxed Python task verifier for AZR self-play.

the AWARE 2.0 Architecture ADR (internal) Phase 3 deliverable. This module is the VERIFY half of the
PROPOSE → SOLVE → VERIFY → PREFERENCE_PAIR loop. It takes a candidate
solution (Python source produced by a solver LLM) and a set of test
assertions, runs the solution in a hard sandbox, and reports pass/fail
plus structured diagnostics.

CROSS-CUTTING: TaskCategory registration
========================================
This executor is TASK-CATEGORY-AGNOSTIC — it verifies any Python solution
regardless of the originating task category. The canonical TaskCategory
enum (including categories like 'notes-to-reviewer' for reviewer-note
intent) lives at:

    src/routing/pheromone-table.js (TaskCategory)

Categories reach the AZR pipeline indirectly, via the
`task_type` string on process-RL preference records that flow through
`src/trainer/outcome-filter.js` (the `tag_match` filter rule, plus
`allowedTaskTypes`). AZR itself does NOT maintain a parallel category
registry — extending the JS-side enum is sufficient.

If a future requirement adds AZR-side category gating, this file would
be the place for it (likely a `TASK_TYPE_REGISTRY` constant near the
class definitions, plus a `task_type` parameter on `executor.run`).
For now, no such wiring exists — the single source of truth is the
JS-side enum.

SECURITY MODEL
==============
The solution is UNTRUSTED LLM output. The threat model is:

  1. **Filesystem damage** — `os.system("rm -rf /")` must not work.
  2. **Network exfiltration** — `urllib.request.urlopen(...)` must fail.
  3. **Resource exhaustion** — `while True: pass` must be killed.
  4. **Privilege escalation** — `subprocess.run(["sudo", ...])` must fail.
  5. **Process escape** — `multiprocessing.Process(target=os.system)` must fail.

We defend with FIVE layered controls (in order of strength):

  A. **Subprocess isolation** — every run is `subprocess.run([sys.executable,
     "sandbox_runner.py", ...], timeout=N)`. The runner is a separate
     interpreter process so a sys.exit() in the solution doesn't kill
     the parent.
  B. **Filesystem isolation** — per-run scratch dir under a configurable
     base (default /tmp/azr-sandbox). Each scratch is `os.chdir()`'d into,
     and the runner raises if the solution tries to escape with `..`.
     No access to AWARE source, credentials, or the home dir.
  C. **Resource limits** — `resource.setrlimit()` for CPU time, memory
     (address space), file size, and number of processes. POSIX only
     (Linux + macOS, NOT Windows).
  D. **Blocked builtins** — `open()` in write mode raises. The dangerous
     modules (`os`, `sys`, `subprocess`, `socket`, `urllib`, `shutil`)
     are removed from `__builtins__` BEFORE the solution runs.
     The solution can still import math, json, re, etc.
  E. **Network kill switch** — `socket.socket()` raises. We don't try
     to do per-solution iptables — that's the host kernel's job
     (Modal pods run in their own network namespace; on bare metal
     the bring-up script should add a default-deny nftables rule).
     Defense-in-depth: even if the host network is open, the solution
     can't open a socket.

This is NOT a Python sandbox in the academic sense (true Python
sandboxing is famously unsolved — see PyPy's sandboxed mode, or
RestrictedPython). The goal is RAISED COST for the attacker, not
absolute prevention. An attacker who has compromised the solver LLM
to produce arbitrary code still has to escape the subprocess,
chroot-like filesystem, and the resource limits.

For a stronger guarantee, run this inside a Modal container with
`network_file_systems={}` and the host's seccomp profile
(`seccomp=unconfined` is required if you want resource limits to
work; Modal's default is fine). The trainer/run.py modal app spec
configures both.

INTERFACE
=========

Task categories (kept in sync with src/routing/pheromone-table.js → TaskCategory):

    code-generation      — write/implement/refactor/debug/test
    research             — investigate/explore/compare/review
    security-review      — vulnerability/audit/pentest/CVE
    data-analysis        — metrics/charts/correlation/aggregation
    coordination         — orchestrate/route/dispatch/schedule
    disclaimer-piling    — t_9881cd1d: stacked/over-redundant disclaimer content
    general              — default fallback (no keywords)

AZR does not enforce this registry at runtime — categories travel in the
solver prompt and reward shaping, not the executor. This block is the
authoritative registry reference for AZR-side reviewers and for the
notes-to-reviewer / disclaimer-piling lineage. Keep in sync when adding
new entries to pheromone-table.js.

    from azr.executor import SandboxExecutor, ExecutionResult, verify

    executor = SandboxExecutor(
        scratch_dir="/tmp/azr-sandbox",
        timeout_seconds=5,
        memory_mb=128,
    )

    result = executor.run(
        solution_source="def fib(n):\n    return n if n < 2 else fib(n-1)+fib(n-2)",
        test_source=(
            "assert fib(0) == 0\n"
            "assert fib(1) == 1\n"
            "assert fib(10) == 55\n"
        ),
    )

    if result.passed:
        print("PASS in", result.duration_ms, "ms")
    else:
        print("FAIL:", result.error_kind, "-", result.error_message)

    # Or use the convenience function for one-off:
    result = verify(solution_source, test_source)

ERROR KINDS
===========
- `passed` — solution ran, all tests passed
- `test_failure` — solution ran, at least one assertion failed
- `timeout` — CPU time limit hit (sandbox_runner killed the process)
- `memory_exceeded` — address space limit hit
- `process_limit` — solution tried to fork()
- `forbidden_import` — solution tried to import os/sys/subprocess/...
- `forbidden_builtin` — solution called a blocked builtin
- `runtime_error` — solution raised a Python exception (not assertion)
- `sandbox_error` — internal executor error (parent's fault, not solution's)

LOGGING
=======
The executor logs each run to stderr as a single JSON line. No PII
or solution content is included — only the error kind, duration,
and resource usage. This is consumed by the trainer's job log
collector.

NO MODAL DEPENDENCY
===================
This module is pure Python stdlib. It has zero Modal imports and
runs locally for unit tests. The Modal dependency is only in
training/run.py (which orchestrates the training loop) and
src/trainer/index.js (which submits jobs to Modal).
"""

from __future__ import annotations

import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "SandboxExecutor",
    "ExecutionResult",
    "verify",
    "DEFAULT_SCRATCH_DIR",
    "DEFAULT_TIMEOUT_SECONDS",
    "DEFAULT_MEMORY_MB",
    "FORBIDDEN_MODULES",
    "FORBIDDEN_BUILTINS",
]

# -- Defaults (operator-overridable per SandboxExecutor instance) --------

DEFAULT_SCRATCH_DIR = "/tmp/azr-sandbox"
DEFAULT_TIMEOUT_SECONDS = 5
DEFAULT_MEMORY_MB = 128
DEFAULT_MAX_PROCESSES = 1
DEFAULT_MAX_FILE_SIZE_MB = 4
DEFAULT_MAX_OPEN_FILES = 32

# Modules that, if imported by the solution, cause an immediate
# ForbiddenImportError. The list is intentionally aggressive — a
# Fibonacci solution doesn't need any of these.
#
# NOTE: "import os.path" is covered by "import os" (Python's import
# system doesn't allow sub-module imports without the parent).
# "from posix import *" is also blocked via the explicit name.
FORBIDDEN_MODULES = frozenset({
    "os", "posix", "nt", "sys", "subprocess", "socket", "urllib",
    "urllib3", "httplib", "http", "ftplib", "smtplib", "telnetlib",
    "shutil", "glob", "pathlib", "tempfile", "io", "asyncio",
    "multiprocessing", "threading", "concurrent", "ctypes", "cffi",
    "_thread", "pty", "tty", "fcntl", "pwd", "grp", "resource",
    "ssl", "select", "signal", "mmap", "termios", "fcntl",
    "pickle", "marshal", "shelve", "dbm", "sqlite3",
    "importlib", "imp", "runpy", "code", "codeop",
    "ast", "compile", "dis", "py_compile",
    "platform", "sysconfig", "distutils", "setuptools",
})

# Builtins removed from __builtins__ before the solution runs.
# `open` in any mode raises — solution can read inputs only via
# parameters passed in by the test harness, not by opening files.
FORBIDDEN_BUILTINS = frozenset({
    "open", "exec", "eval", "compile", "__import__", "input",
    "breakpoint", "exit", "quit", "help",
})

# -- Data classes ---------------------------------------------------------


@dataclass
class ExecutionResult:
    """Outcome of one verify() call.

    `passed` is the only field a successful verifier needs to read.
    The other fields exist for the AZR self-play loop's logging +
    the trainer's preference-pair generation.
    """
    passed: bool
    error_kind: str  # one of the ERROR_KINDS in module docstring
    error_message: str = ""
    duration_ms: int = 0
    memory_peak_kb: int = 0  # peak RSS; 0 if unknown
    tests_run: int = 0
    tests_failed: int = 0
    failure_assertions: list[str] = field(default_factory=list)
    stdout_truncated: str = ""  # capped at 1 KB
    stderr_truncated: str = ""  # capped at 1 KB
    sandbox_id: str = ""  # UUID of the scratch dir, for log correlation

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# -- Main executor --------------------------------------------------------


class SandboxExecutor:
    """Stateless, thread-unsafe executor. One instance per process is fine.

    A single instance can run many verifications in series. The instance
    is not safe for concurrent use from multiple threads (subprocess.run
    is blocking, and the resource limits are process-global on POSIX).
    The trainer (src/trainer/index.js) is the place where concurrency
    would be added — but for AZR self-play, the LLM calls dominate and
    the verification is I/O-bound, so a single executor is fine.
    """

    def __init__(
        self,
        scratch_dir: str = DEFAULT_SCRATCH_DIR,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        memory_mb: int = DEFAULT_MEMORY_MB,
        max_processes: int = DEFAULT_MAX_PROCESSES,
        max_file_size_mb: int = DEFAULT_MAX_FILE_SIZE_MB,
        max_open_files: int = DEFAULT_MAX_OPEN_FILES,
    ) -> None:
        self.scratch_dir = Path(scratch_dir)
        self.timeout_seconds = timeout_seconds
        self.memory_mb = memory_mb
        self.max_processes = max_processes
        self.max_file_size_mb = max_file_size_mb
        self.max_open_files = max_open_files

        # Lazily create the scratch dir. Per-run dirs are created in run().
        self.scratch_dir.mkdir(parents=True, exist_ok=True)

    def run(
        self,
        solution_source: str,
        test_source: str,
        *,
        function_under_test: str | None = None,
    ) -> ExecutionResult:
        """Verify a solution against tests in the sandbox.

        Args:
            solution_source: Python source for the candidate solution.
                Typically a single function definition.
            test_source: Python source for the test harness. Should be
                a sequence of `assert` statements. May import stdlib
                modules not in FORBIDDEN_MODULES (math, json, re, etc.)
            function_under_test: If set, the test harness will bind this
                name in the test module's namespace pointing to the
                solution's first top-level function. Default: infer
                from the first `def` in solution_source.

        Returns:
            ExecutionResult with passed=True iff the test_source ran to
            completion with no AssertionError and no exception.

        Notes:
            This is a hard sandbox. The solution cannot read or write
            files, cannot open network sockets, cannot fork, cannot
            import os/sys/subprocess. It CAN do pure computation +
            import math/json/re/etc.
        """
        sandbox_id = uuid.uuid4().hex[:12]
        scratch = self.scratch_dir / sandbox_id
        try:
            scratch.mkdir(parents=True, exist_ok=False)
        except OSError as e:
            return ExecutionResult(
                passed=False,
                error_kind="sandbox_error",
                error_message=f"could not create scratch dir: {e}",
                sandbox_id=sandbox_id,
            )

        # Write the solution + test files inside the scratch.
        try:
            (scratch / "solution.py").write_text(solution_source, encoding="utf-8")
            (scratch / "test_solution.py").write_text(test_source, encoding="utf-8")
            (scratch / "_sandbox_runner.py").write_text(
                self._build_runner_source(solution_source, test_source, function_under_test),
                encoding="utf-8",
            )
        except OSError as e:
            self._cleanup_scratch(scratch)
            return ExecutionResult(
                passed=False,
                error_kind="sandbox_error",
                error_message=f"could not write scratch files: {e}",
                sandbox_id=sandbox_id,
            )

        # Run the sandbox runner in a subprocess.
        # `python -I` = isolated mode (no PYTHONPATH, no user site).
        # `cwd=scratch` so a chdir escape would still be in the scratch.
        # `env=clean_env` strips AWARE_* and HOME so the solution can't
        #   read AWARE_POSTGRES_PASSWORD or similar from env.
        # `preexec_fn=_set_limits` applies resource limits to the child
        #   (POSIX only). On Windows this is a no-op (caught at import).
        cmd = [
            sys.executable,
            "-I",  # isolated mode
            "-S",  # don't import site
            str(scratch / "_sandbox_runner.py"),
        ]
        clean_env = self._build_clean_env()
        start = time.monotonic()
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(scratch),
                env=clean_env,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
                preexec_fn=_set_resource_limits if sys.platform != "win32" else None,
            )
            duration_ms = int((time.monotonic() - start) * 1000)
        except subprocess.TimeoutExpired as e:
            duration_ms = int((time.monotonic() - start) * 1000)
            self._cleanup_scratch(scratch)
            return ExecutionResult(
                passed=False,
                error_kind="timeout",
                error_message=f"execution exceeded {self.timeout_seconds}s wall-clock limit",
                duration_ms=duration_ms,
                stdout_truncated=(e.stdout or b"").decode("utf-8", "replace")[:1024] if isinstance(e.stdout, bytes) else (e.stdout or "")[:1024],
                stderr_truncated=(e.stderr or b"").decode("utf-8", "replace")[:1024] if isinstance(e.stderr, bytes) else (e.stderr or "")[:1024],
                sandbox_id=sandbox_id,
            )

        # The runner writes a JSON result file. If it's missing, that's
        # a sandbox error (the runner crashed before it could write).
        result_file = scratch / "_result.json"
        if not result_file.exists():
            self._cleanup_scratch(scratch)
            return ExecutionResult(
                passed=False,
                error_kind="sandbox_error",
                error_message="runner did not write _result.json",
                duration_ms=duration_ms,
                stdout_truncated=proc.stdout[:1024],
                stderr_truncated=proc.stderr[:1024],
                sandbox_id=sandbox_id,
            )

        try:
            raw = json.loads(result_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            self._cleanup_scratch(scratch)
            return ExecutionResult(
                passed=False,
                error_kind="sandbox_error",
                error_message=f"could not parse runner result: {e}",
                duration_ms=duration_ms,
                stdout_truncated=proc.stdout[:1024],
                stderr_truncated=proc.stderr[:1024],
                sandbox_id=sandbox_id,
            )

        self._cleanup_scratch(scratch)
        return ExecutionResult(
            passed=bool(raw.get("passed", False)),
            error_kind=str(raw.get("error_kind", "unknown")),
            error_message=str(raw.get("error_message", "")),
            duration_ms=duration_ms,
            memory_peak_kb=int(raw.get("memory_peak_kb", 0)),
            tests_run=int(raw.get("tests_run", 0)),
            tests_failed=int(raw.get("tests_failed", 0)),
            failure_assertions=list(raw.get("failure_assertions", [])),
            stdout_truncated=str(raw.get("stdout_truncated", ""))[:1024],
            stderr_truncated=str(raw.get("stderr_truncated", ""))[:1024],
            sandbox_id=sandbox_id,
        )

    def _build_clean_env(self) -> dict[str, str]:
        """Return an env dict stripped of host secrets.

        Keeps PATH, LANG, LC_ALL, TZ (so the subprocess behaves normally
        for the test harness). Strips everything else, including HOME
        (so the solution can't read redacted-credential-store/credentials, etc.) and
        every AWARE_* / PROVIDER_* / MODAL_* variable.
        """
        keep = {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "PYTHONIOENCODING"}
        return {k: v for k, v in os.environ.items() if k in keep}

    def _build_runner_source(
        self,
        solution_source: str,
        test_source: str,
        function_under_test: str | None,
    ) -> str:
        """Build the Python source for the in-sandbox runner.

        The runner is a self-contained script that:
        1. Removes forbidden builtins
        2. Installs an import hook that blocks FORBIDDEN_MODULES
        3. Executes the solution (catching ImportError → forbidden_import)
        4. Executes the tests (catching AssertionError → test_failure)
        5. Writes a JSON result file the parent can parse

        We use .format() with named placeholders rather than f-strings
        so we don't have to double-escape every literal brace in the
        runner source. f-strings in the previous version were a typo
        minefield (a stray `_import` instead of `import` cost us a
        turn of debugging).
        """
        if function_under_test is None:
            function_under_test = _infer_function_name(solution_source)

        # NOTE: this template uses {slot} placeholders. The only
        # literal braces in the output will be the ones we WANT in
        # the runner (dicts, f-strings inside the runner). Avoid
        # adding any new {} in the template body without thinking.
        template = _RUNNER_SOURCE_TEMPLATE
        return template.format(
            forbidden_modules_repr=repr(FORBIDDEN_MODULES),
            forbidden_builtins_repr=repr(FORBIDDEN_BUILTINS),
            solution_source_repr=repr(solution_source),
            test_source_repr=repr(test_source),
            function_under_test_repr=repr(function_under_test),
        )

    def _cleanup_scratch(self, scratch: Path) -> None:
        """Best-effort cleanup of the scratch dir.

        Never raises. A failed cleanup leaves a stale dir that the
        operator can clear with `rm -rf /tmp/azr-sandbox` periodically.
        """
        try:
            shutil.rmtree(scratch, ignore_errors=True)
        except Exception:
            pass


# -- Runner source template ------------------------------------------------
#
# This template is interpolated with .format() to produce the in-sandbox
# Python source. The slot names MUST match the keyword args in
# _build_runner_source. Literal { and } in the output body are written
# as {{ and }} in this template (the standard .format() escape).
#
# Adding a new slot:
#   1. Add the new {slot_name} placeholder in the body below
#   2. Add `slot_name=repr(...)` to the .format() call
#   3. Don't add new {{}} in the body unless you mean a literal brace

_RUNNER_SOURCE_TEMPLATE = '''\
import json
import sys
import traceback
import ast as _ast
import builtins
from collections import OrderedDict

FORBIDDEN_MODULES = {forbidden_modules_repr}
FORBIDDEN_BUILTINS = {forbidden_builtins_repr}

# --- 1. Build the solution's builtin scope (no module mutation) ------
# IMPORTANT: do NOT mutate the live `builtins` module. If we did, the
# runner itself would lose `exec`, `open`, etc. (they all resolve from
# `builtins` at call time). Instead, build a *copy* of the builtins
# dict with the forbidden entries removed, plus the wrapped __import__,
# and hand that copy to the solution via its namespace's `__builtins__`.
#
# The runner's own `exec`/`open` calls in this module's global scope
# continue to use the live (un-stripped) builtins.
import builtins as _runner_builtins  # local name to avoid shadowing

_solution_builtins = {{k: v for k, v in vars(_runner_builtins).items()
                       if k not in FORBIDDEN_BUILTINS}}

_orig_open = _runner_builtins.open
_orig_exec = _runner_builtins.exec
_orig_import = _runner_builtins.__import__

# --- 2. Wrap __import__ to block forbidden modules ---------------------
def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    top = name.split(".")[0]
    if name in FORBIDDEN_MODULES or top in FORBIDDEN_MODULES:
        raise ImportError(
            "Import of {{0!r}} is blocked by AWARE sandbox".format(name)
        )
    return _orig_import(name, globals, locals, fromlist, level)

# Install the safe import in the solution's builtin copy. The runner
# itself continues to use _orig_import directly.
_solution_builtins["__import__"] = _safe_import

# --- 3. Execute the solution ------------------------------------------
# The solution's namespace gets the stripped __builtins__ (no open, exec,
# eval, __import__, etc.). The runner's own exec/compile (above) is
# unaffected because it runs in the runner module's global scope.
_solution_ns = {{"__name__": "solution", "__builtins__": _solution_builtins}}
_result = {{
    "passed": False,
    "error_kind": "unknown",
    "error_message": "",
    "memory_peak_kb": 0,
    "tests_run": 0,
    "tests_failed": 0,
    "failure_assertions": [],
    "stdout_truncated": "",
    "stderr_truncated": "",
}}

_solution_src = {solution_source_repr}
try:
    exec(compile(_solution_src, "<solution>", "exec"),
         _solution_ns, _solution_ns)
except ImportError as _e:
    _result["error_kind"] = "forbidden_import"
    _result["error_message"] = str(_e)
except SyntaxError as _e:
    _result["error_kind"] = "syntax_error"
    _result["error_message"] = str(_e)
except Exception as _e:
    _result["error_kind"] = "runtime_error"
    _result["error_message"] = "{{0}}: {{1}}".format(type(_e).__name__, _e)

# --- 4. Execute the tests (only if solution loaded) -------------------
if _result["error_kind"] in ("unknown",):
    _fn = _solution_ns.get({function_under_test_repr})
    if _fn is None:
        _result["error_kind"] = "runtime_error"
        _result["error_message"] = (
            "function {{0!r}} not found in solution".format({function_under_test_repr})
        )
    else:
        _test_ns = {{
            "__name__": "test",
            "__builtins__": _solution_builtins,
            {function_under_test_repr}: _fn,
        }}
        _test_src = {test_source_repr}
        _tree = _ast.parse(_test_src)
        # Count assert statements as the test count.
        _asserts = [n for n in _tree.body
                    if isinstance(n, _ast.Assert)]
        _result["tests_run"] = len(_asserts)
        try:
            exec(compile(_test_src, "<test>", "exec"),
                 _test_ns, _test_ns)
        except AssertionError as _e:
            _result["error_kind"] = "test_failure"
            _result["error_message"] = str(_e) or "assertion failed"
            _result["tests_failed"] = 1
            try:
                _tb = _e.__traceback__
                _line = _tb.tb_lineno
                _src_line = _test_src.split(chr(10))[_line - 1]
                _result["failure_assertions"] = [
                    "line {{0}}: {{1}}".format(_line, _src_line.strip())
                ]
            except Exception:
                _result["failure_assertions"] = ["assertion failed"]
        except ImportError as _e:
            _result["error_kind"] = "forbidden_import"
            _result["error_message"] = str(_e)
        except Exception as _e:
            _result["error_kind"] = "runtime_error"
            _result["error_message"] = "{{0}}: {{1}}".format(type(_e).__name__, _e)
        else:
            _result["passed"] = True
            _result["error_kind"] = "passed"
            _result["error_message"] = ""

# --- 5. Memory peak (best-effort, POSIX only) -------------------------
try:
    import resource as _r
    _usage = _r.getrusage(_r.RUSAGE_SELF)
    _result["memory_peak_kb"] = _usage.ru_maxrss
except Exception:
    pass

# --- 6. Write the JSON result -----------------------------------------
# Use the saved original `open` (not the stripped __builtins__ one)
# since the runner needs file I/O; the solution namespace does not.
with _orig_open("_result.json", "w", encoding="utf-8") as _f:
    json.dump(_result, _f)
'''


# -- Convenience function -------------------------------------------------


def verify(
    solution_source: str,
    test_source: str,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    memory_mb: int = DEFAULT_MEMORY_MB,
    function_under_test: str | None = None,
) -> ExecutionResult:
    """One-shot verify. Spins up a default SandboxExecutor, runs once, cleans up.

    The default executor reuses a single scratch dir across calls (each
    call gets its own UUID subdir), so it's safe to call verify() in a
    loop without leaking file handles.
    """
    executor = SandboxExecutor(
        timeout_seconds=timeout_seconds,
        memory_mb=memory_mb,
    )
    return executor.run(
        solution_source=solution_source,
        test_source=test_source,
        function_under_test=function_under_test,
    )


# -- Helpers --------------------------------------------------------------


def _infer_function_name(solution_source: str) -> str:
    """Best-effort: find the first `def NAME(` in the solution source.

    Used when the caller doesn't specify function_under_test explicitly.
    Falls back to a magic name the test harness won't bind.
    """
    import ast
    try:
        tree = ast.parse(solution_source)
    except SyntaxError:
        return "__unknown_function__"
    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            return node.name
    return "__unknown_function__"


def _set_resource_limits() -> None:
    """Apply POSIX resource limits to the sandbox runner process.

    Called via preexec_fn in subprocess.run. POSIX only (no-op on
    Windows — Windows resource limits work differently and aren't
    worth the complexity for a feature that's only used in CI on
    Linux and on Modal's Linux containers).

    Limits applied:
      RLIMIT_CPU      — soft CPU time limit. Exceeding sends SIGXCPU,
                        which Python turns into a MemoryError or
                        RuntimeError. After the second hit, SIGKILL.
      RLIMIT_AS       — virtual address space. Prevents `x = "a" * 10**10`.
      RLIMIT_FSIZE    — max file size. Prevents `open(...).write(big)`.
      RLIMIT_NPROC    — max processes for this user. Prevents fork bombs.
      RLIMIT_NOFILE   — max open file descriptors.

    Note: RLIMIT_NPROC is per-UID on Linux, so it can interfere with
    the parent's process count. We keep max_processes=1 by default
    but make it configurable.
    """
    if sys.platform == "win32":
        return

    # CPU: 2x the wall-clock timeout gives the subprocess some slack
    # for Python startup, but the wall-clock timeout is still the
    # backstop.
    cpu_seconds = max(2, int(os.environ.get("AZR_SANDBOX_CPU_SECONDS", "10")))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))

    # Memory: get from env, default 128 MB
    memory_mb = int(os.environ.get("AZR_SANDBOX_MEMORY_MB", "128"))
    memory_bytes = memory_mb * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except (OSError, ValueError):
        # Some systems (e.g. macOS) don't allow RLIMIT_AS
        pass

    # File size: 4 MB
    file_size_bytes = 4 * 1024 * 1024
    try:
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_size_bytes, file_size_bytes))
    except (OSError, ValueError):
        pass

    # Open files: 32
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    except (OSError, ValueError):
        pass

    # Process count: 1 (or whatever's configured)
    max_procs = int(os.environ.get("AZR_SANDBOX_MAX_PROCESSES", "1"))
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (max_procs, max_procs))
    except (OSError, ValueError):
        # macOS doesn't support RLIMIT_NPROC
        pass

    # Ignore SIGPIPE so a write to a closed pipe doesn't kill the runner
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
