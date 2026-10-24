# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_computer
short_description: Manage computer accounts of a Samba AD DC
version_added: "0.9.0"
description:
  - Create a computer account before the computer joins the domain, or
    delete one with its DNS records, on a Samba 4 Active Directory Domain
    Controller.
  - Runs C(addcctl computer ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
  - A domain controller's account is never deleted.
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_computer
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: Pre-create the account of a lab PC
  lineadicomando.samba_dc.samba_computer:
    name: LAB-PC01
    ou: OU=Lab

- name: Delete a computer account
  lineadicomando.samba_dc.samba_computer:
    name: LAB-PC01
    state: absent
"""

RETURN = r"""
computer:
  description: The account, as C(addcctl computer get) reports it.
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
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call, get, given


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_computer"),
        supports_check_mode=True,
    )
    p = module.params
    before = get(module, "computer", p["name"])
    if p["state"] == "absent":
        if before is None:
            module.exit_json(changed=False, commands=[])
        result = call(module, "computer", "delete", {"name": p["name"]}, check=module.check_mode)
        module.exit_json(changed=result["changed"], commands=result["commands"], diff=dict(before=before, after={}))
    if before is not None:
        module.exit_json(changed=False, computer=before, commands=[])
    request = dict(given(p, dict(ou="ou", description="description")), name=p["name"])
    result = call(module, "computer", "create", request, check=module.check_mode)
    module.exit_json(changed=True, computer=result.get("computer"), commands=result["commands"],
                     diff=dict(before={}, after=result.get("computer") or {}))


def main():
    run_module()


if __name__ == "__main__":
    main()
