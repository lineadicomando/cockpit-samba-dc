# lineadicomando.samba_dc

[![GitHub tag](https://img.shields.io/github/v/tag/lineadicomando/cockpit-samba-dc?label=version)](https://github.com/lineadicomando/cockpit-samba-dc/releases)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue)](./LICENSE)
[![CI](https://github.com/lineadicomando/cockpit-samba-dc/actions/workflows/ci.yml/badge.svg)](https://github.com/lineadicomando/cockpit-samba-dc/actions/workflows/ci.yml)
[![GitHub issues](https://badgen.net/github/open-issues/lineadicomando/cockpit-samba-dc)](https://github.com/lineadicomando/cockpit-samba-dc/issues)

Ansible collection that provisions a **Samba 4 Active Directory Domain Controller** on Debian Trixie and makes it manageable from a browser — no CLI required for day-to-day operations.

After provisioning, open `https://<dc-fqdn>:9090` to access **[cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc)**: a Cockpit plugin built for this collection that manages users, groups, computers, home directories and shared folders (with network drives mapped through a GPO) from the browser.

![cockpit-samba-dc screenshot](https://raw.githubusercontent.com/lineadicomando/cockpit-samba-dc/main/docs/screenshot.png)

## What you get

- A fully provisioned Samba 4 AD DC (realm, domain, Kerberos, DNS, NTP)
- A hardened nftables firewall with only the ports required by AD
- Chrony configured as authoritative NTP for domain clients
- **[cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc)** — browser UI for AD management on port 9090
- Idempotent day-two management of users, groups, computers, OUs, home directories and shared folders (interchangeable with the Cockpit UI, optionally mapped as network drives through a GPO)
- Domain backup and restore

Windows clients join the domain through the `domain` role of
[`lineadicomando.win_workman`](https://github.com/lineadicomando/ansible-collection-win_workman)
(task `domain-join`; `domain` reports membership).

## Roles

| Role | Target | Purpose |
|------|--------|---------|
| [`samba_dc_build`](roles/samba_dc_build/README.md) | Debian Trixie (13) | Provision a full Samba 4 AD DC with Cockpit web UI |
| [`samba_tool`](roles/samba_tool/README.md) | Debian Trixie (13) | Manage domain objects: users, groups, computers, home directories, shared folders |
| [`samba_dc_backup`](roles/samba_dc_backup/README.md) | Debian Trixie (13) | Back up the domain and user files; restore a domain |
| `deb_join` *(coming soon)* | Debian / Ubuntu | Join or remove Linux clients from the domain |

## Modules

| Module | Purpose |
|--------|---------|
| `samba_user` | Users: create, change (names, mail, enabled, expiry, groups, primary group, rename, OU), password, delete |
| `samba_group` | Groups: create, change (description, members, rename, OU), delete |
| `samba_computer` | Computer accounts: create before a join, change (description, OU), delete with their DNS records |
| `samba_ou` | Organizational units: create, rename, move, describe, delete (with their contents on request) |
| `samba_home` | Home directories: provision (folder, H: drive, home share), clear |
| `samba_password_policy` | The domain password and lockout policy (complexity, length, history, ages, lockout) |
| `samba_pso` | Fine-grained password policies (PSOs): create, change (settings, precedence, users and groups), delete |
| `samba_share` | Idempotent management of shared folders for domain users and groups (access, POSIX ACL, drive mapping through a GPO), with check mode and diff; same model as cockpit-samba-dc |
| `samba_share_info` | List shared folders with their access list and drive mapping |
| `samba_dc_info` | The domain and its controllers (Samba version, functional levels, FSMO roles) and the offline backups |

All of them run `addcctl`, the core of cockpit-samba-dc that the Cockpit page
also uses, so the two make the same changes; they support check mode and
diff. `addcctl` comes with the `addcctl` Debian package, which `samba_dc_build`
installs. `samba_tool_user` is gone: use `samba_user` (`mail` and `job_title`
are aliases there).

## MCP service

Two MCP servers, usable by any MCP-compatible client (Claude, Cursor, and
similar):

- on the DC, `addcctl mcp`, reached through SSH, manages users, groups,
  computers, home directories and shared folders, one tool per operation of
  `addcctl`, with `"check": true` as preview (README of
  [cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc),
  "MCP server on the DC");
- on the control node, the collection's [MCP server](mcp/README.md) runs its
  playbooks:

| Tool | Role | What it does |
|------|------|--------------|
| `samba_dc_build` | `samba_dc_build` | Builds a DC; `force_provision` (destructive) requires `force_provision_confirm: true` |
| `samba_dc_backup` | `samba_dc_backup` | Domain backup (online/offline) and destructive restore, which requires `restore_confirm: true` (catalog: `roles/samba_dc_backup/meta/mcp.yaml`) |

Every tool takes `preview: true`, which returns the `ansible-playbook`
command without running it.

## Requirements

- ansible-core >= 2.19 (tested against 2.19 and 2.20)
- Collection `community.general >= 7.0.0`
- DC target: Debian Trixie (13)

## Installation

The collection lives in the `ansible/` directory of
[cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc) and
shares its version: release `vX.Y.Z` of the repository is collection
`X.Y.Z`, and its `samba_dc_build` installs the Cockpit page of the same
release. It is not published on Ansible Galaxy; install it from git, pinned
to a release:

```yaml
# requirements.yml
collections:
  - name: git+https://github.com/lineadicomando/cockpit-samba-dc.git#/ansible/
    type: git
    version: v0.8.0
```

```bash
ansible-galaxy collection install -r requirements.yml
```

Each GitHub release also carries the built collection,
`lineadicomando-samba_dc-X.Y.Z.tar.gz`, for `ansible-galaxy collection
install <file>`.

### Coming from ansible-collection-samba_dc

Up to 0.7.0 the collection had its own repository,
`ansible-collection-samba_dc`, which is no longer updated. Point
`requirements.yml` at the `ansible/` directory of cockpit-samba-dc as above,
and the MCP client configuration at `ansible/mcp/server.py` in a checkout of
it. In `samba_dc_build`, `samba_dc_build_cockpit_version` is now the release
of the Cockpit page to install (`X.Y.Z`); a git revision to build goes into
`samba_dc_build_cockpit_source_version`, with
`samba_dc_build_cockpit_install: source`.

### Coming from 0.6.0: Windows roles moved to win_workman

`samba_win_join` and `samba_win_status` are no longer in this collection, nor
the `samba_win_status` playbook and MCP tool. They are the `domain` role of
`lineadicomando.win_workman`:

| Before | Now |
|---|---|
| role `samba_win_join` (`samba_win_join_state: domain`) | task `domain-join` |
| role `samba_win_join` (`samba_win_join_state: workgroup`) | task `domain-leave` |
| role or playbook `samba_win_status`, MCP tool `samba_win_status` | task `domain` (win-workman MCP: `run_tasks`) |
| `samba_win_join_search_domain` | `win_workman_domain_name` |
| `samba_win_join_administrator_username` | `win_workman_domain_admin_user` |
| `samba_win_join_administrator_passwd` | `win_workman_domain_admin_password` |
| `samba_win_join_realm` | not needed |
| `samba_win_join_reboot`, `samba_win_join_workgroup` | `win_workman_domain_reboot`, `win_workman_domain_workgroup` |
| fact `samba_win_status` | fact `win_workman_domain_status` |

The DNS servers to set before joining are `win_workman_domain_dns_servers`.
The MCP server no longer assumes an inventory called `school`: set
`ANSIBLE_MCP_DEFAULT_INVENTORY` in its environment, or pass `inventory`.

### Coming from `lineadicomando.samba_ad_dc`

Up to 0.4.0 the collection was called `lineadicomando.samba_ad_dc`. There is no
redirect from the old name:

- replace `lineadicomando.samba_ad_dc.` with `lineadicomando.samba_dc.` in the
  FQCN of roles, modules and playbooks; their own names did not change
- point `requirements.yaml` at this collection (see "Installation") and remove the
  installed `ansible_collections/lineadicomando/samba_ad_dc`
- in the MCP client configuration the server is `samba-dc` and its script lives
  under the new repository path
- the Cockpit plugin is now `cockpit-samba-dc`: the next `samba_dc_build` run
  installs it under `/usr/share/cockpit/samba-dc` and removes the former one.
  A `samba_dc_build_cockpit_repo` or `samba_dc_build_cockpit_src` set in the
  inventory still points at the old name and has to be updated

## Inventory example

```yaml
# host_vars/dc01.example.com.yaml
samba_dc_build_realm: EXAMPLE.COM
samba_dc_build_domain: EXAMPLE
samba_dc_build_fqdn: dc01.example.com
samba_dc_build_search_domain: example.com
samba_dc_build_nameserver: 192.168.1.1
samba_dc_build_address: 192.168.1.10
samba_dc_build_netmask: 255.255.255.0
samba_dc_build_gateway: 192.168.1.1
samba_dc_build_ifname: enp1s0
samba_dc_build_ntp_server: pool.ntp.org
samba_dc_build_ntp_allow_network: 192.168.1.0/24
# Required, no default — keep it in a vault
samba_dc_build_administrator_passwd: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  ...
```

## Playbook example

```yaml
- name: Provision Samba AD DC
  hosts: dc
  become: true
  roles:
    - lineadicomando.samba_dc.samba_dc_build

- name: Join Windows clients
  hosts: windows_clients
  roles:
    - role: lineadicomando.win_workman.dispatcher
      vars:
        win_workman_tasks: ["domain-join"]
        win_workman_domain_name: example.com
```

The roles are also available as dispatcher playbooks, callable by FQCN:

```bash
# Build the DCs of the inventory's samba_dc group
ansible-playbook lineadicomando.samba_dc.samba_dc_build

# Create a user
ansible-playbook lineadicomando.samba_dc.samba \
  -e '{"target_hosts":"dc","samba_tool_object":"user","samba_tool_action":"create",
       "samba_tool_args":{"name":"alice","password":"..."}}'

# Back up the domain
ansible-playbook lineadicomando.samba_dc.samba_dc_backup \
  -e '{"target_hosts":"dc","samba_dc_backup_action":"backup",
       "samba_dc_backup_targetdir":"/srv/samba-backup"}'
```

## Development

```bash
ansible-lint                     # profile: production
ansible-test sanity --docker     # from within ansible_collections/lineadicomando/samba_dc
ansible-test units --docker
```

## License

GPL-3.0-or-later

## Author

Alessandro Gagliano — [lineadicomando.it](https://lineadicomando.it)
