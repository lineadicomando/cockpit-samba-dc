# Changelog

Changes that a user or an administrator would notice, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versions follow [Semantic Versioning](https://semver.org/) as described in
the README ("Versions and releases"). New entries go under
`[Unreleased]`; `make release` dates them.

## [Unreleased]

### Added

- The Ansible collection `lineadicomando.samba_dc`, until 0.7.0 in its own
  repository, is now in `ansible/` and has the version of the repository;
  each release also carries the built collection
  (`lineadicomando-samba_dc-X.Y.Z.tar.gz`).

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
