# cockpit-samba-dc

[![version](https://badgen.net/github/tag/lineadicomando/cockpit-samba-dc)](https://github.com/lineadicomando/cockpit-samba-dc/tags)
[![license](https://badgen.net/static/license/LGPL%20v2.1/blue)](./LICENSE)
[![CI](https://github.com/lineadicomando/cockpit-samba-dc/actions/workflows/ci.yml/badge.svg)](https://github.com/lineadicomando/cockpit-samba-dc/actions/workflows/ci.yml)
[![open issues](https://badgen.net/github/open-issues/lineadicomando/cockpit-samba-dc)](https://github.com/lineadicomando/cockpit-samba-dc/issues)

Cockpit module for managing a Samba Active Directory Domain Controller via
`samba-tool`, and the Ansible collection `lineadicomando.samba_dc` that
provisions the DC and manages it from playbooks (in [`ansible/`](ansible/README.md)).

![Screenshot](docs/screenshot.png)

## Features

- **Users** — list, create, edit (first and last name, e-mail, account name), reset password, enable/disable, unlock accounts locked out after failed logons, account expiry date, delete, group membership and primary group, home directory (H:) provisioning; bulk enable, disable, unlock, set expiry, delete, add to or remove from a group, change primary group, provision home directories
- **Groups** — list, create, rename, delete, member management (add/remove)
- **Shared folders** — create, edit and delete folders shared with domain users and groups (read-only or read-write), optionally mapped as a network drive at logon on Windows clients; each user's access is shown on the user page
- **Computers** — list, delete
- **Domain** — overview (domain and NetBIOS names, Samba version, functional levels, domain controllers, FSMO role owners, Samba processes), health checks run on demand with their output (`samba-tool dbcheck`, report only; `samba-tool ntacl sysvolcheck`, with a reset of the sysvol ACLs offered when it fails; `testparm -s`), offline backups of the domain
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
  (`samba-common-bin`), `setfacl` (`acl`), Python 3 with Samba's bindings
  (`python3-samba`, for `addcctl`); the Debian packages depend on all of
  them
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

On Debian 13, install the two packages attached to each release on the
[Releases page](https://github.com/lineadicomando/cockpit-samba-dc/releases):
`addcctl_X.Y.Z_all.deb`, the command the page runs on the DC for the shared
folders and the drive mapping (also used by the Ansible collection), and
`cockpit-samba-dc_X.Y.Z_all.deb`, the page, which depends on `addcctl` of the
same version. apt brings in what they need (`cockpit-bridge`, `samba-ad-dc`,
`python3-samba`, `ldb-tools`, `acl`):

```bash
sudo apt install ./addcctl_X.Y.Z_all.deb ./cockpit-samba-dc_X.Y.Z_all.deb
```

Upgrade the same way, with the newer packages; `sudo apt remove
cockpit-samba-dc addcctl` removes them. On first install the package replaces
a copy made by hand in `/usr/share/cockpit/samba-dc` (`make install` or the
tarball below). A copy in a user's `~/.local/share/cockpit/samba-dc` (`make
devel-install`) still hides the installed module from that user: remove it.

Each release also has the built module, `cockpit-samba-dc-X.Y.Z.tar.gz`, for
other distributions; it needs no Node.js on the server, but its shared
folders need `addcctl` (the package, or `sudo make install` from the
sources):

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
installed version is shown next to the page title. `make install` also
installs `addcctl` (`/usr/lib/addcctl` and `/usr/bin/addcctl`).

### addcctl

`addcctl` runs one operation per call, as root, reading a JSON object on
standard input and writing one on standard output; `addcctl schema` lists the
operations with the JSON Schema of their input, `--check` reports what an
operation would change without changing it, and `man addcctl` describes it.
It reads the configuration and the directory locally (Samba's loadparm,
`sam.ldb`), so it needs no domain credentials, and runs one change at a time,
so the page and the Ansible collection can be used at the same moment. It
handles users, groups, computers, home directories, shared folders, the drive
mapping and the password policy (read), for the page, the collection and the
MCP server below (`docs/architecture.md`).

### MCP server on the DC

`addcctl mcp` is an MCP server on standard input and output, for an MCP
client (Claude, Cursor, …) that manages the DC: one tool per operation of
`addcctl` (`user_create`, `share_set`, …, the list is `addcctl schema`), with
the same input. A tool that changes something takes `"check": true`, which
reports what it would do and changes nothing. Passwords are never in a
result; every change goes to the system log (`journalctl -t addcctl-mcp`)
with the user who started the server and the passwords masked.
`addcctl mcp --read-only` offers only the tools that change nothing.

The client starts it through SSH, as a user that may run that command alone
as root. On the DC, for a user `mcp`, in `/etc/sudoers.d/addcctl-mcp` (edit
it with `visudo -f`):

```
mcp ALL=(root) NOPASSWD: /usr/bin/addcctl mcp
```

and, to bind its SSH key to that command, in `~mcp/.ssh/authorized_keys`:

```
restrict,command="sudo -n /usr/bin/addcctl mcp" ssh-ed25519 AAAA… client
```

On the client:

```json
{
  "mcpServers": {
    "samba-dc": {
      "command": "ssh",
      "args": ["-T", "mcp@dc.example.org", "sudo", "-n", "/usr/bin/addcctl", "mcp"]
    }
  }
}
```

The `mcp` user has the power of a domain administrator over what `addcctl`
manages: guard its key as such, or give it `addcctl mcp --read-only` (in
both files) when the client only needs to look.

## Ansible collection

`ansible/` holds the collection `lineadicomando.samba_dc`: `samba_dc_build`
provisions a Samba AD DC on Debian 13 and installs this module from its
Debian package; `samba_tool`, `samba_share` and the other roles and modules
manage users, groups, home directories and shared folders as the module
does, so the two can be used on the same DC; `samba_dc_backup` backs it up;
an MCP server runs the build and the backup for an MCP client. It has the version of
the repository (collection `X.Y.Z` is release `vX.Y.Z`, whose
`samba_dc_build` installs this module `X.Y.Z`), and is installed from git:

```yaml
# requirements.yml
collections:
  - name: git+https://github.com/lineadicomando/cockpit-samba-dc.git#/ansible/
    type: git
    version: v0.8.0
```

Roles, modules, variables and the MCP server: [`ansible/README.md`](ansible/README.md).

## Development

How the project is built (a core on the DC, `addcctl`, with the page, the
Ansible collection and an MCP server on top) and how far the plan has got:
`docs/architecture.md`; the roadmap: `TODO.md`.

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

Domain backups made from the **Domain** tab (or by `addcctl backup create`,
the collection's `samba_dc_backup` role and `samba_dc_info` module) go to
`/var/backups/samba-dc`, readable by root only: the archives hold the password
hashes of every account.

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

### Domain backups and restore

A backup is `samba-tool domain backup offline`: a consistent copy of the
directory, sysvol and the configuration, taken while Samba runs, in
`/var/backups/samba-dc/samba-backup-<realm>-<time>.tar.bz2`. Copy the
archives to another machine: a backup on the DC alone does not survive the
loss of its disk. The page neither deletes nor downloads them.

Restoring replaces the domain, so it is done by hand, from a shell, on a
machine where Samba is stopped and not provisioned: `samba-tool domain backup
restore --backup-file=<archive> --newservername=<name> --targetdir=<dir>`,
then point `smb.conf` at the restored files (see the Samba wiki, "Back up and
Restoring a Samba AD DC"). The collection's `samba_dc_backup` role does the
same with `samba_dc_backup_action: restore`.

### Network drive mapping

A shared folder can be mapped as a network drive at logon for the same users
and groups that can access it. The module keeps a dedicated GPO,
**Cockpit - Mapped drives**, linked to the domain root: its Group Policy
Preferences `Drives.xml` holds one drive per mapped folder, targeted at the
folder's users and groups. The GPO is created on first use directly in the
local `sam.ldb` and sysvol, so no domain credentials are needed; after each
change the GPO version is increased. The GPO is written by `addcctl`, one
change at a time. A rewritten file keeps the NT ACL of the one it replaces; the sysvol ACLs are reset (`samba-tool ntacl sysvolreset`)
only when the module writes a new file, as when it creates the GPO.

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
See [LICENSE](./LICENSE). The Ansible collection in `ansible/` is under the
**GNU GPL v3 or later** (`GPL-3.0-or-later`, [ansible/LICENSE](ansible/LICENSE));
each file names its license in an SPDX header.

## Author

Alessandro Gagliano — [lineadicomando.it](https://lineadicomando.it)
