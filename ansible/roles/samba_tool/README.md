<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Role: samba_tool

A wrapper around `samba-tool` to manage the objects of a Samba 4 AD DC (users,
groups, computers), to provision user home directories and to manage
shared folders, from playbooks (`lineadicomando.samba_dc.samba`). An MCP
client manages the same objects through `addcctl mcp` on the DC.

Domain backup and restore live in the separate
[`samba_dc_backup`](../samba_dc_backup/README.md) role.

It runs **on the domain controller** and requires elevated privileges
(`become: true`), because `samba-tool` reads the local `sam.ldb` database.

## Interface

| Variable | Description |
|----------|-------------|
| `samba_tool_object` | `user` \| `group` \| `computer` \| `home` \| `share` |
| `samba_tool_action` | samba-tool verb (`create`, `delete`, `list`, `show`, `addmembers`, …) |
| `samba_tool_args` | dictionary of action-specific arguments. `name` is required for every action except `list` |
| `samba_tool_bin` | path to samba-tool, for the read-only actions (default `samba-tool`) |
| `samba_tool_shares_dir` | directory holding the shared folders (default `/srv/samba/shares`) |
| `samba_tool_no_log` | hide the output of tasks containing passwords (default `true`) |

## Actions

| Object | Actions |
|--------|---------|
| `user` | `list`, `show`, `create`, `present`, `delete`, `absent`, `enable`, `disable`, `setpassword`, `setprimarygroup` |
| `group` | `list`, `show`, `listmembers`, `add`, `create`, `delete`, `absent`, `addmembers`, `removemembers` |
| `computer` | `list`, `show`, `create`, `delete`, `absent` |
| `home` | `provision`, `absent` |
| `share` | `list`, `show`, `create`, `present`, `grant`, `revoke`, `delete`, `absent` |

## Idempotency

Changes go through the collection's modules, which run `addcctl`, the core of
cockpit-samba-dc: what the role does and what the Cockpit page does are the
same code. All support check mode and diff, and apply only what differs.

- **user**: [`samba_user`](../../plugins/modules/samba_user.py). `enable`,
  `disable` and `setprimarygroup` act on an existing user and fail on a
  missing one; `create` and `setpassword` create it when missing. The password
  cannot be read back: `setpassword` always reports `changed`.
- **group**: [`samba_group`](../../plugins/modules/samba_group.py);
  `addmembers`/`removemembers` apply only the membership delta, compared
  case-insensitively as AD does, on an existing group.
- **computer**: [`samba_computer`](../../plugins/modules/samba_computer.py);
  deleting one also removes its DNS records.
- **home**: [`samba_home`](../../plugins/modules/samba_home.py).
- **share**: [`samba_share`](../../plugins/modules/samba_share.py). Access lists
  are compared regardless of order and case, the ACL of the share folder by
  uid/gid, and the drive mapping by its targets, so a share saved from Cockpit
  in a different order is not rewritten.

addcctl protects the built-in accounts and groups (not deleted or renamed,
Administrator's and krbtgt's status unchanged, no expiry on system accounts)
and never deletes a domain controller's account.

## Home directories

`object: home`, `action: provision` does what cockpit-samba-dc does: it
creates `/srv/samba/home/<name>`, owned by the user and its login group
with mode 0700, sets the `homeDrive` and `homeDirectory` attributes, and makes
sure the hidden `home` share serves `/srv/samba/home`. `absent` clears the
attributes and removes the folder.

| Argument | Default | Description |
|----------|---------|-------------|
| `name` | — | sAMAccountName (required) |
| `home_drive` | `H:` | Windows drive letter mapping |
| `home_base` | `/srv/samba/home` | only this value: the base directory addcctl manages |
| `share_name` | `home` | only this value |

`home_group` is no longer used: the folder's group is the user's login group.
Up to collection 0.5.0 the default base directory was `/home/samba`: move the
directories of a DC provisioned then to `/srv/samba/home`.

The directory is owned by the domain account, so domain accounts must be
resolvable through NSS. The `samba_dc_build` role configures this by adding
`winbind` to the `passwd`/`group` lines of `/etc/nsswitch.conf`.

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

## Organizational units

The OU actions are gone (collection 0.12.0): use the
[`samba_ou`](../../plugins/modules/samba_ou.py) module, which runs addcctl,
and the `ou` option of `samba_user`, `samba_group` and `samba_computer` to
put objects in an OU. The `ou` argument of the `user`, `group` and `computer`
actions here passes to them.
