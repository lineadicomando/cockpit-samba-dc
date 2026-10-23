# TODO

Roadmap. First, sections A1–A6: one project with
`ansible-collection-samba_dc`, around a core shared by the Cockpit page,
Ansible and MCP (`docs/architecture.md`). Then the `samba-tool` features not
yet exposed (sections 3–8). Every subcommand and flag named in sections 3–8
was checked with `samba-tool <cmd>
--help` on the test DC (Samba 4.22.11) on 2026-10-23; check again on the
target before implementing, since some were renamed across releases (e.g.
`ou create` → `ou add`, `computer create` → `computer add`).

Legend: `[ ]` planned · `[x]` done · `[?]` left out for now, future implementation to be decided

Order: sections A1–A6 before any other item of this list, so that what
follows is written for the new layout (A6 rewrites it). Then section 8 (the
"Domain" tab, where section 4 puts the password policy), then sections 4, 5,
6 and 7 (7 waits for a decision on authentication). Section 0 collects the
follow-ups of the last review.

Versions: only the next release is planned. The heading of each section
that goes into it ends with its version (`— v0.2.0`), which it keeps once
released; the other sections have none. `make next-version` computes the
version from the kinds of change under `[Unreleased]` in `CHANGELOG.md` and
checks it against the plan: they must agree, and the planned sections may
have no open item. Items of section 0 go into whichever release comes next,
with no version of their own. Rule and procedure: README, "Versions and
releases".

Each feature item (sections 3–8) also needs what `CLAUDE.md` lists under
"Adding things" (validators, parsers and tests, cache invalidation,
translations, README and `CHANGELOG.md` entries) and a check on the test DC
(skill `vm-lab`) before the commit.

## Where things stand

Updated on 2026-10-23.

- Features: users (create, edit names, e-mail and account name, password,
  enable and disable, unlock, account expiry, delete, groups), groups,
  computers (list, delete), home directories (H:), shared folders with
  POSIX ACLs and drive mapping through the "Cockpit - Mapped drives" GPO.
  Tabs in `src/app.tsx`: Users, Groups, Shared folders, Computers.
- Releases: `v0.1.0` (2026-10-22, tarball only) and `v0.2.1`
  (2026-10-23, tarball and `.deb`); `v0.2.0` was tagged but not published,
  its package failing `lintian`. The version comes from the git tag; `make
  release` computes the next one, dates `CHANGELOG.md`, commits and tags;
  pushing the tag runs `.github/workflows/release.yml`, which publishes
  `cockpit-samba-dc-X.Y.Z.tar.gz` and `cockpit-samba-dc_X.Y.Z_all.deb`.
  Rule and procedure: README, "Versions and releases".
- Debian package (section 2, commit `f403bef`): `make deb` builds it in a
  Debian 13 container and runs `lintian`; `lab.sh deploy` installs it on
  the test DC. Tried on the test DC (install over a hand-made copy,
  upgrade, remove); the "Debian package" step of `ci.yml` passed on GitHub
  on 2026-10-23. CI builds the package of a build between releases; the
  changelog of a release is checked by a unit test (`test/debian.test.ts`),
  since only the release workflow packages it.
- Before that: a review of the code base and its fixes (commit `c28e04c`),
  checked on the test DC and Windows client; what was left open is in
  section 0.
- Plan (2026-10-23): one project with `ansible-collection-samba_dc`, the
  Windows roles moving to `ansible-collection-win_workman`; target and
  migration in `docs/architecture.md`, steps in sections A1–A6.
- Test environment: two VMs, a Samba AD DC and a Windows 11 client joined
  to it, driven by `test/vm/` and configured by an untracked `.env` (see
  `.env.example`); skills `vm-lab` and `win-gui`. Left shut off at snapshot
  `lab_baseline`. The Windows client is an evaluation edition (section 0,
  "Rebuild scripts").

To resume:

1. Read `CLAUDE.md`, then run `npm install && make check && npx tsc
   --noEmit`.
2. Check that the last CI run on GitHub passed (`gh run list --workflow
   ci.yml`).
3. For anything touching `src/lib/`, follow the workflow of skill `vm-lab`
   (`test/vm/lab.sh reset`, `start dc`, `deploy`); `deploy` needs podman or
   docker for `make deb` (the build image is made on first use).
4. Next step: section A1.

## A1. Windows roles and lab defaults out of the collection

