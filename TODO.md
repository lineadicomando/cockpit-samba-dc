# TODO

The open work: the plan of the next releases and the `samba-tool` features
left out. Done sections move to `docs/history.md` once released (decisions,
measures, what was tried). Project layout and rules: `CLAUDE.md`; design:
`docs/architecture.md`.

Legend: `[ ]` planned · `[x]` done · `[?]` left out, to be decided

## The plan

Approved by the user on 2026-10-29: section 12 (v0.18.0), then 13
(v1.0.0); section 11 went into v0.17.1.

- Only the next release is planned: the headings of its sections end with
  its version (`— v0.18.0`). `make next-version` computes the version from
  the kinds of change under `[Unreleased]` in `CHANGELOG.md` and checks it
  against this plan (`scripts/plan.mjs`, `scripts/todo.mjs`): they must
  agree, the planned sections may have no open `[ ]` item, and only one
  version may be planned. Rule: README, "Versions and releases".
- After a release: move its sections to the end of `docs/history.md`
  (keeping the version in the heading), write the next version at the end
  of the next section's heading (`— v1.0.0` on 13 after v0.18.0), and
  update "Where things stand".
- A feature item also needs what `CLAUDE.md` lists under "Adding things"
  and a check on the test DC (skill `vm-lab`) before the commit. The core
  first (an operation of `addcctl`), then the page and the collection; the
  MCP tool comes with the operation (`"mcp": False` keeps one out).
- Subcommands and flags of `samba-tool` were checked on Samba 4.22.11 on
  2026-10-23; check again on the target before using one (`ou create` →
  `ou add`, `computer create` → `computer add` across releases).

## Where things stand

Updated on 2026-10-31. Last release v0.17.1 (the follow-ups of the setup
page, section 11 in `docs/history.md`). Next: section 12, whose first item
is a set of decisions to take with the user before any code.

To resume:

1. Read `CLAUDE.md` (and `CLAUDE.local.md` when present), then `npm install
   && make check && npx tsc --noEmit && make lint`, `node
   scripts/addcctl-types.mjs --check && python3 scripts/ansible-specs.py
   --check`, `(cd ansible && ansible-lint)`.
2. `gh run list --workflow ci.yml`: the last CI run passed.
3. `test/vm/lab.sh status`: with no test VMs on this workstation, build
   them (skill `vm-lab`, "Building"; ask the user first). A change to
   `core/`, `src/lib/` or `ansible/` is tried with the workflow of skill
   `vm-lab` (`reset`, `start dc`, `deploy`, the integration suite).
4. Release only when the user asks: CLAUDE.md, "Commands".

## 12. Import users from a CSV file — v0.18.0

Not a `samba-tool` command, but a frequent job whenever many people arrive
at once: dozens or hundreds of accounts, with their groups and OU, and
their passwords handed out on paper.

- [ ] **Decide with the user**, before writing code:
  - the format: UTF-8, separator `,` or `;` (what a spreadsheet in Italian
    writes) detected, a header row; the columns (`name`, `given_name`,
    `surname`, `password`, `groups` separated by `|`, `ou`, `email`,
    `description`, `must_change_password`) and which are required; names
    derived from given name and surname when `name` is missing (rule, and
    what to do with a name taken);
  - one operation or many calls: a core `user import` (one lock, one
    preview with `--check`, a result for each row, the passwords on stdin)
    or the page calling `user create` for each row through `mapLimit`
    (no new operation; about 0.2 s a call, serialized by the lock). An
    operation also gives Ansible and MCP the import;
  - the passwords: generated in the page (`passwordUtils.ts`), never by
    addcctl, which may not return a secret (rule 2); shown once, in a
    printable sheet and a CSV the browser saves, with a warning
- [ ] **Core** (if an operation): its schema (`writeOnly` passwords in the
      items), checks of every row before any change (names, groups and OUs
      that exist, duplicates in the file and in the directory), rows that
      exist already skipped or refused (an option), the home directory
      optional (`home provision`); tests with `FakeDirDc`
- [ ] **Page**: "Import" in the Users tab: the file, a preview table with
      each row's problems (`validators.ts`), the options (OU and groups
      for every row, must change at the next logon, home directories), the
      run with its progress, the result with the printable sheet; the
      cache dropped (rule 7)
- [ ] **Ansible / MCP**: the operation's tool comes with it; a module only
      if a playbook needs more than `samba_user` in a loop
- [ ] A step of the integration suite, tried in the browser with a file
      from a spreadsheet; README (features), `CHANGELOG.md` (`Added`)

