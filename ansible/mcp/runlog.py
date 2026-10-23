# SPDX-License-Identifier: GPL-3.0-or-later
"""Per-run log files for the MCP Ansible runners.

Each run streams its output to <root>/logs/<timestamp>-<label>.log while it is
still running, and repoints <root>/logs/latest.log at it, so that a
`tail -F logs/latest.log` left open in a terminal shows what the MCP tools are
doing instead of nothing at all until the run ends.

A run that carries secrets names them in `redact`. Its extra vars then reach
ansible-playbook through a private file instead of the command line, where any
user of the machine could read them in the process list, and the secrets are
masked in the log. The log directory and the logs are private to their owner.

Configuration comes from the environment:
  ANSIBLE_MCP_LOG_DIR  (optional) log directory, default <root>/logs
"""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable, NamedTuple

# Runs kept in the log directory; older ones are dropped as new runs start.
KEEP_LOGS = 50


class RunResult(NamedTuple):
    output: str
    returncode: int
    log_path: Path
    timed_out: bool


def redactor(redact: list[str] | None) -> Callable[[str], str]:
    """Replace known secret values wherever they appear on their way out."""
    values: set[str] = set()
    for value in redact or []:
        if value:
            # Inside the JSON of an -e argument the value is escaped.
            values.update((value, json.dumps(value)[1:-1], json.dumps(value, ensure_ascii=False)[1:-1]))
    ordered = sorted(values, key=len, reverse=True)
    if not ordered:
        return lambda text: text

    def hide(text: str) -> str:
        for value in ordered:
            text = text.replace(value, "********")
        return text

    return hide


def _shield(cmd: list[str]) -> tuple[list[str], list[str]]:
    """Move the inline extra vars of cmd into private files.

    Returns the command to execute and the files to remove once it has run.
    mkstemp creates them readable by their owner only.
    """
    shielded: list[str] = []
    files: list[str] = []
    for index, token in enumerate(cmd):
        if index and cmd[index - 1] == "-e" and not token.startswith("@"):
            fd, name = tempfile.mkstemp(prefix="ansible-mcp-", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(token)
            files.append(name)
            token = f"@{name}"
        shielded.append(token)
    return shielded, files


def _unlink(files: list[str]) -> None:
    for name in files:
        try:
            os.unlink(name)
        except OSError:
            pass


def _private(path: str, flags: int) -> int:
    return os.open(path, flags, 0o600)


def _slug(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", label).strip("_")[:60] or "run"


def log_dir(root: Path) -> Path:
    directory = Path(os.environ.get("ANSIBLE_MCP_LOG_DIR") or root / "logs")
    directory.mkdir(parents=True, exist_ok=True)
    try:
        # Logs record what was run and what it answered: owner only.
        directory.chmod(0o700)
    except OSError:
        pass
    return directory


def _prune(directory: Path) -> None:
    for stale in sorted(directory.glob("20*.log"), reverse=True)[KEEP_LOGS:]:
        try:
            stale.unlink()
        except OSError:
            pass


def _point_latest_at(path: Path) -> None:
    """Repoint logs/latest.log at this run, without ever leaving it missing."""
    tmp = path.parent / ".latest.log.tmp"
    try:
        tmp.unlink(missing_ok=True)
        tmp.symlink_to(path.name)
        os.replace(tmp, path.parent / "latest.log")
    except OSError:
        pass


def run_logged(
    cmd: list[str],
    root: Path,
    label: str,
    timeout: int | None = None,
    redact: list[str] | None = None,
) -> RunResult:
    """Run cmd, tee its output to a per-run log file, and return the result.

    The output is written line by line as it arrives, so the log file is
    readable while the playbook is still running. The values in redact are
    masked in the log and in the returned output.
    """
    directory = log_dir(root)
    _prune(directory)
    stamp = f"{datetime.now():%Y%m%d-%H%M%S}"
    path = directory / f"{stamp}-{_slug(label)}.log"
    # Two runs of the same thing within one second must not share a log file.
    attempt = 1
    while path.exists():
        attempt += 1
        path = directory / f"{stamp}-{_slug(label)}.{attempt}.log"

    chunks: list[str] = []
    killed = threading.Event()
    timer: threading.Timer | None = None

    hide = redactor(redact)
    # The command line goes in the log so a run can be reproduced by hand; with
    # secrets in it, the log shows it masked and the real one stays off argv.
    run_cmd, shield_files = cmd, []

    with open(path, "w", encoding="utf-8", errors="replace", opener=_private) as log:
        log.write(f"$ {shlex.join(hide(token) for token in cmd)}\n")
        if redact:
            log.write("# extra vars passed through a private file, secrets masked\n")
        log.write("\n")
        log.flush()
        _point_latest_at(path)

        try:
            if redact:
                run_cmd, shield_files = _shield(cmd)
            proc = subprocess.Popen(
                run_cmd,
                cwd=str(root),
                # Ansible leaves flushing to the system (see Display.display), so
                # over a pipe its output would only reach us in blocks: unbuffer it.
                env=dict(os.environ, PYTHONUNBUFFERED="1"),
                # The MCP server's own stdin is the JSON-RPC stream: never hand it
                # to a playbook that decides to prompt.
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                bufsize=1,
            )
        except BaseException:
            # Never leave the secrets file behind a command that did not start.
            _unlink(shield_files)
            raise

        if timeout:
            def _kill() -> None:
                killed.set()
                proc.kill()

            timer = threading.Timer(timeout, _kill)
            timer.start()

        try:
            for line in proc.stdout:
                line = hide(line)
                log.write(line)
                log.flush()
                chunks.append(line)
            returncode = proc.wait()
        finally:
            if timer:
                timer.cancel()
            proc.stdout.close()
            _unlink(shield_files)

        timed_out = killed.is_set()
        note = f" (timed out after {timeout}s)" if timed_out else ""
        log.write(f"\n--- exit code {returncode}{note} ---\n")

    return RunResult("".join(chunks), returncode, path, timed_out)