In `ansible-collection-win_workman`, `ansible-collection-samba_dc` and
`ansible-win_edulab`; nothing changes in this repository.
`docs/architecture.md`, "Boundaries".

- [ ] **win_workman: a `domain` management role** merging `samba_win_join`
      and `samba_win_status`, as win_workman's `CLAUDE.md` asks (schema in
      `vars/`, `act_join`, `act_leave`, `act_status`, default `status`,
      `meta/mcp.yaml`, docs and catalog rows); variables
      `win_workman_domain_*`; the DNS step of win_edulab's
      `playbooks/samba_dc_join.yaml` moves into `act_join`
      (`win_workman_domain_dns_servers`); dependency `microsoft.ad`
- [ ] Try it on this project's Windows client with the test DC (skill
      `vm-lab`): status, leave, join again, then a domain logon
- [ ] **win_edulab**: `samba_dc_join.yaml` and the `samba_win_join_*`
      variables become the task `domain-join` and `win_workman_domain_*`;
      membership status through the win-workman MCP; its skills and docs
- [ ] **The collection**: remove the two roles,
      `playbooks/samba_win_status.yaml`, the `samba_win_status` MCP tool and
      the dependencies `microsoft.ad` and `ansible.windows`; the MCP
      `inventory` no longer defaults to `school` (required, or
      `ANSIBLE_MCP_INVENTORY`); no `lab_win` fallback; examples with
      neutral group names; README and `galaxy.yml` describe what the
      Cockpit page does (no DNS or service controls)
- [ ] Releases of win_workman and of the collection (breaking: roles
      removed); win_edulab pinned to both tags instead of `main`

## A2. The collection in this repository — v0.3.0

- [ ] Carry over the collection's open `TODO.md` items (the
      `samba_tool_user` bugs, the sanity ignore files) into section 0, and
      its changes since its last tag into `CHANGELOG.md`
- [ ] `git subtree add --prefix=ansible` of the collection's `main`, with
      its history; `ansible/galaxy.yml` stays at the collection root
- [ ] One version: `make release` writes it into `ansible/galaxy.yml`,
      `release.mjs verify` checks it, `release.yml` builds the collection
      tarball (`ansible-galaxy collection build ansible`) and attaches it.
      Not published on Ansible Galaxy for now (to reconsider when the
      project is more mature)
- [ ] CI: the collection's jobs (ansible-lint, `ansible-test sanity` and
      `units`, which need an `ansible_collections/lineadicomando/samba_dc`
      path) next to the existing ones
- [ ] `samba_dc_build` installs the Cockpit page from the release of its own
      version, checksum verified: `samba_dc_build_cockpit_install: package`
      (default), `source` (a git revision built on the DC, for development)
      or `none`; an optional URL or local path for sites without Internet
      access; it removes the working copy `/usr/local/src/cockpit-samba-dc`
- [ ] Docs: a README section on the collection (installed from
      `git+https://github.com/lineadicomando/cockpit-samba-dc.git#/ansible`:
      check the exact `ansible-galaxy` syntax); `ansible/README.md` for
      Galaxy; the collection's rules in `CLAUDE.md` (ansible-lint as the
      gate, SPDX headers, variable names); one `CHANGELOG.md`; licenses per
      directory (`ansible/LICENSE`)
- [ ] `test/vm` runs Ansible from the host against the test DC:
      `samba_dc_build` from `baseline` with the package install; `samba_tool`
      and `samba_share` on shares made in Cockpit, and back
- [ ] The old repository: a README pointing here (archived at the end of
      the plan, A6); win_edulab: `requirements.yaml`, the symlink under
      `ansible_collections/`, `.mcp.json`

## A3. Core: spike on shared folders and drive mapping

The most duplicated part (`src/lib/shares.ts`, `src/lib/drivemaps.ts`;
`ansible/plugins/module_utils/samba_share.py`). Ends with a decision.

- [ ] Python package and command `samba-dc-admin` (`core/`) with `share
      list|get|set|delete` and drive mapping, as in `docs/architecture.md`,
      "The core"; check on the target what the samba Python bindings cover
      (`SamDB`, the registry shares of `net conf`) and fall back to the
      tools where they do not
- [ ] The schemas of these operations, and the generator of TypeScript
      types, Ansible `argument_specs` and MCP tools, with a CI check that the
      generated files are up to date
