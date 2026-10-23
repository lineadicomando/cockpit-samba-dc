<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Role: samba_tool

A wrapper around `samba-tool` to manage the objects of a Samba 4 AD DC (users,
groups, computers, OUs), to provision user home directories and to manage
shared folders. Designed to be
driven both from playbooks and from the `samba` MCP tool.

Domain backup and restore live in the separate
[`samba_dc_backup`](../samba_dc_backup/README.md) role.

It runs **on the domain controller** and requires elevated privileges
(`become: true`), because `samba-tool` reads the local `sam.ldb` database.

## Interface

| Variable | Description |
|----------|-------------|
| `samba_tool_object` | `user` \| `group` \| `computer` \| `ou` \| `home` \| `share` |
| `samba_tool_action` | samba-tool verb (`create`, `delete`, `list`, `show`, `addmembers`, …) |
| `samba_tool_args` | dictionary of action-specific arguments. `name` is required for every action except `list` |
| `samba_tool_bin` | path to the executable (default `samba-tool`) |
| `samba_tool_sam_ldb_path` | directory database used by `ldbmodify` (default `/var/lib/samba/private/sam.ldb`) |
| `samba_tool_home_share_params` | parameters enforced on the home SMB share |
| `samba_tool_shares_dir` | directory holding the shared folders (default `/srv/samba/shares`) |
| `samba_tool_no_log` | hide the output of tasks containing passwords (default `true`) |

## Actions

| Object | Actions |
|--------|---------|
| `user` | `list`, `show`, `create`, `present`, `delete`, `absent`, `enable`, `disable`, `setpassword`, `setprimarygroup` |
| `group` | `list`, `show`, `listmembers`, `add`, `create`, `delete`, `absent`, `addmembers`, `removemembers` |
| `computer` | `list`, `show`, `create`, `delete`, `absent` |
| `ou` | `list`, `listobjects`, `create`, `delete`, `absent` |
| `home` | `provision`, `absent` |
| `share` | `list`, `show`, `create`, `present`, `grant`, `revoke`, `delete`, `absent` |

## Idempotency

- **user**: mutating operations are delegated to the
  [`samba_tool_user`](../../plugins/modules/samba_tool_user.py) module, with
  check_mode and diff. The password cannot be read back: with `setpassword`
  (mapped to `update_password: always`) the task always reports `changed`.
- **group/computer/ou**: the current state is read before acting;
  `addmembers`/`removemembers` apply only the membership delta, compared
  case-insensitively as AD does.
- **home**: the LDAP attributes are read back and only rewritten when they
  differ; the SMB share parameters converge to
  `samba_tool_home_share_params`, and the path of an existing share to
  `home_base`.
- **share**: delegated to the
  [`samba_share`](../../plugins/modules/samba_share.py) module, with check_mode
  and diff. Access lists are compared regardless of order and case, the ACL of
  the share folder by uid/gid, and the drive mapping by its target SIDs, so a
  share saved from Cockpit in a different order is not rewritten.

## Home directories

`object: home`, `action: provision` replicates what cockpit-samba-dc does:
it creates `<home_base>/<name>`, sets the `homeDrive` and `homeDirectory`
attributes through `ldbmodify`, and ensures the SMB share exists.

| Argument | Default | Description |
|----------|---------|-------------|
| `name` | — | sAMAccountName (required) |
| `home_base` | `/srv/samba/home` | base path for home directories, the one cockpit-samba-dc uses |
| `home_drive` | `H:` | Windows drive letter mapping |
| `share_name` | `home` | SMB share name |
| `home_group` | `Domain Users` | group owning the directory |

The share serves one base directory: when it already exists on another path,
`provision` repoints it at `home_base`, as cockpit-samba-dc does with its own.
Home directories are not moved. Up to collection 0.5.0 the default was
`/home/samba`: on a DC provisioned then, move the directories to
`/srv/samba/home` before the next `provision`, or keep passing
`home_base: /home/samba` and do not provision homes from Cockpit.

