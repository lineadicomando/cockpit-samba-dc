# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_pso
short_description: Manage fine-grained password policies (PSOs) of a Samba AD domain
version_added: "0.11.0"
description:
  - Create, change or delete a Password Settings Object (PSO), the
    fine-grained password and lockout policy that replaces the domain policy
    for the users and groups it applies to, the same way the cockpit-samba-dc
    Cockpit page does.
  - A user gets the PSO of lowest precedence among those that apply to it or
    to its groups; one that names the user directly wins over its groups'.
  - Runs C(addcctl pso ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically
    C(become=true)).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_pso
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - PSOs need the domain functional level 2008 or higher.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
seealso:
  - module: lineadicomando.samba_dc.samba_password_policy
"""

EXAMPLES = r"""
- name: Longer passwords for the staff, locked until an administrator unlocks them
  lineadicomando.samba_dc.samba_pso:
    name: Staff
    precedence: 10
    applies_to: [Teachers, Office]
    min_length: 14
    lockout_threshold: 5
    lockout_duration_minutes: 0
    lockout_window_minutes: 30

- name: Also for one more user
  lineadicomando.samba_dc.samba_pso:
    name: Staff
    applies_to: [mrossi]
    applies_to_mode: append

- name: Remove it
  lineadicomando.samba_dc.samba_pso:
    name: Staff
    state: absent
"""

RETURN = r"""
pso:
  description: The PSO, after the change (or as it would be, in check mode).
    C(null) for an age or an interval means never.
  type: dict
  returned: when state is present
commands:
  description: What was changed, or would be in check mode.
  type: list
  elements: str
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call, get

SETTINGS = ("complexity", "min_length", "history_length", "min_age_days", "max_age_days",
            "lockout_threshold", "lockout_duration_minutes", "lockout_window_minutes", "precedence")
# 0 means never for these, as in samba-tool; addcctl takes null
NEVER_AT_ZERO = ("max_age_days", "lockout_duration_minutes", "lockout_window_minutes")


def build_request(params, create):
    """The settings given, as addcctl takes them."""
    request = {"name": params["name"]}
    for key in SETTINGS:
        value = params.get(key)
        if value is not None:
            request[key] = None if key in NEVER_AT_ZERO and value == 0 else value
    if params.get("applies_to") is not None:
        if create:
            if params["applies_to_mode"] != "remove":
                request["applies_to"] = params["applies_to"]
        else:
            request["applies_to"] = params["applies_to"]
            request["applies_to_mode"] = params["applies_to_mode"]
    return request


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_pso"),
        supports_check_mode=True,
    )
    p = module.params
    check = module.check_mode
    before = get(module, "pso", p["name"])

    if p["state"] == "absent":
        if before is None:
            module.exit_json(changed=False, commands=[])
        result = call(module, "pso", "delete", {"name": p["name"]}, check=check)
        module.exit_json(changed=result["changed"], commands=result["commands"], diff=dict(before=before, after={}))

    if before is None:
        if p["precedence"] is None:
            module.fail_json(msg='PSO "%s" not found: give its precedence to create it' % p["name"])
        result = call(module, "pso", "create", build_request(p, create=True), check=check)
        module.exit_json(changed=True, pso=result["pso"], commands=result["commands"],
                         diff=dict(before={}, after=result["pso"]))

    request = build_request(p, create=False)
    if len(request) == 1:
        module.exit_json(changed=False, pso=before, commands=[])
    result = call(module, "pso", "set", request, check=check)
    module.exit_json(changed=result["changed"], pso=result["pso"], commands=result["commands"],
                     diff=dict(before=before, after=result["pso"]))


def main():
    run_module()


if __name__ == "__main__":
    main()