- [ ] pytest tests; verbatim tool outputs as fixtures shared with the
      TypeScript tests (`test/fixtures/`)
- [ ] Debian source package with two binaries: `samba-dc-tools`, and
      `cockpit-samba-dc` depending on it (`= ${binary:Version}`); lintian
      clean
- [ ] `shares.ts` and `drivemaps.ts`, and the `samba_share` and
      `samba_share_info` modules, call the core; the modules fail with a
      clear message when `samba-dc-tools` is missing
- [ ] On the test DC: time to list and to save (cold and warm) against
      today's; a share made in Cockpit, changed with Ansible, and back; the
      mapped drive at a Windows logon
- [ ] **Go/no-go**, written here with the measures: on to A4, or stop at A2
      and keep two implementations

## A4. Core: every other operation

- [ ] One operation at a time: users, groups, computers, home directories,
      password policy (read), lockout and expiry; each with its schema and
      tests, and the TypeScript it replaces removed only once the core
      version is tried on the test DC
- [ ] Ansible modules per object (`samba_user`, `samba_group`,
      `samba_computer`, `samba_home`, …) on the core; `samba_tool` becomes a
      thin dispatcher of them; `samba_tool_user` goes
- [ ] `CLAUDE.md`: the non-negotiable rules refer to the core

## A5. MCP server on the DC

- [ ] `samba-dc-admin mcp` (stdio), tools generated from the schemas,
      `--check` as preview, secrets never in a result or a log
- [ ] Reached through SSH, with a sudoers rule for that command alone;
      documented in the README
- [ ] The orchestration MCP (playbooks on the control node) keeps
      `samba_dc_build` and `samba_dc_backup` and drops the day-two tools;
      win_edulab's `.mcp.json` lists both
- [ ] The integration suite of section 0 runs through the MCP tools and
      through the Cockpit page's operations

## A6. The roadmap in the new layout

- [ ] Rewrite sections 0 and 4–8 as operations of the core with their three
      interfaces; update "Where things stand", the migration table of
      `docs/architecture.md` and the README
- [ ] Archive `ansible-collection-samba_dc` on GitHub, once the plan is
      done (ask first: it is public)
- [?] Rename the repository: it keeps its name for now; to reconsider when
      the project is more mature (GitHub redirects the old name)

## 0. Follow-ups of the October 2026 review

- [ ] **Stale share entries after a delete.** Deleting a user or group leaves
      it in `valid users` / `read list` of its shares, on purpose: removing
      the only entry would leave the list empty, which opens the share to
      every domain user. Show such entries as unknown in the share editor so
      the administrator can remove them, and list the affected shares in the
      delete confirmation.
- [ ] **`registry shares` is not checked.** Samba's default is `no`, also on
      a DC; without it smbd should not serve the shares that `net conf`
      creates (home, shared folders): confirm on the test DC, then read it
      with `testparm` and warn on the Shared folders tab and before
      provisioning home directories.
- [ ] **Home directory after a user rename.** The folder
      (`/srv/samba/home/<old name>`) and `homeDirectory` keep the old name.
      Access still works (ownership follows the SID); decide whether to
      rename both.
- [x] **`ensureHomeShare` remembers success for the whole session**: the
      promise is now kept only while it runs, so the next provisioning checks
      the share again.
- [x] **`samba-tool ntacl sysvolreset` after every mapping change**: 0.7 s
      on the test DC (3 GPOs), more with every file in sysvol. A rewritten
      file now takes the attributes of the old one (`cp --attributes-only
      --preserve=mode,ownership,xattr`, which carries `security.NTACL`);
      the reset runs only for a new file. Checked with `sysvolcheck`, not yet
      with a Windows logon.
- [x] **Nested groups** are expanded on the user page
      (`expandNestedGroups`, from the members that `listGroups` reads).
- [ ] **Linter.** `validators.ts` carries an `eslint-disable` comment but
      ESLint is not set up: add a config, a script and a CI step;
      `src/lib/hooks.ts` mixes 2- and 4-space indentation.
- [ ] **Integration checks.** `test/vm/review-smoke.ts` covers only the review
      fixes; grow it into a suite run before each release (users, groups,
      home directories, shares, drive mapping), with cleanup of its data.
- [ ] **Rebuild scripts.** `test/vm/build-dc.sh` and `build-win.sh` record
      steps that were run by hand; they have not run end to end yet. Do it
      at the next rebuild of the VMs (the Windows client is an evaluation
      edition and expires).