The directory is owned by the domain account, so domain accounts must be
resolvable through NSS. The `samba_dc_build` role configures this by adding
`winbind` to the `passwd`/`group` lines of `/etc/nsswitch.conf`; the role fails
with an explicit message when the lookup does not work.

## Shared folders

`object: share` manages the same shared folders as the **Shared folders** tab of
[cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc):
a share created here appears in Cockpit and vice versa.

- Each folder is `<samba_tool_shares_dir>/<name>` (default
  `/srv/samba/shares/<name>`), shared as a registry share (`net conf`).
  Registry shares whose path lies elsewhere — the home share, hand-made shares —
  are never touched.
- Access is enforced by the share (`valid users`, plus `read list` for read-only
  entries) and by a POSIX ACL on the folder tree, from which Samba derives the
  Windows ACL.
- A share can be mapped as a network drive at logon for the same users and
  groups, through the **Cockpit - Mapped drives** GPO linked to the domain root
  (created on first use). Windows clients pick up changes at the next logon or
  `gpupdate`.

| Argument | Actions | Description |
|----------|---------|-------------|
| `name` | all but `list` | share name (required) |
| `access` | `create`, `present`, `grant`, `revoke` | list of `{name, kind, level}`: `kind` is `user` or `group` (looked up when omitted), `level` is `read` (default) or `write` |
| `read`, `write` | same | shorthands: lists (or comma-separated strings) of names |
| `comment` | `create`, `present` | description; `""` removes it |
| `browseable` | `create`, `present` | listed when browsing (default `true` for a new share) |
| `drive_letter` | `create`, `present` | E–Z except H (home directories); `""` removes the mapping |
| `drive_label` | `create`, `present` | drive label (default: the share name) |
| `delete_data` | `delete`, `absent` | also delete the folder and its contents (default `false`) |

`create`/`present` replace the access list when one is given and keep it
otherwise; `grant` adds entries or changes their level; `revoke` removes them.
A share always keeps at least one user or group, since an empty `valid users`
would open it to every domain user. Settings left out are not changed on an
existing share; an existing drive mapping follows access list changes.

## Examples

```yaml
# Create a user
- import_role:
    name: lineadicomando.samba_dc.samba_tool
  vars:
    samba_tool_object: user
    samba_tool_action: create
    samba_tool_args:
      name: alice
      password: "{{ vault_alice_password }}"
      given_name: Alice
      mail: alice@example.com

# Add members to a group (only the missing ones)
- import_role:
    name: lineadicomando.samba_dc.samba_tool
  vars:
    samba_tool_object: group
    samba_tool_action: addmembers
    samba_tool_args:
      name: "Domain Admins"
      members: [alice, bob]

# Provision a home directory
- import_role:
    name: lineadicomando.samba_dc.samba_tool
  vars:
    samba_tool_object: home
    samba_tool_action: provision
    samba_tool_args:
      name: alice
```

```yaml
# Share a folder: read-write for staff, read-only for every domain user, drive P:
- import_role:
    name: lineadicomando.samba_dc.samba_tool
  vars:
    samba_tool_object: share
    samba_tool_action: create
    samba_tool_args:
      name: Projects
      comment: Project files
      write: [Staff]
      read: ["Domain Users"]
      drive_letter: P
```

Or via the FQCN playbook shipped with the collection:

```bash
ansible-playbook lineadicomando.samba_dc.samba \
  -e '{"target_hosts":"dc","samba_tool_object":"user","samba_tool_action":"create",
       "samba_tool_args":{"name":"alice","password":"..."}}'
```

## Known limitations

For users, attributes (given name, surname, mail, …) are applied **only at
creation time**. Modifying attributes on existing users, moving users between
OUs and changing account expiry are not yet supported: `samba-tool` offers no
scriptable, idempotent sub-command for these cases (they would require
`ldbmodify`). They are planned as an evolution of the module.

Passwords are passed to `samba-tool` on the command line, because it cannot read
them from stdin: they are visible in the process list of the DC for the duration
of the call.
