# SPDX-License-Identifier: GPL-3.0-or-later
"""Command builders and runner backing the samba_dc MCP tools.

Configuration comes from the environment:
  ANSIBLE_PROJECT_ROOT  (required) directory the playbooks are run from
  ANSIBLE_MCP_INVENTORY (optional) explicit inventory path; when unset the
                        layout <root>/inventories/<name>/hosts.yaml is used
  ANSIBLE_MCP_DEFAULT_INVENTORY (optional) the <name> used when a call gives
                        none; without it, and without ANSIBLE_MCP_INVENTORY,
                        every call must name its inventory
  ANSIBLE_MCP_TIMEOUT   (optional) per-run timeout in seconds, default 3600 for a
                        build and 900 for a backup
  ANSIBLE_MCP_LOG_DIR   (optional) log directory, default <root>/logs
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from runlog import redactor, run_logged

# Playbooks shipped by the collection, keyed by MCP tool name.
PLAYBOOKS = {
    "samba_dc_build": "lineadicomando.samba_dc.samba_dc_build",
    "samba_dc_backup": "lineadicomando.samba_dc.samba_dc_backup",
}

# Seconds a run may take, per tool, unless ANSIBLE_MCP_TIMEOUT says otherwise:
# a build upgrades the system and reboots.
DEFAULT_TIMEOUTS = {"samba_dc_build": 3600, "samba_dc_backup": 900}

# Arguments that carry a secret, per tool. Their values never reach the command
# line, the run log or a preview.
SECRET_ARGS = {
    "samba_dc_build": ("administrator_passwd",),
    "samba_dc_backup": ("domain_password",),
}


def secret_values(tool: str, args: dict | None) -> list[str]:
    """The values of a call that must stay out of its log."""
    secrets = []
    for key in SECRET_ARGS.get(tool, ()):
        value = (args or {}).get(key)
        if value not in (None, ""):
            secrets.append(str(value))
    return secrets


def _project_root() -> Path:
    root = os.environ.get("ANSIBLE_PROJECT_ROOT")
    if not root:
        raise RuntimeError("ANSIBLE_PROJECT_ROOT environment variable is not set")
    return Path(root)


def _timeout(tool: str) -> int:
    try:
        return int(os.environ.get("ANSIBLE_MCP_TIMEOUT", DEFAULT_TIMEOUTS[tool]))
    except ValueError:
        return DEFAULT_TIMEOUTS[tool]


def _inventory_path(inventory: str | None) -> str:
    override = os.environ.get("ANSIBLE_MCP_INVENTORY")
    if override:
        return override
    name = inventory or os.environ.get("ANSIBLE_MCP_DEFAULT_INVENTORY")
    if not name:
        raise ValueError(
            "No inventory: pass 'inventory', or set ANSIBLE_MCP_INVENTORY or "
            "ANSIBLE_MCP_DEFAULT_INVENTORY in the server's environment"
        )
    if "/" in name or name.startswith("."):
        raise ValueError(f"Invalid inventory name: {name!r}")
    return str(_project_root() / "inventories" / name / "hosts.yaml")


def _build_command(
    tool: str,
    extra: dict,
    limit: str = "all",
    inventory: str | None = None,
) -> list[str]:
    cmd = ["ansible-playbook", PLAYBOOKS[tool], "-i", _inventory_path(inventory)]
    # The playbooks take their host pattern from target_hosts rather than from
    # --limit, so that they can also be run against a single host by name.
    if limit and limit != "all":
        extra = dict(extra, target_hosts=limit)
    if extra:
        cmd += ["-e", json.dumps(extra)]
    return cmd


def build_build_command(
    args: dict | None = None,
    limit: str = "all",
    inventory: str | None = None,
) -> list[str]:
    args = dict(args or {})
    confirmed = args.pop("force_provision_confirm", False) is True
    if args.get("force_provision") and not confirmed:
        raise ValueError(
            "force_provision destroys the existing domain: it also needs "
            "force_provision_confirm=true"
        )
    extra = {f"samba_dc_build_{key}": value for key, value in args.items()}
    return _build_command("samba_dc_build", extra, limit, inventory)


def build_backup_command(
    action: str,
    args: dict | None = None,
    limit: str = "all",
    inventory: str | None = None,
) -> list[str]:
    extra: dict = {"samba_dc_backup_action": action}
    for key, value in (args or {}).items():
        extra[f"samba_dc_backup_{key}"] = value
    return _build_command("samba_dc_backup", extra, limit, inventory)


def run_command(cmd: list[str], tool: str, label: str, redact: list[str] | None = None) -> str:
    """Run an ansible-playbook command, streaming its output to a log file.

    With redact, the extra vars go to ansible-playbook through a private file
    and the values listed are masked in the log and in the returned output.

    Bounded by ANSIBLE_MCP_TIMEOUT: a playbook waiting on a prompt would
    otherwise block the MCP server forever.
    """
    timeout = _timeout(tool)
    result = run_logged(cmd, _project_root(), label, timeout=timeout, redact=redact)
    output = result.output
    if result.timed_out:
        output += f"\n[timed out after {timeout}s and was terminated]"
    elif result.returncode != 0:
        output += f"\n[exit code {result.returncode}]"
    return f"{output}\n[log] {result.log_path}"


def format_command(cmd: list[str], redact: list[str] | None = None) -> str:
    hide = redactor(redact)
    cmd = [hide(token) for token in cmd]
    parts = []
    i = 0
    while i < len(cmd):
        token = cmd[i]
        if token in ("-e", "-i") and i + 1 < len(cmd):
            parts.append(f"{token} '{cmd[i + 1]}'")
            i += 2
        else:
            parts.append(token)
            i += 1
    return " \\\n  ".join(parts)