## 13. Towards 1.0.0

Planned after v0.18.0. From 1.0.0 a breaking change raises the major
number (README, "Versions and releases"), so what is stable must be said
first.

- [ ] **The stable interface**, written in `docs/architecture.md`: the
      operations of `addcctl` and their schemas, the options of the
      collection's modules, the variables of its roles, what the module
      creates on the server (README, "Files and shares on the server").
      Before it, remove what is kept only for compatibility (e.g. the
      tombstone of `samba_tool_user` in `ansible/meta/runtime.yml`)
- [ ] **The test environment**: the VMs of every workstation built by the
      scripts (`lab.sh build`), the Windows client rebuilt from a fresh ISO
      before its evaluation ends (the date is in its `baseline` snapshot);
      the integration suite and a Windows logon (mapped drives, H:) on each
- [ ] **A fresh install, by the README alone**: a clean Debian 13, the
      packages, the setup page, a share mapped on a Windows client; the
      collection's README the same way with `samba_dc_build`
- [ ] `SECURITY.md`: the "Supported versions" table lists only `0.x`
- [ ] Decide with the user: publishing the collection on Ansible Galaxy
      (left for "when the project is more mature", `docs/history.md` A2); the 2-space files
      (`UsersPage.tsx`, `app.tsx`) to 4 spaces
- [ ] The release: `make release VERSION=1.0.0` (the plan must name it)

## Left out — future implementation to be decided

Not planned: outside the current scope of the module (a single-DC domain
managed by non-specialist administrators). Each entry can be reconsidered;
the note says what would make it worth doing.

| | Command | Why left out | Would be reconsidered if |
|---|---|---|---|
| [?] | Rename the home folder with the user (`user set` with `new_name`) | The folder works under its old name; a user logged on would lose H: until the next logon | Administrators ask for matching names (only the folders `home provision` made) |
| [?] | RPM package for Fedora/RHEL | Debian 13 is the target | A Fedora or RHEL DC is to be supported |
| [?] | `drs showrepl`, `drs replicate`, `drs kcc` | Meaningless with one DC | Multi-DC deployments are supported |
| [?] | `domain join`, `domain demote` | One-off, destructive, better done from a shell; a new domain is section 10 | Multi-DC deployments are supported |
| [?] | `fsmo transfer`, `fsmo seize` | Rare and risky; the owners are shown in the "Domain" overview (section 8) | Multi-DC deployments are supported |
| [?] | `domain level raise`, `domain schemaupgrade` | Irreversible | A guided upgrade procedure is wanted |
| [?] | `domain trust` | No use case with a single domain | Trusts with other domains are needed |
| [?] | `sites`, `sites subnet` | Single-site domain | Multi-site deployments are supported |
| [?] | `schema`, `dsacl` | Expert-only, easy to break the directory | An "advanced" section is added |
| [?] | `delegation`, `spn` | Only needed for service accounts and Kerberos delegation | Services integrated with AD need it |
| [?] | `service-account`, `domain kds` (gMSA) | Same as above | Same as above |
| [?] | `domain auth policy`, `domain auth silo`, `domain claim` | Advanced access control, requires functional level 2016 | Hardening of privileged accounts is in scope |
| [?] | `contact` | Address-book objects, no mail integration | A mail server uses the directory |
| [?] | `user addunixattrs`, `group addunixattrs` | The module relies on winbind ID mapping | RFC2307 attributes are needed for Linux clients |
| [?] | `user getpassword`, `user syncpasswords` | Exposes password material | Password sync to an external system is needed |
| [?] | `domain exportkeytab` | Writes key material to disk | Kerberized services need a keytab |
| [?] | `user sensitive` | Niche | Delegation is implemented |
| [?] | `domain tombstones expunge` | Maintenance detail, handled by Samba itself | A recycle-bin view for deleted objects is added |
| [?] | `gpo backup`, `gpo restore` | They go through SMB with domain credentials (rule 5); the domain backups (section 8) hold sysvol and the directory | Single GPOs must be moved between domains or restored alone |
| [?] | `gpo manage ...`, `gpo admxload` | Policies for Linux clients and ADMX templates, large surface | A full GPO editor is in scope |
| [?] | `dns zonecreate`, `dns zonedelete`, `dns cleanup` | Record editing covers the common cases | Reverse zones or extra zones are needed |
| [?] | `visualize` | Replication graphs, multi-DC only | Multi-DC deployments are supported |
