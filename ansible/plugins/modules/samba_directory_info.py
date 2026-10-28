# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_directory_info
short_description: Read the users, groups or computer accounts of a Samba AD DC
version_added: "0.15.0"
description:
  - Returns the domain's users, groups or computer accounts, structured, as
    C(addcctl user list), C(group list) and C(computer list) report them
    (or one of them, with C(get)).
  - Runs C(addcctl), the core of cockpit-samba-dc, on the domain controller
    itself; it reads sam.ldb locally, with no network query and no domain
    credentials, and needs elevated privileges (typically C(become=true)).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_directory_info
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode; it never changes anything.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: Read the users
  lineadicomando.samba_dc.samba_directory_info:
    kind: user
  register: users
  become: true

- name: The disabled ones
  ansible.builtin.debug:
    msg: "{{ users.objects | rejectattr('enabled') | map(attribute='name') }}"

- name: Read one group
  lineadicomando.samba_dc.samba_directory_info:
    kind: group
    name: Teachers
  register: teachers
  become: true
"""

RETURN = r"""
objects:
  description:
    - The users, groups or computer accounts, each as C(addcctl user get), C(group get) or
      C(computer get) reports it; empty when O(name) matches none.
    - Group members and user groups are account names, not CNs.
  type: list
  elements: dict
  returned: always
  sample:
    - name: mrossi
      enabled: true
      groups: [Teachers]
      container: CN=Users
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call, get

# The key of each list in addcctl's answer
LISTS = {"user": "users", "group": "groups", "computer": "computers"}


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_directory_info"),
        supports_check_mode=True,
    )
    kind, name = module.params["kind"], module.params["name"]
    if name is None:
        objects = call(module, kind, "list", {})[LISTS[kind]]
    else:
        found = get(module, kind, name)
        objects = [] if found is None else [found]
    module.exit_json(changed=False, objects=objects)


def main():
    run_module()


if __name__ == "__main__":
    main()
