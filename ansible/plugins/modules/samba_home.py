# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_home
short_description: Manage users' home directories on a Samba AD DC
version_added: "0.9.0"
description:
  - Provision a user's home directory, C(/srv/samba/home/<user>), mapped as a
    drive at logon (C(homeDrive), C(homeDirectory)) and served by the hidden
    registry share C(home), the same way the cockpit-samba-dc Cockpit page
    does; or clear it.
  - Runs C(addcctl home ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
options:
  name:
    description: sAMAccountName of the user.
    type: str
    required: true
  state:
    description:
      - C(present) creates the folder (owned by the user and its login group,
        mode 0700), sets the drive attributes and makes sure the C(home) share
        serves it; C(absent) clears the attributes.
    type: str
    choices: [present, absent]
    default: present
  drive:
    description: Drive letter of the home directory, with its colon.
    type: str
    default: "H:"
  delete_data:
    description:
      - With O(state=absent), also remove C(/srv/samba/home/<user>) and its
        contents.
    type: bool
    default: false
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)).
  - Domain accounts must resolve through NSS (winbind), which samba_dc_build
    configures.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: Home directory of a user
  lineadicomando.samba_dc.samba_home:
    name: mrossi

- name: Remove it, with its files
  lineadicomando.samba_dc.samba_home:
    name: mrossi
    state: absent
    delete_data: true
"""

RETURN = r"""
home:
  description: The folder, the drive and the UNC path.
  type: dict
  returned: when state is present
commands:
  description: What was changed, or would be in check mode.
  type: list
  elements: str
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call


def run_module():
    module = AnsibleModule(
        argument_spec=dict(
            name=dict(type="str", required=True),
            state=dict(type="str", default="present", choices=["present", "absent"]),
            drive=dict(type="str", default="H:"),
            delete_data=dict(type="bool", default=False),
        ),
        supports_check_mode=True,
    )
    p = module.params
    if p["state"] == "absent":
        result = call(module, "home", "delete", {"name": p["name"], "delete_data": p["delete_data"]},
                      check=module.check_mode)
        module.exit_json(changed=result["changed"], commands=result["commands"])
    result = call(module, "home", "provision", {"name": p["name"], "drive": p["drive"]}, check=module.check_mode)
    module.exit_json(changed=result["changed"], home=result.get("home"), commands=result["commands"])


def main():
    run_module()


if __name__ == "__main__":
    main()
