# samba_dc_build

Full provisioning of a **Samba 4 Active Directory Domain Controller** on Debian Trixie (13).

## What it does

1. **Validation** — ensures all required variables are defined before proceeding
2. **System** — sets the FQDN, maps it to the static address in `/etc/hosts`, updates packages, installs base tools and Cockpit
3. **Network** — assigns a static IP with DNS pointing to the DC itself, masks `systemd-resolved`
4. **Samba AD** — installs and provisions the domain (`samba-tool domain provision`), disables nmbd/smbd/winbind, resolves domain accounts through winbind in NSS, enables only `samba-ad-dc`
5. **Kerberos** — configures `/etc/krb5.conf`
6. **Firewall** — configures nftables, opening only the ports required by AD (DNS, Kerberos, LDAP, RPC, SMB) plus SSH and Cockpit (9090)
7. **Services** — enables `samba-ad-dc` and `cockpit`, configures chrony as authoritative NTP for the domain
8. **Admin user** — creates/configures the AD administrator account
9. **Cockpit plugin** — installs [cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc) for browser-based domain management, with `addcctl`, the core this collection's modules call: the Debian packages of the release that matches this collection

Networking is configured **before** the domain is provisioned, and the address is
passed explicitly to `samba-tool domain provision` (`--host-ip`): the provisioning
registers the DC's A record in the internal DNS zone, and it must be the static
address rather than a DHCP lease.

## Requirements

- Debian Trixie (13)
- Ansible >= 2.15
- Root / sudo access on the target

## Variables

Host-specific variables are mandatory and must be defined in `host_vars/<hostname>.yaml`. The role fails explicitly if any variable is missing or null.

| Variable | Description |
|----------|-------------|
| `samba_dc_build_realm` | Kerberos realm in uppercase (e.g. `EXAMPLE.COM`) |
| `samba_dc_build_domain` | NetBIOS domain name (e.g. `EXAMPLE`) |
| `samba_dc_build_fqdn` | DC fully qualified domain name (e.g. `dc01.example.com`), inside the search domain |
| `samba_dc_build_search_domain` | DNS search domain (e.g. `example.com`) |
| `samba_dc_build_nameserver` | Nameserver written to `/etc/resolv.conf` and to the interface configuration |
| `samba_dc_build_address` | Static IP address of the DC. Also registered in the internal DNS zone |
| `samba_dc_build_netmask` | Netmask (e.g. `255.255.255.0`) |
| `samba_dc_build_gateway` | Default gateway |
| `samba_dc_build_ifname` | Network interface name (default: `enp1s0`) |
| `samba_dc_build_ntp_server` | Upstream NTP server (e.g. `pool.ntp.org`) |
| `samba_dc_build_ntp_allow_network` | Network allowed to use the DC as NTP source (e.g. `192.168.1.0/24`) |
| `samba_dc_build_administrator_username` | AD admin username (default: `admin`) |
| `samba_dc_build_administrator_passwd` | AD admin password — **required, no default** |

### Optional variables

| Variable | Default | Description |
|----------|---------|-------------|
| `samba_dc_build_force_provision` | `false` | Force a **destructive** re-provisioning of an existing domain |
| `samba_dc_build_base_packages` | see `defaults/` | Packages required by the DC and Cockpit |
| `samba_dc_build_extra_packages` | see `defaults/` | Convenience tooling; safe to set to `[]` |
| `samba_dc_build_firewall_ssh_sources` | `[]` | Source networks allowed to reach SSH (empty = any) |
| `samba_dc_build_firewall_cockpit_sources` | `[]` | Source networks allowed to reach Cockpit (empty = any) |
| `samba_dc_build_cockpit_install` | `package` | `package`: the Debian packages of a release, `addcctl` (the core the modules call) and `cockpit-samba-dc` (the page), checksum verified; `none`: `addcctl` alone; `source`: both built from a git revision on the DC (development) |
| `samba_dc_build_cockpit_version` | this collection's version | Release installed by `package` and `none` (`X.Y.Z`) |
| `samba_dc_build_cockpit_release_url` | the GitHub release | Where the packages and their `.sha256` files are |
| `samba_dc_build_cockpit_package_files` | `[]` | `.deb` files on the controller instead of the download (sites without Internet access) |
| `samba_dc_build_cockpit_package_dir` | `/var/cache/cockpit-samba-dc` | Where the packages are kept on the DC |
| `samba_dc_build_cockpit_repo` | upstream URL | Git repository built by `source` |
| `samba_dc_build_cockpit_source_version` | `main` | Git revision built by `source` |
| `samba_dc_build_cockpit_src` | `/usr/local/src/cockpit-samba-dc` | Working copy of `source`; removed by `package` |

### The administrator password

`samba_dc_build_administrator_passwd` has no default: supply it from a
vault-encrypted variable. It is deliberately not derived from `ansible_password`
— the SSH credential and the domain administrator credential are different
secrets, and `ansible_password` is undefined when connecting with a key.

```bash
ansible-vault encrypt_string --name samba_dc_build_administrator_passwd '<password>'
```

### Re-provisioning

Provisioning wipes every Samba database, so the role only performs it when
`smb.conf` does not declare a DC **and** no `sam.ldb` exists. To rebuild an
existing domain from scratch, run with `samba_dc_build_force_provision: true`;
the role then also clears the account state markers, so the administrator
account is recreated against the new domain.

## Example

```yaml
- name: Provision DC
  hosts: dc
  become: true
  roles:
    - lineadicomando.samba_dc.samba_dc_build
```

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
samba_dc_build_administrator_passwd: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  ...
```

## Cockpit

After provisioning, the management panel is available at `https://<dc-fqdn>:9090`. The [cockpit-samba-dc](https://github.com/lineadicomando/cockpit-samba-dc) plugin provides a graphical interface for managing AD users, groups, and services without using the CLI.

## Tested platforms

- Debian Trixie (13)

## License

GPL-3.0-or-later