## 1. Versioning through git tags (done) — v0.1.0

The tag `vX.Y.Z` on `main` is the only source of the version
(`scripts/version.mjs`): the build writes it into `dist/manifest.json` and
the page header, `make release` dates `CHANGELOG.md`, commits and tags, and
`release.yml` publishes on the tag. Rule and procedure: README, "Versions
and releases".

At 1.0.0, update the "Supported versions" table in `SECURITY.md`, which
lists only `0.x`.

## 2. Debian package (done) — v0.2.0

`debian/` packages the `dist/` built beforehand, since a Debian build
environment does not download npm dependencies: `debian/rules` only copies
it into `/usr/share/cockpit/samba-dc`. `scripts/debian.mjs` turns the tag
into the Debian version (`0.2.0+3.gabc1234` between releases) and writes
`debian/changelog`, which is not tracked. `debian/preinst` removes a
hand-made copy on first install. `make deb` = build + `deb-package`
(changelog, then `scripts/deb-container.sh`: `deb-binary` and `lintian` in
a Debian 13 container); `release.yml` attaches the `.deb`, `ci.yml` builds
it on every push. Depends: `cockpit-bridge (>= 337)`, `samba-ad-dc (>=
2:4.22)`, `samba-common-bin`, `ldb-tools`, `acl`. README, "Installation".

When a requirement is raised (Cockpit, Samba), raise the matching
`Depends:` in `debian/control` too.

- [?] RPM package for Fedora/RHEL-based servers — future implementation to be
      decided

## 3. Account lockout and expiry (done) — v0.2.0

User page "Account" section, row menu, bulk actions, "Locked" and "Expired"
labels and filters. README, "Account lockout and expiry". Tried on the test
DC on 2026-10-23 (lockout after failed SMB logons, unlock single and bulk,
expiry single and bulk, logon refused with `NT_STATUS_ACCOUNT_EXPIRED`).

- [x] **Unlock account** — `samba-tool user unlock <username>`; the locked
      state comes from `msDS-User-Account-Control-Computed` (UF_LOCKOUT),
      which Samba computes with the lockout duration, also through local
      `ldbsearch`
- [x] **Account expiry** — written as `accountExpires` with `ldbmodify` on
      `sam.ldb`, not with `samba-tool user setexpiry`, which also sets
      (`--noexpiry`) or clears (`--days`) "password never expires"; a date
      picker for the last day of use, plus "never"; not offered for system
      accounts

## 4. Password policy (high priority)

The policy is currently read-only (`domain passwordsettings show`) and only
three fields are parsed (`PasswordPolicy` in `src/lib/types.ts`).

- [ ] **Edit the domain policy** — `samba-tool domain passwordsettings set`
  - [ ] Extend `PasswordPolicy` and its parser: min/max password age, lockout
        threshold, lockout duration, reset-lockout-after
  - [ ] Settings form: `--complexity`, `--min-pwd-length`, `--history-length`,
        `--min-pwd-age`, `--max-pwd-age`, `--account-lockout-threshold`,
        `--account-lockout-duration`, `--reset-account-lockout-after`
  - [ ] Invalidate the cached policy (300 s TTL) after a change
  - [ ] Decide where it lives in the UI (new "Domain" tab, see section 8)
- [ ] **Fine-grained policies (PSO)** — `samba-tool domain passwordsettings pso`
  - [ ] List and detail: `pso list`, `pso show <name>`
  - [ ] Create, edit, delete: `pso create <name> <precedence>`, `pso set`, `pso delete`
  - [ ] Assign to users and groups: `pso apply`, `pso unapply`
  - [ ] Effective policy on the user detail page: `pso show-user <username>`
  - [ ] Make the password field in the create/reset modals validate against
        the effective policy rather than the domain one

## 5. Organizational units (high priority, largest change)

No OU support today: every object is created in the default container. This
touches the navigation of all sections, so it should be designed as a whole.

- [ ] **OU management** — `samba-tool ou`
  - [ ] Tree view: `ou list`, `ou listobjects <ou_dn>`
  - [ ] Create, rename, move: `ou add`, `ou rename`, `ou move`
  - [ ] Delete: `ou delete`, with an explicit confirmation for
        `--force-subtree-delete` on non-empty OUs
- [ ] **Move objects between OUs** — `user move`, `group move`, `computer move`
  - [ ] Single and bulk move from the list pages
