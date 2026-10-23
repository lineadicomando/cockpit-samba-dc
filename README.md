# cockpit-samba-dc

[![version](https://badgen.net/github/tag/lineadicomando/cockpit-samba-dc)](https://github.com/lineadicomando/cockpit-samba-dc/tags)
[![license](https://badgen.net/static/license/LGPL%20v2.1/blue)](./LICENSE)
[![CI](https://github.com/lineadicomando/cockpit-samba-dc/actions/workflows/ci.yml/badge.svg)](https://github.com/lineadicomando/cockpit-samba-dc/actions/workflows/ci.yml)
[![open issues](https://badgen.net/github/open-issues/lineadicomando/cockpit-samba-dc)](https://github.com/lineadicomando/cockpit-samba-dc/issues)

Cockpit module for managing a Samba Active Directory Domain Controller via `samba-tool`.

![Screenshot](docs/screenshot.png)

## Features

- **Users** — list, create, edit (first and last name, e-mail, account name), reset password, enable/disable, unlock accounts locked out after failed logons, account expiry date, delete, group membership and primary group, home directory (H:) provisioning; bulk enable, disable, unlock, set expiry, delete, add to or remove from a group, change primary group, provision home directories
- **Groups** — list, create, rename, delete, member management (add/remove)
- **Shared folders** — create, edit and delete folders shared with domain users and groups (read-only or read-write), optionally mapped as a network drive at logon on Windows clients; each user's access is shown on the user page
- **Computers** — list, delete
- Automatic protection of built-in system objects (Administrator, krbtgt, Domain Admins, etc.)
- Live search and filters in every section (users also by locked out and expired)
- English and Italian interface, following Cockpit's language
- Full support for Cockpit light/dark theme
- The installed version is shown next to the page title

## Tech stack

| Component | Version |
|---|---|
| Debian (target) | 13 |
| Cockpit | 337 |
| Samba | 4.22 |
| React | 18.3 |
| PatternFly | 6.4 |
| TypeScript | 5.9 |
| esbuild | 0.28 |
| Node.js (build and tests) | 22 |

## Requirements

On the server, a Samba Active Directory domain controller with:

- Cockpit ≥ 337
- Samba 4.22, with `samba-tool` at `/usr/bin/samba-tool` (the page is shown
  only when it is there)
- `ldbsearch` and `ldbmodify` (package `ldb-tools`), `net` and `testparm`
  (`samba-common-bin`), `setfacl` (`acl`); the Debian package depends on
  all of them
- `registry shares = yes` (or `include = registry`) in the `[global]`
  section of `smb.conf`, for the home and shared-folder shares that the
  module creates with `net conf`. Samba's default is `no`, also on a domain
  controller: check with
  `testparm -s --parameter-name="registry shares"`, and set it when
  provisioning (`samba-tool domain provision --option="registry shares =
  yes"`) or add it to `smb.conf` and restart `samba-ad-dc`

To build from the sources:

- Git and Make
- Node.js ≥ 22.6 with npm (the unit tests use `--experimental-strip-types`)
- podman or docker, to build the Debian package (`make deb`)

## Installation

On Debian 13, install the package attached to each release on the
[Releases page](https://github.com/lineadicomando/cockpit-samba-dc/releases)
(from the release after 0.1.0), `cockpit-samba-dc_X.Y.Z_all.deb`; apt brings
in what it needs (`cockpit-bridge`, `samba-ad-dc`, `ldb-tools`, `acl`):

```bash
sudo apt install ./cockpit-samba-dc_X.Y.Z_all.deb
```

Upgrade the same way, with the newer package; `sudo apt remove
cockpit-samba-dc` removes the module. On first install the package replaces
a copy made by hand in `/usr/share/cockpit/samba-dc` (`make install` or the
tarball below). A copy in a user's `~/.local/share/cockpit/samba-dc` (`make
devel-install`) still hides the installed module from that user: remove it.

Each release also has the built module, `cockpit-samba-dc-X.Y.Z.tar.gz`, for
other distributions; it needs no Node.js on the server:

```bash
sudo rm -rf /usr/share/cockpit/samba-dc
sudo tar -C /usr/share/cockpit -xzf cockpit-samba-dc-X.Y.Z.tar.gz
```

Or build it from the sources:

```bash
git clone https://github.com/lineadicomando/cockpit-samba-dc.git
cd cockpit-samba-dc
npm install
sudo make install
```

Either way the module is in `/usr/share/cockpit/samba-dc`, and the
installed version is shown next to the page title.

## Development

```bash
# Install dependencies
npm install

# Build
make build

# Install by copying dist/ into production cockpit (/usr/share/cockpit/samba-dc)
sudo make install

# Install as symlink into local cockpit (development shortcut)
make devel-install

# Run unit tests and the type check
make check
npx tsc --noEmit

# Debian package in build/ (Debian 13 container: podman or docker)
make deb

# Watch mode (auto-rebuild on save)
make watch
```

## Versions and releases

Versions follow [Semantic Versioning](https://semver.org/). A release is a
tag `vX.Y.Z` on `main`, and the tag is the only source of the version: the
build reads it with `git describe` and writes it into `dist/manifest.json`
and the page header. A build between two releases shows the distance from
the last tag (`0.2.0-3-gabc1234`, `-dirty` with uncommitted changes); a
build without git metadata uses the version in `package.json`.

While the version is `0.x`, the minor number goes up for new features and
for breaking changes, the patch number for fixes only. A breaking change is
one that asks the administrator to act on upgrade: what the module creates
on the server changes (paths under `/srv/samba`, share settings, the GPO),
a requirement is raised (Cockpit, Samba, Debian), or a feature is removed.
From `1.0.0` breaking changes raise the major number.

The version is computed, not chosen. Each change goes under `[Unreleased]`
in `CHANGELOG.md`, under the heading of its kind: `Added`, `Changed`,
`Deprecated` (features), `Removed`, `Breaking` (changes that ask the
administrator to act), `Fixed`, `Security` (fixes). `TODO.md` plans the next
release: the headings of the sections that go into it end with its version
(`— v0.2.0`). The two must agree, and the planned sections may have no open
item; a release with fixes only needs no plan.

```bash
make next-version             # the computed version, the plan, what is missing
make release                  # checks, dates the changelog, commits, tags
git push origin main vX.Y.Z   # the tag starts the release workflow
```

`make release VERSION=X.Y.Z` only goes higher than the computed version (for
`1.0.0`, say), and the plan in `TODO.md` must name it too.

The release workflow checks the tag against `package.json` and
`CHANGELOG.md`, builds and tests, and publishes a GitHub release with the
built module (tarball and Debian package) and the changelog entries as
notes.

The Debian package carries the `dist/` that `make build` produced: the
build needs npm dependencies, which a Debian build environment does not
download, so `debian/rules` only copies `dist/` into place. `make deb`
builds `dist/`, writes `debian/changelog` from the tag (it is not tracked),
and packages it in a Debian 13 container, where `lintian` checks the
result; on Debian with `debhelper`, `make deb-changelog deb-binary` does the
same without a container. A build between releases gets a version such as
`0.2.0+3.gabc1234`, which sorts after `0.2.0` and before the next release.

## Files and shares on the server

Everything the module creates on disk lives under `/srv/samba`:

| Path | Share | Contents |
|---|---|---|
| `/srv/samba/home/<user>` | `home` (hidden) | Home directories, mapped as `H:` through the user's `homeDrive`/`homeDirectory` |
| `/srv/samba/shares/<name>` | `<name>` | Shared folders |

Shared folders are registry shares (`net conf`). Access is enforced by the
share (`valid users`, plus `read list` for read-only entries) and by a POSIX
ACL on the folder tree, the same model used for home directories: Samba's
`acl_xattr` derives the Windows ACL from it. Only shares whose path is under
`/srv/samba/shares` are listed and managed by the module.

### Account lockout and expiry

An account is shown as locked out when Samba reports it in
`msDS-User-Account-Control-Computed`, which accounts for the lockout duration
of the domain (or of the user's password settings object); "Unlock" runs
`samba-tool user unlock`. Lockouts happen only when the domain has a lockout
threshold (`samba-tool domain passwordsettings show`).

The expiry date is the last day the account can be used: the module writes
`accountExpires` as midnight at the end of that day, in the browser's time
zone, directly to `sam.ldb`. It does not use `samba-tool user setexpiry`,
which also turns "password never expires" on (`--noexpiry`) or off
(`--days`). System accounts (Administrator, krbtgt, Guest) cannot be given an
expiry date.

### Network drive mapping

A shared folder can be mapped as a network drive at logon for the same users
and groups that can access it. The module keeps a dedicated GPO,
**Cockpit - Mapped drives**, linked to the domain root: its Group Policy
Preferences `Drives.xml` holds one drive per mapped folder, targeted at the
folder's users and groups. The GPO is created on first use directly in the
local `sam.ldb` and sysvol, so no domain credentials are needed; after each
change the GPO version is increased and the sysvol ACLs are reset
(`samba-tool ntacl sysvolreset`).

Drive mapping applies to Windows clients; drive letters E–Z are available
(H is reserved for home directories). Clients pick up changes at the next
logon or `gpupdate`.

## Privilege escalation

Commands run through `cockpit.spawn` with `superuser: "require"`: the
Cockpit user needs administrative access (Cockpit's "Administrative access"
switch, through sudo or polkit). There is no `sudo` and no shell in the
command arguments, and passwords reach `samba-tool` on standard input, not
on its command line.

## License

Same license as the Cockpit project: **GNU LGPL v2.1 or later** (`LGPL-2.1-or-later`).
See [LICENSE](./LICENSE).

## Author

Alessandro Gagliano — [lineadicomando.it](https://lineadicomando.it)
