# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_share
short_description: Manage shared folders on a Samba AD DC
version_added: "0.5.0"
description:
  - Create, update and delete folders shared with domain users and groups on a
    Samba 4 Active Directory Domain Controller, optionally mapped as a network
    drive at logon on Windows clients.
  - Uses the same model as the cockpit-samba-dc Cockpit plugin, so shares
    managed by this module and by the Cockpit UI are interchangeable. A shared
    folder is a registry share (C(net conf)) whose path is
    O(shares_dir)/O(name). Access is enforced by the share (C(valid users),
    plus C(read list) for read-only entries) and by a POSIX ACL on the folder
    tree, from which Samba's C(acl_xattr) derives the Windows ACL.
  - Shares whose path lies outside O(shares_dir) are never modified; the module
    fails instead.
  - Drive mappings live in a dedicated GPO, C(Cockpit - Mapped drives), linked
    to the domain root and created on first use. Its Group Policy Preferences
    C(Drives.xml) holds one drive per mapped share, targeted at the share's
    users and groups. It is written to the local C(sam.ldb) and sysvol, so no
    domain credentials are needed.
  - Runs on the domain controller itself and requires elevated privileges
    (typically C(become=true)).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_share
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Runs C(addcctl share set) or C(addcctl share delete), the core of
    cockpit-samba-dc, which the C(addcctl) Debian package installs on the DC
    (the samba_dc_build role does). Check mode is C(addcctl --check).
  - Requires C(registry shares = yes) in C(smb.conf) (set by the samba_dc_build
    role), C(setfacl) from the C(acl) package, and domain accounts resolvable
    through NSS (winbind), since the POSIX ACL refers to their uid and gid.
  - Only the ACL of the share's root folder is compared; when it matches, the
    rest of the tree is assumed to match too. A difference rewrites the ACL of
    the whole tree.
  - Clients pick up drive mapping changes at the next logon or C(gpupdate).
  - addcctl runs one change at a time on the DC, so this module and the
    Cockpit page may change drive mappings at the same moment.
"""

EXAMPLES = r"""
- name: Share a folder, read-write for staff and read-only for every domain user
  lineadicomando.samba_dc.samba_share:
    name: Projects
    comment: Project files
    access:
      - {name: Staff, level: write}
      - {name: Domain Users, level: read}
    drive_letter: P
    drive_label: Projects
  become: true

- name: Give one more user write access, keeping the others
  lineadicomando.samba_dc.samba_share:
    name: Projects
    access_mode: append
    access:
      - {name: mrossi, level: write}
  become: true

- name: Stop mapping the share as a drive
  lineadicomando.samba_dc.samba_share:
    name: Projects
    drive_letter: ""
  become: true

- name: Delete the share and its data
  lineadicomando.samba_dc.samba_share:
    name: Projects
    state: absent
    delete_data: true
  become: true
"""

RETURN = r"""
share:
  description: The share as it is after the run (or would be, in check mode).
  type: dict
  returned: when O(state=present)
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
      description: Users and groups with their C(kind) and C(level).
      type: list
      elements: dict
    drive:
      description: Drive mapping (C(letter), C(label)), or null.
      type: dict
  sample:
    name: Projects
    path: /srv/samba/shares/Projects
    comment: Project files
    browseable: true
    access:
      - {name: Staff, kind: group, level: write}
      - {name: Domain Users, kind: group, level: read}
    drive: {letter: P, label: Projects}
commands:
  description: The commands that were run (or would be, in check mode).
  type: list
  elements: str
  returned: always
  sample: ["mkdir -p -- /srv/samba/shares/Projects", "registry: create share [Projects]"]
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call, check_fixed_paths


def build_request(params, current_drive=None):
    """The input of `addcctl share set` for the module's parameters.
    current_drive: the share's mapping, needed to change only its label."""
    request = {"name": params["name"], "access_mode": params["access_mode"]}
    if params["access"] is not None:
        request["access"] = [
            dict((k, v) for k, v in entry.items() if v is not None) for entry in params["access"]
        ]
    if params["comment"] is not None:
        request["comment"] = params["comment"]
    if params["browseable"] is not None:
        request["browseable"] = params["browseable"]
    if params["drive_letter"] == "":
        request["drive"] = None
    elif params["drive_letter"] is not None:
        request["drive"] = {"letter": params["drive_letter"]}
        if params["drive_label"]:
            request["drive"]["label"] = params["drive_label"]
    elif params["drive_label"] and current_drive:
        request["drive"] = {"letter": current_drive["letter"], "label": params["drive_label"]}
    return request


def present(share):
    return dict(share, state="present") if share else {"state": "absent"}


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_share"),
        supports_check_mode=True,
    )
    p = module.params
    check_fixed_paths(module)

    if p["state"] == "absent":
        result = call(module, "share", "delete", {"name": p["name"], "delete_data": p["delete_data"]},
                      check=module.check_mode)
        module.exit_json(changed=result["changed"], commands=result.get("commands", []),
                         diff={"before": present(result["diff"]["before"]), "after": {"state": "absent"}})

    current_drive = None
    if p["drive_letter"] is None and p["drive_label"]:
        listed = call(module, "share", "list", {})["shares"]
        current = [s for s in listed if s["name"].lower() == p["name"].lower()]
        current_drive = current[0]["drive"] if current else None
    result = call(module, "share", "set", build_request(p, current_drive), check=module.check_mode)
    module.exit_json(
        changed=result["changed"],
        share=result["share"],
        commands=result.get("commands", []),
        diff={"before": present(result["diff"]["before"]), "after": present(result["diff"]["after"])},
    )


def main():
    run_module()


if __name__ == "__main__":
    main()
