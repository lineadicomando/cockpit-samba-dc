# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_group
short_description: Manage groups of a Samba AD DC
version_added: "0.9.0"
description:
  - Create, change and delete the groups of a Samba 4 Active Directory Domain
    Controller and their members, the same way the cockpit-samba-dc Cockpit
    page does.
  - Runs C(addcctl group ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
  - Settings left unset keep their current value. addcctl refuses to delete
    or rename the built-in groups.
options:
  name:
    description: sAMAccountName of the group.
    type: str
    required: true
  state:
    description:
      - C(present) creates the group when it is missing, unless O(create) is
        false, and brings it to the given settings; C(absent) deletes it.
      - Shared folders keep listing a deleted group.
    type: str
    choices: [present, absent]
    default: present
  create:
    description: Create the group when it is missing; when false, a missing group is an error.
    type: bool
    default: true
  description:
    description: Description; an empty string removes it.
    type: str
  scope:
    description:
      - Group scope, set when the group is created (default C(global)); an
        existing group keeps its own, with a warning when it differs.
    type: str
    choices: [domain, global, universal]
  category:
    description:
      - Group category, set when the group is created (default C(security));
        an existing group keeps its own, with a warning when it differs.
    type: str
    choices: [security, distribution]
  members:
    description:
      - Users, computers (C(name$)) or groups; see O(members_mode). Accounts
        whose primary group this is already belong to it.
    type: list
    elements: str
  members_mode:
    description: C(replace) makes O(members) the whole list, C(append) adds them, C(remove) drops them.
    type: str
    choices: [replace, append, remove]
    default: replace
  new_name:
    description: Rename the group; its shared folders follow the new name.
    type: str
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: A group with two members
  lineadicomando.samba_dc.samba_group:
    name: Staff
    description: School staff
    members: [mrossi, bianchi]

- name: Add a member, keeping the others
  lineadicomando.samba_dc.samba_group:
    name: Staff
    members: [verdi]
    members_mode: append
    create: false
"""

RETURN = r"""
group:
  description: The group after the change (before it, in check mode), as C(addcctl group get) reports it.
  type: dict
  returned: when state is present
commands:
  description: What was changed, or would be in check mode.
  type: list
  elements: str
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call, get, given


def run_module():
    module = AnsibleModule(
        argument_spec=dict(
            name=dict(type="str", required=True),
            state=dict(type="str", default="present", choices=["present", "absent"]),
            create=dict(type="bool", default=True),
            description=dict(type="str"),
            scope=dict(type="str", choices=["domain", "global", "universal"]),
            category=dict(type="str", choices=["security", "distribution"]),
            members=dict(type="list", elements="str"),
            members_mode=dict(type="str", default="replace", choices=["replace", "append", "remove"]),
            new_name=dict(type="str"),
        ),
        supports_check_mode=True,
    )
    p = module.params
    check = module.check_mode
    before = get(module, "group", p["name"])

    if p["state"] == "absent":
        if before is None:
            module.exit_json(changed=False, commands=[])
        result = call(module, "group", "delete", {"name": p["name"]}, check=check)
        module.exit_json(changed=result["changed"], commands=result["commands"], diff=dict(before=before, after={}))

    if before is None:
        if not p["create"]:
            module.fail_json(msg='Group "%s" not found' % p["name"])
        request = dict(given(p, dict(description="description", scope="scope", category="category")),
                       name=p["name"])
        if p["members"] and p["members_mode"] != "remove":
            request["members"] = p["members"]
        result = call(module, "group", "create", request, check=check)
        commands, group = result["commands"], result.get("group")
        if p["new_name"] and not check:
            renamed = call(module, "group", "set", {"name": p["name"], "new_name": p["new_name"]})
            commands += renamed["commands"]
            group = renamed["group"]
        module.exit_json(changed=True, group=group, commands=commands, diff=dict(before={}, after=group or {}))

    for option in ("scope", "category"):
        if p[option] is not None and p[option] != before[option]:
            module.warn("The %s of an existing group is not changed: %s is %s" % (option, before["name"], before[option]))
    request = given(p, dict(description="description", members="members", new_name="new_name"))
    if p["members"] is not None:
        request["members_mode"] = p["members_mode"]
    if not request:
        module.exit_json(changed=False, group=before, commands=[])
    result = call(module, "group", "set", dict(request, name=p["name"]), check=check)
    module.exit_json(changed=result["changed"], group=result["group"], commands=result["commands"],
                     diff=dict(before=before, after=result["group"]))


def main():
    run_module()


if __name__ == "__main__":
    main()