- [ ] **Create inside an OU** — `--userou` on `user add`, `--groupou` on `group add`
- [ ] Show the OU as a column and filter in the users, groups and computers lists
- [ ] Protect built-in containers (`Domain Controllers`, `Users`, `Computers`)

## 6. Richer create and edit forms (medium priority)

- [ ] **Users** — more `user add` options in the create modal:
      `--must-change-at-next-login`, `--description`, `--mail-address`
- [ ] **Groups** — `group add` options: `--description`, `--group-scope`
      (Domain/Global/Universal), `--group-type` (Security/Distribution),
      `--mail-address`; edit description on existing groups (`samba-tool
      group edit` opens an editor: write `description` with `ldbmodify` on
      `sam.ldb`, as `src/lib/samba.ts` already does for `homeDirectory`)
- [ ] **Computers**
  - [ ] Detail page — `samba-tool computer show <name>`
  - [ ] Pre-create an account in a chosen OU — `samba-tool computer add`
  - [ ] Depends on section 5 for the OU selector

## 7. DNS and Group Policy (medium priority)

Both areas need a design decision first: these commands talk to the server
over RPC/SMB and normally require domain credentials, while the rest of the
module only runs as root against the local `sam.ldb`. Options to evaluate:
machine account credentials (`-P`), a prompt for an administrator password
fed through stdin (as `runSambaWithInput` already does), or direct local
access as done for the "Cockpit - Mapped drives" GPO.

- [ ] **Decide the authentication approach** for RPC-based commands
- [ ] **DNS** — `samba-tool dns`
  - [ ] Zones: `zonelist`, `zoneinfo`
  - [ ] Records: `query`, `add`, `delete`, `update` (A, AAAA, CNAME, PTR, TXT, SRV, MX)
  - [ ] Protect the records the domain depends on (`_msdcs`, `_ldap`, `_kerberos`, DC A records)
- [ ] **Group Policy** — `samba-tool gpo`
  - [ ] List and detail: `gpo listall`, `gpo show <gpo>`
  - [ ] Links: `gpo getlink`, `gpo setlink`, `gpo dellink`, `gpo listcontainers`
        (depends on section 5)
  - [ ] Backup and restore: `gpo backup`, `gpo restore`
  - [ ] Keep the module's own drive-mapping GPO out of destructive actions

## 8. Domain status and maintenance (medium priority, low effort)

A new, mostly read-only "Domain" tab.

- [ ] **Overview** — `domain level show`, `fsmo show`, `processes`; not
      `domain info`, a CLDAP network query that fails when Samba does not
      listen on loopback: read the same facts locally (rootDSE of `sam.ldb`,
      `testparm`), as `src/lib/exec.ts` does
- [ ] **Health checks** run on demand, with the raw output shown:
  - [ ] `samba-tool dbcheck` (report only; `--fix` is not exposed)
  - [ ] `samba-tool ntacl sysvolcheck`, with `sysvolreset` offered on failure
  - [ ] `testparm -s`
- [ ] **Backup** — `samba-tool domain backup offline --targetdir=<dir>`
  - [ ] Choose and validate the target directory, list existing backups
  - [ ] Long-running command: progress and error reporting
  - [ ] Document restore as a manual procedure (`domain backup restore`)

## Left out — future implementation to be decided

Not planned: outside the current scope of the module (a single-DC domain
managed by non-specialist administrators). Each entry can be reconsidered;
the note says what would make it worth doing.

| | Command | Why left out | Would be reconsidered if |
|---|---|---|---|
| [?] | `drs showrepl`, `drs replicate`, `drs kcc` | Meaningless with one DC | Multi-DC deployments are supported |
| [?] | `domain join`, `domain demote`, `domain provision` | One-off, destructive, better done from a shell | A guided setup wizard is wanted |
| [?] | `fsmo transfer`, `fsmo seize` | Rare and risky; only `fsmo show` is planned | Multi-DC deployments are supported |
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
| [?] | `gpo manage ...`, `gpo admxload` | Policies for Linux clients and ADMX templates, large surface | A full GPO editor is in scope |
| [?] | `dns zonecreate`, `dns zonedelete`, `dns cleanup` | Record editing covers the common cases | Reverse zones or extra zones are needed |
| [?] | `visualize` | Replication graphs, multi-DC only | Multi-DC deployments are supported |
