<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Role: samba_dc_backup

Backs up a Samba 4 AD DC — the domain database via `samba-tool domain backup`
and, optionally, user files as a `tar.gz` archive — and restores a domain from a
backup archive.

It runs **on the domain controller** and requires elevated privileges
(`become: true`).

## Interface

| Variable | Default | Description |
|----------|---------|-------------|
| `samba_dc_backup_action` | — | `backup` or `restore` (required) |
| `samba_dc_backup_bin` | `samba-tool` | path to the executable |
| `samba_dc_backup_no_log` | `true` | hide the output of tasks handling credentials |

### Backup

| Variable | Default | Description |
|----------|---------|-------------|
| `samba_dc_backup_targetdir` | `samba_dc_backup_addcctl_dir` | directory the archives are written to |
| `samba_dc_backup_addcctl_dir` | `/var/backups/samba-dc` | where `addcctl` keeps the domain backups; an offline domain backup there is made by `addcctl backup create`, as on the Cockpit page, and listed there |
| `samba_dc_backup_domain` | `true` | include a domain backup |
| `samba_dc_backup_domain_type` | `offline` | `online` or `offline`; `offline` needs `tdbbackup` on the DC (package `tdb-tools`, a dependency of `addcctl`) |
| `samba_dc_backup_domain_server` | `localhost` | DC to contact (online only) |
| `samba_dc_backup_domain_username` | — | username for authenticated online backups |
| `samba_dc_backup_domain_password` | — | password; required when a username is given |
| `samba_dc_backup_files` | `true` | include a `tar.gz` of `samba_dc_backup_files_paths` |
| `samba_dc_backup_files_paths` | `[/home, /srv/samba]` | paths to archive; `/srv/samba` holds the home directories and shared folders |

The target directory is created with mode `0700` and the files archive with mode
`0600`, both owned by root. The credentials are handed to `samba-tool` through
the `PASSWD` environment variable rather than on the command line, so they do not
appear in the process list.

Backup is inherently non-idempotent: every run produces a new archive and
reports `changed`.

### Restore

| Variable | Default | Description |
|----------|---------|-------------|
| `samba_dc_backup_restore_backup_file` | — | archive to restore from (required) |
| `samba_dc_backup_restore_targetdir` | — | directory the DC is provisioned into (required) |
| `samba_dc_backup_restore_newservername` | — | name of the restored server (required) |
| `samba_dc_backup_restore_confirm` | `false` | safety gate — must be `true` to proceed |

**Restore is destructive**: it rebuilds a DC from the archive. The role refuses
to run unless `samba_dc_backup_restore_confirm` is `true`.

## Examples

```yaml
# Offline domain backup through addcctl, plus /home and /srv/samba, in
# /var/backups/samba-dc (where the Cockpit page lists them)
- import_role:
    name: lineadicomando.samba_dc.samba_dc_backup
  vars:
    samba_dc_backup_action: backup

# The same, elsewhere (samba-tool directly)
- import_role:
    name: lineadicomando.samba_dc.samba_dc_backup
  vars:
    samba_dc_backup_action: backup
    samba_dc_backup_targetdir: /srv/samba-backup

# Domain only, online, authenticated
- import_role:
    name: lineadicomando.samba_dc.samba_dc_backup
  vars:
    samba_dc_backup_action: backup
    samba_dc_backup_targetdir: /srv/samba-backup
    samba_dc_backup_domain_type: online
    samba_dc_backup_domain_username: Administrator
    samba_dc_backup_domain_password: "{{ vault_administrator_password }}"
    samba_dc_backup_files: false
```

Or via the FQCN playbook shipped with the collection:

```bash
ansible-playbook lineadicomando.samba_dc.samba_dc_backup \
  -e '{"target_hosts":"dc","samba_dc_backup_action":"backup",
       "samba_dc_backup_targetdir":"/srv/samba-backup"}'
```

## License

GPL-3.0-or-later
