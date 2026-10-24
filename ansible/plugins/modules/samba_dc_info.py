# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_dc_info
short_description: Facts about a Samba AD DC and its domain
version_added: "0.10.0"
description:
  - Returns the domain and its controllers (names, Samba version, functional
    levels, FSMO role owners, the processes of this DC) and the offline
    backups made by the cockpit-samba-dc page or by the samba_dc_backup role.
  - Runs C(addcctl domain info) and C(addcctl backup list), the core of
    cockpit-samba-dc, on the domain controller itself; it reads sam.ldb
    locally, with no network query and no domain credentials, and needs
    elevated privileges (typically C(become=true)).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_dc_info
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode; it never changes anything.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: Read the domain
  lineadicomando.samba_dc.samba_dc_info:
  register: dc
  become: true

- name: Show who holds the PDC emulator role
  ansible.builtin.debug:
    msg: "{{ dc.domain.fsmo | selectattr('role', 'eq', 'pdc') | map(attribute='owner') | first }}"
"""

RETURN = r"""
domain:
  description: The domain, as C(addcctl domain info) reports it.
  type: dict
  returned: always
  contains:
    realm:
      description: Kerberos realm.
      type: str
    netbios_domain:
      description: NetBIOS name of the domain.
      type: str
    samba_version:
      description: Version of Samba on this DC.
      type: str
    domain_level:
      description: Domain functional level (e.g. C(2008 R2)).
      type: str
    forest_level:
      description: Forest functional level.
      type: str
    domain_controllers:
      description: The domain controllers, with C(name), C(dns_name) and C(site).
      type: list
      elements: dict
    fsmo:
      description: The FSMO roles, with C(role) and the C(owner) server.
      type: list
      elements: dict
    processes:
      description: Output of C(samba-tool processes), or null when it failed.
      type: str
backups:
  description: The offline backups in C(/var/backups/samba-dc), newest first, with C(name), C(path), C(size) and C(created).
  type: list
  elements: dict
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call


def run_module():
    module = AnsibleModule(argument_spec=argument_spec("samba_dc_info"), supports_check_mode=True)
    domain = call(module, "domain", "info", {})["domain"]
    backups = call(module, "backup", "list", {})["backups"]
    module.exit_json(changed=False, domain=domain, backups=backups)


def main():
    run_module()


if __name__ == "__main__":
    main()
