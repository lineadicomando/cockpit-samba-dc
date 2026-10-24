<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# MCP server

Exposes the collection's dispatcher playbooks as MCP tools, so an MCP-compatible
client (Claude, Cursor, …) can build and back up a domain controller from the
control node without shelling out to `ansible-playbook` by hand.

| Tool | Playbook | What it does |
|------|----------|--------------|
| `samba_dc_build` | `lineadicomando.samba_dc.samba_dc_build` | builds a DC (role `samba_dc_build`), with its variables from the inventory |
| `samba_dc_backup` | `lineadicomando.samba_dc.samba_dc_backup` | domain backup (online/offline) and destructive restore |

Users, groups, computers, home directories and shared folders are managed by
`addcctl mcp`, the MCP server that runs on the DC itself and is reached through
SSH (README of cockpit-samba-dc, "MCP server on the DC"); the `samba` tool
that ran the `samba` playbook for them is gone. A client uses both servers.

Every tool accepts `preview: true`, which returns the `ansible-playbook` command
line without running it. Use it before any destructive action.

## Requirements

```bash
pip install -r mcp/requirements.txt
```

The collection itself must be installed (or reachable through
`ANSIBLE_COLLECTIONS_PATH`), because the tools invoke playbooks by FQCN.

## Configuration

| Variable | Required | Meaning |
|----------|----------|---------|
| `ANSIBLE_PROJECT_ROOT` | yes | directory the playbooks are run from |
| `ANSIBLE_MCP_INVENTORY` | no | explicit inventory file; overrides the layout below |
| `ANSIBLE_MCP_DEFAULT_INVENTORY` | no | inventory name used when a call gives none |
| `ANSIBLE_MCP_TIMEOUT` | no | per-run timeout in seconds (default `3600` for a build, `900` for a backup) |
| `ANSIBLE_MCP_LOG_DIR` | no | per-run log directory (default `$ANSIBLE_PROJECT_ROOT/logs`) |

Each run streams its output to `<log dir>/<timestamp>-<label>.log` while the
playbook is still running, and repoints `<log dir>/latest.log` at it: a
`tail -F logs/latest.log` shows what the tools are doing in real time. The log
path is appended to every tool result. The newest 50 runs are kept.

The log directory and the logs are readable by their owner only. A call that
carries a secret — `args.administrator_passwd` of `samba_dc_build`,
`args.domain_password` of `samba_dc_backup` — hands its extra vars to `ansible-playbook` through a private
temporary file instead of the command line, and the secret is masked in the log,
in the tool result and in a `preview`.

Without `ANSIBLE_MCP_INVENTORY`, the `inventory` argument of each tool selects
`$ANSIBLE_PROJECT_ROOT/inventories/<inventory>/hosts.yaml`; when it is
omitted, `ANSIBLE_MCP_DEFAULT_INVENTORY` names it, and with neither the call
fails asking for one.

## Client configuration

```json
{
  "mcpServers": {
    "samba-dc-dc1": {
      "command": "ssh",
      "args": ["-T", "mcp@dc1.example.org", "sudo", "-n", "/usr/bin/addcctl", "mcp"]
    },
    "samba-dc": {
      "command": "python3",
      "args": ["/path/to/cockpit-samba-dc/ansible/mcp/server.py"],
      "env": {
        "ANSIBLE_PROJECT_ROOT": "/path/to/your/ansible/project",
        "ANSIBLE_MCP_INVENTORY": "/path/to/your/ansible/project/inventory.yaml"
      }
    }
  }
}
```

`server.py` imports `runner` as a sibling module, so it must be started as a
script from this directory (as above) rather than imported as a package.

## Notes

- The tools run playbooks with `become: true` on the domain controller; the
  connection user needs privilege escalation there.
- `samba_dc_build` with `force_provision: true` destroys the existing domain
  and requires `force_provision_confirm: true` in `args`.
- `samba_dc_backup` with `action: restore` rebuilds a DC from an archive and
  requires `restore_confirm: true` in `args`.
