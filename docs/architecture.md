# Architecture

How the project is built, and where it is going. The work that leads from the
first part to the second is planned in `TODO.md`, sections A1–A6; the table
at the end says how far it has got.

## Where it started

Two repositories managed the same Samba AD DC, each with its own copy of the
logic: this one, a Cockpit page whose TypeScript spawned `samba-tool`,
`ldbsearch`, `net conf` and `setfacl` through the Cockpit bridge, and
`ansible-collection-samba_dc`, whose Python modules and YAML tasks spawned
the same tools. What the two created on the server was the same by design
(home directories under `/srv/samba/home`, registry shares under
`/srv/samba/shares` with POSIX ACLs, the "Cockpit - Mapped drives" GPO), but
each side reimplemented it, so a change on one side had to be repeated on
the other, and the two drifted (the sysvol ACL handling of v0.2.0 is one
case). The collection also carried roles for Windows clients and the
defaults of one school lab.

## Today

The target below is reached (A1–A6): one repository, `addcctl` on the DC
with every operation of users, groups, computers, organizational units, home
directories, shared folders, drive mapping, DNS records, GPO links, the
password policy, the domain overview, health checks and backups, and the
setup check and provisioning of a new domain, and three interfaces on it:
the page, the collection's modules and `addcctl mcp`. What is left:

- The roadmap (`TODO.md`, from section 11) adds every new feature as
  operations of the core first, and fixes the interface that stays stable
  from 1.0.0 (section 13).

## Target

One project for the Samba DC, with the logic written once, on the DC, and
three thin interfaces on top of it.

```
                 ┌──────────────────────── the DC ──────────────────────────┐
 browser ──────► │ Cockpit page ──┐                                         │
                 │                │  argv + JSON on stdin/stdout            │
 control node ─► │ Ansible module ┼─► addcctl ──► samba Python bindings,    │
  (ansible)      │                │   (the core)   net conf, setfacl,       │
 MCP client ───► │ MCP server ────┘                sysvol                   │
  (over SSH)     └──────────────────────────────────────────────────────────┘
```

### The core

A Python package with a command, `addcctl` ("AD DC control"), installed on
the DC. The name does not start with `samba`: `samba-*` packages and
commands belong to Samba itself (Fedora already ships `samba-dc`,
`samba-dc-libs`, `samba-dc-provision`, `samba-tools`), and the core is a
project of its own, not part of Samba.


- **One operation, one subcommand**: `addcctl share set`, `user
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
  parsing `ldbsearch` output; the configuration through Samba's loadparm
  and the registry; no network query and no domain credentials.
- **One schema per operation** (JSON Schema, in the repository): the command
  validates its input against it, and the same file gives the MCP tool
  definitions, the TypeScript types and the options of the Ansible modules
  (their `argument_spec` and documentation; what only a module has, such as
  `state` or an alias, is added by the generator). A change of contract is made in one
  place; CI checks that the generated files are up to date.

### The interfaces

- **Cockpit**: the page calls `addcctl` with `cockpit.spawn` (still
  `superuser: "require"`, still no shell) and reads JSON. `src/lib/` keeps the
  cache, the hooks and the types, and loses the parsing of tool output.
- **Ansible**: modules that call the core on the target and map its result
  to `changed`, `diff` and `check_mode`. Roles keep provisioning
  (`samba_dc_build`: the host, then the domain through the core's `domain
  provision`, the same the page runs on a host with no domain) and backup
  (`samba_dc_backup`); day-two roles become thin wrappers of the modules.
- **MCP**, in two roles:
  - *day-two management* (users, groups, shares, …): `addcctl mcp`,
    an MCP server over stdio that runs on the DC and is reached through
    SSH (`ssh -T dc sudo -n addcctl mcp`, with a sudoers rule for that
    command alone). Its tools are the core's operations, generated from the
    schemas, with check mode as preview, but `domain provision` (once
    only, destructive if misused). No playbook, no output to parse.
  - *orchestration* (building a DC, backups across hosts): the MCP server
    that runs playbooks on the control node, as today, without the day-two
    tools.

### Packages and repository

One source tree, three artifacts, one version:

| Artifact | Contents | For |
|---|---|---|
| `addcctl` (`.deb`) | the core and `addcctl` | every DC managed by the project |
| `cockpit-samba-dc` (`.deb`, depends on `addcctl` of the same version) | the Cockpit page | DCs managed from a browser |
| `lineadicomando.samba_dc` (collection, in `ansible/`) | roles, modules, orchestration MCP | control nodes |

`samba_dc_build` installs the two packages of its own version from the
GitHub release (checksum verified), so a collection and the DC software it
installs always match; a build from source stays available for development.
A project that needs a DC and no browser installs `addcctl` alone.

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
| The collection in this repository, one version | A2 | done: v0.8.0; win_edulab takes the collection from here |
| Core: spike on shared folders and drive mapping, go/no-go | A3 | done: go; shared folders and drive mapping in `addcctl`, TypeScript types generated |
| Core: every other operation | A4 | done: users, groups, computers, home directories, password policy; Ansible modules on the core |
| MCP server on the DC | A5 | done: `addcctl mcp`, reached through SSH; the orchestration MCP keeps the build and the backup; an integration suite through the three interfaces |
| Roadmap rewritten for the new layout | A6 | done: sections 0 and 4–8 rewritten as operations of the core; the modules' options generated from the schemas; win_edulab on v0.9.0 with `addcctl mcp`; the old repository archived (2026-10-28); the name `cockpit-samba-dc` kept (2026-10-29) |
