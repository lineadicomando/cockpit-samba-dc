# TODO

Roadmap of `samba-tool` features not yet exposed by the module, checked against
Samba 4.22. Subcommand names and flags must be confirmed on the target version
(`samba-tool <cmd> --help`) before implementing: some were renamed across
releases (e.g. `ou create` → `ou add`, `computer create` → `computer add`).

Legend: `[ ]` planned · `[x]` done · `[?]` left out for now, future implementation to be decided

Order: the features from section 3 on. Section 0 collects the follow-ups of
the last review, small enough to take up at any time.

Each feature item (sections 3–8) also needs what `CLAUDE.md` lists under
"Adding things" (validators, parsers and tests, cache invalidation,
translations, README and `CHANGELOG.md` entries) and a check on the test DC
(skill `vm-lab`) before the commit.

## Where things stand

Updated on 2026-10-23.

- Features: users, groups, computers, home directories (H:), shared folders
  with POSIX ACLs and drive mapping through the "Cockpit - Mapped drives"
  GPO.
- Releases: `v0.1.0` published on 2026-10-22, the first one. The version
  comes from the git tag (`scripts/version.mjs`, shown next to the page
  title); `make release VERSION=x.y.z` dates `CHANGELOG.md`, commits and
  tags; pushing the tag runs `.github/workflows/release.yml`, which
  publishes the built module as `cockpit-samba-dc-X.Y.Z.tar.gz` and
  `cockpit-samba-dc_X.Y.Z_all.deb`. Rule and procedure: README, "Versions
  and releases".
- Debian package (section 2): `debian/` packages the built `dist/`; `make
  deb` builds it in a Debian 13 container and runs `lintian`; `lab.sh
  deploy` installs it on the test DC. Its first run on GitHub is at the
  next tag.
- Before that: a review of the code base and its fixes (commit `c28e04c`),
  checked on the test DC and Windows client; what was left open is in
  section 0.
- Test environment: two VMs, a Samba AD DC and a Windows 11 client joined
  to it, driven by `test/vm/` and configured by an untracked `.env` (see
  `.env.example`); skills `vm-lab` and `win-gui`. Left shut off at snapshot
  `lab_baseline`.

To resume: read `CLAUDE.md`, run `npm install && make check && npx tsc
--noEmit`; for anything touching `src/lib/`, follow the workflow of skill
`vm-lab` (`test/vm/lab.sh reset`, `start dc`, `deploy`). Next step:
section 3, account lockout and expiry.

## 0. Follow-ups of the October 2026 review

- [ ] **Stale share entries after a delete.** Deleting a user or group leaves
      it in `valid users` / `read list` of its shares, on purpose: removing
      the only entry would leave the list empty, which opens the share to
      every domain user. Show such entries as unknown in the share editor so
      the administrator can remove them, and list the affected shares in the
      delete confirmation.
- [ ] **Home directory after a user rename.** The folder
      (`/srv/samba/home/<old name>`) and `homeDirectory` keep the old name.
      Access still works (ownership follows the SID); decide whether to
      rename both.
- [ ] **`ensureHomeShare` remembers success for the whole session**
      (`src/lib/samba.ts`): a `home` share removed meanwhile is not created
      again until the page is reloaded.
- [ ] **`samba-tool ntacl sysvolreset` after every mapping change**
      (`src/lib/drivemaps.ts`): slow on a large sysvol and resets every GPO's
      ACLs; measure, and consider fixing only the module's GPO folder.
- [ ] **Nested groups** are not expanded when the user page shows a user's
      access to shared folders (`effectiveShareAccess`); smbd does expand
      them, so the page can show less access than the user has.
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

## 1. Versioning through git tags (done)

Done. The rule and the
procedure are in the README ("Versions and releases"): the build takes the
version from the tag, `make release` commits and tags, the `release.yml`
workflow publishes. The first release is `v0.1.0`.

- [x] **Define the rule** — semver, tag `vX.Y.Z` on `main` as the single
      source of truth; document it (README or `CONTRIBUTING.md`), including
      what counts as a breaking change while on `0.x`
- [x] **Derive the version from the tag** instead of hand-editing files
  - [x] `build.js` writes the version into `dist/manifest.json`
        (`git describe --tags`, with a fallback when building from a tarball
        without git metadata)
  - [x] Keep `package.json` aligned (a `make release VERSION=x.y.z` target, or
        `npm version`, that bumps, commits and tags)
- [x] **Show the version in the UI** so users can report it in bug reports
- [x] **Changelog** — `CHANGELOG.md` updated at each release
- [x] **Release workflow** — GitHub Actions job triggered by `v*` tags: type
      check, build, test, then publish a GitHub release with the build
      artifacts
- [x] **CI actions on Node 24** — `actions/checkout` and `actions/setup-node`
      moved from v4 (Node 20, deprecated by GitHub) to v7; use the same
      versions in the release workflow
- [x] **First tag** — `v0.1.0`
- [ ] Update the "Supported versions" table in `SECURITY.md` when it stops
      being just `0.x`

## 2. Debian package (done)

Done: the package carries the `dist/` built by `make build` (or by the
release workflow), since a Debian build environment does not download npm
dependencies. README, "Installation" and "Versions and releases".

- [x] **Add a tracked `debian/` directory**
  - [x] `control` — binary package `cockpit-samba-dc`, `Architecture: all`,
        `Depends:` `cockpit-bridge (>= 337)`, `samba-ad-dc (>= 2:4.22)`,
        `samba-common-bin`, `ldb-tools`, `acl` (checked on Debian 13)
  - [x] `changelog` — generated from the git tag (`scripts/debian.mjs`), not tracked
  - [x] `rules` — copy the built `dist/` into
        `/usr/share/cockpit/samba-dc`
  - [x] `copyright` (LGPL-2.1-or-later) and `source/format`
- [x] **Decide how `node_modules` is provided at build time** — the build
      needs npm dependencies, which a clean Debian build environment does not
      download; the package carries the `dist/` built beforehand, the same
      one as the release tarball
- [x] **Add a `deb` target to the tracked `Makefile`**, and have `lab.sh`
      install the package on the test DC instead of copying `dist/`
- [x] **Clean upgrade path** — the package must replace a previous
      `make install` or `lab.sh deploy` in the same directory without
      leaving stale files
- [x] **Build the `.deb` in CI** and attach it to the GitHub release, in
      `.github/workflows/release.yml` next to the tarball (also built and
      linted by `ci.yml` on every push)
- [x] **Check the result** — `lintian`, then install, upgrade and remove on
      the test DC (skill `vm-lab`)
- [x] Update the README installation section with the `.deb` instructions
- [?] RPM package for Fedora/RHEL-based servers — future implementation to be
      decided

## 3. Account lockout and expiry (high priority)

Small additions to the existing user page.

- [ ] **Unlock account** — `samba-tool user unlock <username>`
  - [ ] Read `lockoutTime` in the `ldbsearch` user query and expose a locked
        state on `User` (a non-zero `lockoutTime` is only a lock while the
        domain lockout duration has not elapsed)
  - [ ] "Locked" label in the users table and on the user detail page
  - [ ] "Unlock" action on the detail page and as a bulk action
  - [ ] "Locked only" filter in the users list
- [ ] **Account expiry** — `samba-tool user setexpiry <username> --days=N | --noexpiry`
  - [ ] Read `accountExpires` and show the expiry date on the detail page
  - [ ] Date picker converted to a number of days, plus "never expires"
  - [ ] "Expired" label in the users table
  - [ ] Bulk action (e.g. expire a whole class at the end of the school year)

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
      `--mail-address`; edit description on existing groups
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
