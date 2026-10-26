# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_ou
short_description: Manage organizational units of a Samba AD DC
version_added: "0.12.0"
description:
  - Create, rename, move, describe and delete the organizational units (OUs)
    of a Samba 4 Active Directory Domain Controller, the same way the
    cockpit-samba-dc Cockpit page does.
  - The OU is named by O(name) and O(parent), the OU it is in. O(new_name)
    renames it and O(new_parent) moves it, with everything in it.
  - Runs C(addcctl ou ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
  - The default containers (C(CN=Users), C(CN=Computers),
    C(OU=Domain Controllers)) are never renamed, moved or deleted.
  - Users, groups and computers are put in an OU with the C(ou) option of
    M(lineadicomando.samba_dc.samba_user),
    M(lineadicomando.samba_dc.samba_group) and M(lineadicomando.samba_dc.samba_computer).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_ou
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
seealso:
  - module: lineadicomando.samba_dc.samba_user
  - module: lineadicomando.samba_dc.samba_group
  - module: lineadicomando.samba_dc.samba_computer
"""

EXAMPLES = r"""
- name: An OU for the school, and one for a class inside it
  lineadicomando.samba_dc.samba_ou:
    name: "{{ item.name }}"
    parent: "{{ item.parent }}"
  loop:
    - {name: School, parent: ""}
    - {name: Class 1A, parent: OU=School}

- name: Rename the class and move it to the domain root, with its users
  lineadicomando.samba_dc.samba_ou:
    name: Class 1A
    parent: OU=School
    new_name: Class 2A
    new_parent: ""

- name: Delete an OU and everything in it
  lineadicomando.samba_dc.samba_ou:
    name: School
    state: absent
    recursive: true
"""

RETURN = r"""
ou:
  description:
    - The OU after the change (or as it would be, in check mode), as C(addcctl ou get) reports it.
    - C(dn) is relative to the domain, as O(parent).
  type: dict
  returned: when state is present
deleted_accounts:
  description: The users, groups and computers (C(name$)) deleted with the OU.
  type: list
  elements: str
  returned: when state is absent
commands:
  description: What was changed, or would be in check mode.
  type: list
  elements: str
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call


def find(ous, name, parent):
    """The OU called name in parent (both compared as AD does, case-insensitively), or None."""
    for ou in ous:
        if ou["kind"] == "ou" and ou["name"].lower() == name.lower() and ou["parent"].lower() == parent.lower():
            return ou
    return None


def changes(ou, params):
    """The input of `addcctl ou set` besides the DN: what differs from ou."""
    request = {}
    if params.get("new_name") is not None and params["new_name"] != ou["name"]:
        request["new_name"] = params["new_name"]
    if params.get("new_parent") is not None and params["new_parent"].lower() != ou["parent"].lower():
        request["parent"] = params["new_parent"]
    if params.get("description") is not None and params["description"] != ou["description"]:
        request["description"] = params["description"]
    return request


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_ou"),
        supports_check_mode=True,
    )
    p = module.params
    check = module.check_mode
    ous = call(module, "ou", "list", {})["ous"]
    before = find(ous, p["name"], p["parent"])

    if p["state"] == "absent":
        if before is None:
            module.exit_json(changed=False, deleted_accounts=[], commands=[])
        result = call(module, "ou", "delete", {"dn": before["dn"], "recursive": p["recursive"]}, check=check)
        module.exit_json(changed=result["changed"], deleted_accounts=result["deleted_accounts"],
                         commands=result["commands"], diff=dict(before=before, after={}))

    if before is None:
        moving = p["new_name"] is not None or p["new_parent"] is not None
        target = (p["new_name"] if p["new_name"] is not None else p["name"],
                  p["new_parent"] if p["new_parent"] is not None else p["parent"])
        # Renamed or moved by an earlier run
        before = find(ous, *target) if moving else None
        if before is None and moving:
            module.fail_json(msg='OU "%s" not found in "%s": nothing to rename or move' % (p["name"], p["parent"]))
    if before is None:
        request = dict(name=p["name"], parent=p["parent"])
        if p["description"]:
            request["description"] = p["description"]
        result = call(module, "ou", "create", request, check=check)
        module.exit_json(changed=True, ou=result["ou"], commands=result["commands"],
                         diff=dict(before={}, after=result["ou"]))

    request = changes(before, p)
    if not request:
        module.exit_json(changed=False, ou=before, commands=[])
    result = call(module, "ou", "set", dict(request, dn=before["dn"]), check=check)
    module.exit_json(changed=result["changed"], ou=result["ou"], commands=result["commands"],
                     diff=dict(before=before, after=result["ou"]))


def main():
    run_module()


if __name__ == "__main__":
    main()
