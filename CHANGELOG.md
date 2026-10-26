# Changelog

Changes that a user or an administrator would notice, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versions follow [Semantic Versioning](https://semver.org/) as described in
the README ("Versions and releases"). New entries go under
`[Unreleased]`; `make release` dates them.

## [Unreleased]

### Added

- **Organizational units** tab: the OUs and the default containers as a
  tree, with the users, groups and computers in each; create, rename, move
  and describe an OU, delete it (one that is not empty only after an
  explicit confirmation, with everything in it: computers with their DNS
  records). The default containers
  and the built-in accounts and groups are never moved, renamed or deleted.
- Users, groups and computers: their container as a column and a filter,
  an OU chosen when a user or group is created, a "Move" action (users also
  in bulk); the user page shows the container.
- `addcctl`: operations `ou list`, `ou get`, `ou create`, `ou set`, `ou
  delete` and `computer set` (description, OU), also as tools of `addcctl
  mcp`; `ou` on `group create`, `user set` and `group set` moves the
  account; `user`, `group` and `computer list` return the container.
- Collection: module `samba_ou`; `ou` moves an existing user, group or
  computer in `samba_user`, `samba_group` and `samba_computer`, and
  `samba_computer` changes the description of an existing account.

### Fixed

- English interface: the counts of locked users and the results of bulk
  unlock and expiry showed their translation keys.

### Breaking

- Collection: the `samba_tool` role no longer has the `ou` object (`list`,
  `listobjects`, `create`, `delete`, `absent`): use the module `samba_ou`.

## [0.11.0] - 2026-10-24

### Added

- **Domain** tab: the password and lockout policy of the domain, shown and
  edited (complexity, minimum length, history, minimum and maximum age,
  lockout threshold, duration and reset), with the checks of `samba-tool
  domain passwordsettings set`.
- **Domain** tab: fine-grained password policies (PSOs), listed, created,
  edited and deleted, with the users and groups they apply to; the user
  page names the policy that applies and checks a new password against it.
- `addcctl`: operations `domain set-password-policy`, `pso list`, `pso get`,
  `pso create`, `pso set`, `pso delete`, also as tools of `addcctl mcp`;
  `user get` returns the password policy that applies to the user.
- Collection: modules `samba_password_policy` and `samba_pso`.

## [0.10.0] - 2026-10-24

### Added

- A **Domain** tab: the domain at a glance (names, Samba version, functional
  levels, domain controllers, FSMO role owners, Samba processes), health
  checks run on demand with their output (`samba-tool dbcheck`, report only;
  `samba-tool ntacl sysvolcheck`, with a reset of the sysvol ACLs when it
  fails; `testparm -s`), and offline backups of the domain in
  `/var/backups/samba-dc`, readable by root only.
- `addcctl`: operations `domain info`, `domain check`, `domain sysvol-reset`,
  `backup list` and `backup create`, also as tools of `addcctl mcp`.
- Collection: module `samba_dc_info`, the domain and its backups.

### Changed

- Collection: `samba_dc_backup_targetdir` is optional; without it, or set to
  `/var/backups/samba-dc`, the offline domain backup is made by `addcctl`,
  as on the Cockpit page, and listed there.
- The `addcctl` package depends on `tdb-tools`: `samba-tool domain backup
  offline` needs its `tdbbackup`, which a DC does not have otherwise.
  `samba_dc_build` installs it too, and `backup create` says so when it is
  missing.

## [0.9.0] - 2026-10-24

### Added

- `addcctl`, a new Debian package: the command that runs the operations of
  the DC as JSON (users, groups, computers, home directories, shared folders,
  drive mapping, password policy), used by the page and by the Ansible
  collection (`addcctl schema`, `man addcctl`). `cockpit-samba-dc` depends
  on it.
- Collection: modules `samba_user`, `samba_group`, `samba_computer` and
  `samba_home`, on `addcctl`, with check mode and diff; `samba_user` also
  sets groups, expiry and renames, `samba_group` scope, category and renames,
  `samba_computer` pre-creates accounts.
- `addcctl mcp`: an MCP server on the DC, reached through SSH, with one tool
  per operation of `addcctl` and `"check": true` as preview; changes are
  logged to syslog without passwords; `--read-only` offers only the tools
  that change nothing (README, "MCP server on the DC").
- Collection: playbook `samba_dc_build` and the MCP tool of the same name,
  which builds a DC with the variables of the inventory (`preview` first;
  `force_provision` also needs `force_provision_confirm`).

### Changed

- The page reads and changes everything through `addcctl`. Shared folders
  save about twice as fast (on the test DC, 0.7 s instead of 1.5 s to create
  one with a mapped drive, 0.5 s instead of 1.25 s to change it); user and
  group changes take under half a second.
- Collection: `samba_share`, `samba_share_info` and the user, group,
  computer and home actions of `samba_tool` run `addcctl`, which
  `samba_dc_build` installs, so they make the same changes as the page; a
  change from the page and one from Ansible at the same moment no longer lose
  an update. `samba_dc_build` installs `addcctl` before creating its
  accounts.

### Removed

- Collection: the `samba` MCP tool. Users, groups, computers, home
  directories and shared folders are managed through `addcctl mcp` on the DC;
  add it to the MCP client's servers (README, "MCP server on the DC"). OUs
  are not in it yet: use the `samba` playbook. The collection's MCP server
  keeps the build and the backup.

### Fixed

- A user or group deleted and created again under the same name no longer
  gets the old account's uid or gid on its shared folders and home
  directory, which left its members without access: `addcctl` resolves them
  by SID, not through winbind's cache of names. `addcctl` depends on
  `winbind`.
- Collection: `samba_tool` `enable`, `disable` and `setprimarygroup` on a
  missing user fail instead of creating it with a random password, and a
  failure of `samba-tool` is no longer read as "no such user".

### Breaking

- Collection: `samba_dc_build` installs two packages, `addcctl` and the page;
  `samba_dc_build_cockpit_install: none` installs `addcctl` alone. The
  variables `samba_dc_build_cockpit_package_url`, `…_package_checksum` and
  `…_package_file` are replaced by `samba_dc_build_cockpit_release_url` and
  the list `samba_dc_build_cockpit_package_files`.
- Collection: `shares_dir` and `sam_ldb_path` of `samba_share` and
  `samba_share_info` accept only their defaults.
- Collection: `samba_tool_user` is removed, replaced by `samba_user`
  (`mail` and `job_title` are aliases of `email` and `title`; no
  `samba_tool_path` or `sam_ldb_path`).
- Collection: `samba_tool` loses `samba_tool_sam_ldb_path` and
  `samba_tool_home_share_params`; its home actions accept only `home_base:
  /srv/samba/home` and `share_name: home`, and ignore `home_group` (the folder's
  group is the user's login group).

## [0.8.0] - 2026-10-23

### Added

- The Ansible collection `lineadicomando.samba_dc`, until 0.7.0 in its own
  repository, is now in `ansible/` and has the version of the repository;
  each release also carries the built collection
  (`lineadicomando-samba_dc-X.Y.Z.tar.gz`).

### Fixed

- Collection: `samba_dc_build` manages `cockpit.socket` instead of
  `cockpit.service`, which stops when idle and was started again, reported
  as a change, on every run.

### Breaking

- Collection: `samba_dc_build` installs the Cockpit page from the Debian
  package of its own release, checksum verified, instead of building `main`
  on the DC (`samba_dc_build_cockpit_install: package`, the default;
  `source` and `none` are the alternatives). `samba_dc_build_cockpit_version`
  is now that release (`X.Y.Z`); a git revision to build goes into
  `samba_dc_build_cockpit_source_version`.

## [0.2.1] - 2026-10-23

### Fixed

- The Debian package is attached to the release again: the one of 0.2.0
  failed `lintian` (changelog lines over 80 columns), so 0.2.0 was tagged
  but not published.

## [0.2.0] - 2026-10-23

### Added

- Debian package (`cockpit-samba-dc_X.Y.Z_all.deb`) attached to each release,
  for Debian 13.
- Users: unlock accounts locked out after failed logons, from the user page,
  the row menu or as a bulk action; "Locked" label and filter.
- Users: account expiry date ("never" or the last day of use) on the user
  page and as a bulk action; "Expired" label and filter.

### Fixed

- The Refresh button of each list reads the server again, instead of data
  cached for up to a minute (a lockout or a change made outside the module
  did not show).
- The user page shows the shared folders reached through nested groups (a
  group that is a member of a group listed on the folder).
- Provisioning a home directory creates the `home` share again if it was
  removed while the page was open.
- Changing a drive mapping no longer resets the ACLs of every GPO in sysvol
  (`samba-tool ntacl sysvolreset`), which is slow on a large sysvol; it runs
  only when the GPO is created.

## [0.1.0] - 2026-10-22

### Added

- Users: list, create, reset password, enable and disable, delete, group
  membership, home directory (H:) provisioning.
- Groups: list, create, rename, delete, add and remove members.
- Shared folders under `/srv/samba/shares`, with read-only or read-write
  access for domain users and groups through POSIX ACLs, optionally mapped
  as a network drive at logon through the "Cockpit - Mapped drives" GPO.
- Computers: list, delete.
- Access to shared folders shown on the user page.
- Protection of built-in objects (Administrator, krbtgt, Domain Admins, …).
- Search and filters in every list; bulk actions on users.
- English and Italian interface; Cockpit light and dark themes.
- The module's version is shown next to the page title.
