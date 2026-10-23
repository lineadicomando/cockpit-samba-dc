# Changelog

Changes that a user or an administrator would notice, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
versions follow [Semantic Versioning](https://semver.org/) as described in
the README ("Versions and releases"). New entries go under
`[Unreleased]`; `make release` dates them.

## [Unreleased]

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
