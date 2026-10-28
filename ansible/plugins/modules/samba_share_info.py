# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_share_info
short_description: List the shared folders of a Samba AD DC
version_added: "0.5.0"
description:
  - Returns the shared folders managed with the
    M(lineadicomando.samba_dc.samba_share) module or the cockpit-samba-dc
    Cockpit plugin, that is the registry shares whose path lies under
    O(shares_dir), with their access list and drive mapping.
  - Runs on the domain controller itself and requires elevated privileges
    (typically C(become=true)).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_share_info
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode; it never changes anything.
  - Runs C(addcctl share list), the core of cockpit-samba-dc (Debian package
    C(addcctl), installed by the samba_dc_build role).
"""

EXAMPLES = r"""
- name: List the shared folders
  lineadicomando.samba_dc.samba_share_info:
  become: true
  register: result

- name: Read one share
  lineadicomando.samba_dc.samba_share_info:
    name: Projects
  become: true
  register: result
"""

RETURN = r"""
shares:
  description: Managed shared folders; empty when O(name) matches none.
  type: list
  elements: dict
  returned: always
  contains:
    name:
      description: Share name as stored in the registry.
      type: str
    path:
      description: Folder on the DC.
      type: str
    comment:
      description: Share description.
      type: str
    browseable:
      description: Whether the share is listed when browsing.
      type: bool
    access:
      description:
        - Users and groups with their C(kind) (user or group) and C(level) (read or write).
        - C(unknown=true) marks an entry left by a deleted account, which stays until it is removed.
      type: list
      elements: dict
    drive:
      description: Drive mapping (C(letter), C(label)), or null when the share is not mapped.
      type: dict
  sample:
    - name: Projects
      path: /srv/samba/shares/Projects
      comment: Project files
      browseable: true
      access:
        - {name: Staff, kind: group, level: write}
        - {name: Domain Users, kind: group, level: read}
      drive: {letter: P, label: Projects}
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call, check_fixed_paths


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_share_info"),
        supports_check_mode=True,
    )
    check_fixed_paths(module)
    result = call(module, "share", "list", {})["shares"]
    if module.params["name"] is not None:
        result = [s for s in result if s["name"].lower() == module.params["name"].lower()]
    module.exit_json(changed=False, shares=result)


def main():
    run_module()


if __name__ == "__main__":
    main()
