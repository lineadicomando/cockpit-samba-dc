# Architecture

How the project is built, and where it is going. The work that leads from the
first part to the second is planned in `TODO.md`, sections A1–A6; the table
at the end says how far it has got.

## Today

Two repositories manage the same Samba AD DC, each with its own copy of the
logic:

| | cockpit-samba-dc (this repository) | ansible-collection-samba_dc |
|---|---|---|
| Interface | Cockpit page, in the browser | Ansible roles and modules, MCP server |
| Logic | TypeScript in `src/lib/`, spawning `samba-tool`, `ldbsearch`, `net conf`, `setfacl` through the Cockpit bridge | Python modules (`samba_share`, `samba_tool_user`) and YAML tasks (`samba_tool`), spawning the same tools |
| Runs on | the DC (commands), the browser (logic) | the DC (modules), the control node (playbooks, MCP) |

What the two create on the server is the same by design: home directories
under `/srv/samba/home`, registry shares under `/srv/samba/shares` with POSIX
ACLs, the "Cockpit - Mapped drives" GPO. Each side reimplements it, so a
change on one side has to be repeated on the other, and the two drift (the
sysvol ACL handling of v0.2.0 is one case).

The collection also carries things that are not about the DC: two roles that
run on Windows clients (`samba_win_join`, `samba_win_status`) and defaults of
one school lab (the `school` inventory, the `lab_win` group).

## Target

One project for the Samba DC, with the logic written once, on the DC, and
three thin interfaces on top of it.

```
                 ┌──────────────────────── the DC ────────────────────────┐
 browser ──────► │ Cockpit page ──┐                                       │
                 │                │  argv + JSON on stdin/stdout           │
 control node ─► │ Ansible module ┼─► samba-dc-admin ─► samba Python       │
  (ansible)      │                │   (the core)        bindings, net conf,│
 MCP client ───► │ MCP server ────┘                     setfacl, sysvol    │
  (over SSH)     └────────────────────────────────────────────────────────┘
```

### The core

A Python package with a command, `samba-dc-admin`, installed on the DC:

- **One operation, one subcommand**: `samba-dc-admin share set`, `user
  unlock`, `home provision`, … Input is JSON on stdin, output is JSON on
  stdout; errors are a JSON object and a non-zero exit code, with English
  messages shown as they are.
- **Check mode and diff**: every mutation can run with `--check`, which
  reports what would change without changing it. Ansible's check mode and
  the MCP preview both use it.
- **The rules of `CLAUDE.md` move here**: no shell (argv only), secrets on
  stdin and never in argv or in the output, names validated before they
  reach a command, recursive changes only under the paths the project
  creates, a share never left open to every user, local reads only.
- **Local access**: the directory through the samba Python bindings
  (`SamDB` on `sam.ldb`, what `samba-tool` itself uses) rather than by
  parsing `ldbsearch` output; the configuration through `testparm` and the
  registry; no network query and no domain credentials.
- **One schema per operation** (JSON Schema, in the repository): the command
  validates its input against it, and the same file generates the Ansible
  `argument_specs`, the MCP tool definitions and the TypeScript types. A
  change of contract is made in one place; CI checks that the generated
  files are up to date.

### The interfaces

- **Cockpit**: the page calls `samba-dc-admin` with `cockpit.spawn` (still
  `superuser: "require"`, still no shell) and reads JSON. `src/lib/` keeps the
  cache, the hooks and the types, and loses the parsing of tool output.
- **Ansible**: modules that call the core on the target and map its result
  to `changed`, `diff` and `check_mode`. Roles keep provisioning
  (`samba_dc_build`) and backup (`samba_dc_backup`); day-two roles become
  thin wrappers of the modules.
- **MCP**, in two roles:
  - *day-two management* (users, groups, shares, …): `samba-dc-admin mcp`,
    an MCP server over stdio that runs on the DC and is reached through
    SSH (`ssh -T dc sudo -n samba-dc-admin mcp`, with a sudoers rule for that
    command alone). Its tools are the core's operations, generated from the
    schemas, with check mode as preview. No playbook, no output to parse.
  - *orchestration* (building a DC, backups across hosts): the MCP server
    that runs playbooks on the control node, as today, without the day-two
    tools.

### Packages and repository

One source tree, three artifacts, one version:

| Artifact | Contents | For |
|---|---|---|
| `samba-dc-tools` (`.deb`) | the core and `samba-dc-admin` | every DC managed by the project |
| `cockpit-samba-dc` (`.deb`, depends on `samba-dc-tools` of the same version) | the Cockpit page | DCs managed from a browser |
| `lineadicomando.samba_dc` (collection, in `ansible/`) | roles, modules, orchestration MCP | control nodes |

`samba_dc_build` installs the two packages of its own version from the
GitHub release (checksum verified), so a collection and the DC software it
installs always match; a build from source stays available for development.
A project that needs a DC and no browser installs `samba-dc-tools` alone.

### Boundaries

- **In**: everything that runs on the DC or manages it: provisioning,
  directory objects, home directories, shared folders, drive mapping, backup,
  the Cockpit page, the MCP servers.
- **Out, in `ansible-collection-win_workman`**: what runs on Windows
  clients, joining the domain and reporting membership included.
- **Out, in `ansible-win_edulab`**: what belongs to one school lab:
  inventories, group names, test VMs of the lab, acceptance tests.

### Licenses

Per file, declared with SPDX headers: the Cockpit page and the core under
`LGPL-2.1-or-later`, the Ansible collection under `GPL-3.0-or-later` (as it
is today). Code under LGPL-2.1-or-later can be used by GPL-3.0 code, so the
collection may import the core.

## Migration

| Step | `TODO.md` | State |
|---|---|---|
| Windows roles and lab defaults out of the collection | A1 | done: win_workman v0.3.0, collection v0.7.0 |
| The collection in this repository, one version | A2 | in progress: imported, one version and CI; test on the DC, release v0.8.0 left |
| Core: spike on shared folders and drive mapping, go/no-go | A3 | planned |
| Core: every other operation | A4 | planned |
| MCP server on the DC | A5 | planned |
| Roadmap rewritten for the new layout | A6 | planned |
