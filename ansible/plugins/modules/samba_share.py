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
options:
  name:
    description:
      - Share name. Also the name of the folder under O(shares_dir).
      - Matched case-insensitively against existing shares, as Samba does.
    type: str
    required: true
  state:
    description:
      - C(present) ensures the share exists with the requested settings,
        C(absent) ensures it does not.
    type: str
    choices: [present, absent]
    default: present
  access:
    description:
      - Users and groups allowed on the share, by sAMAccountName (without the
        C(DOMAIN\) prefix).
      - Required to create a share. On an existing share, leaving it unset keeps
        the current access list.
      - How the list combines with the current one depends on O(access_mode).
    type: list
    elements: dict
    suboptions:
      name:
        description: sAMAccountName of the user or group.
        type: str
        required: true
      kind:
        description:
          - C(user) or C(group). Read from the directory when unset; when set,
            it must match the directory.
        type: str
        choices: [user, group]
      level:
        description: C(read) for read-only access, C(write) for read-write.
        type: str
        choices: [read, write]
        default: read
  access_mode:
    description:
      - C(replace) makes O(access) the complete access list.
      - C(append) adds the entries of O(access), or changes the level of those
        already present, and keeps the others.
      - C(remove) drops the principals named in O(access); their level and kind
        are ignored.
      - A share always needs at least one user or group, since an empty
        C(valid users) would open it to every domain user.
    type: str
    choices: [replace, append, remove]
    default: replace
  comment:
    description:
      - Share description shown to clients. An empty string removes it.
      - Unmanaged on an existing share when unset.
    type: str
  browseable:
    description:
      - Whether the share is listed when browsing the server.
      - Defaults to C(true) for a new share, unmanaged on an existing one when
        unset.
    type: bool
  drive_letter:
    description:
      - Map the share as this network drive at logon, for the same users and
        groups that can access it. One of E-Z except H, which is reserved for
        home directories. A trailing colon is accepted.
      - An empty string removes the mapping. When unset, an existing mapping is
        kept and follows access list changes.
    type: str
  drive_label:
    description:
      - Label of the mapped drive. When unset, the current label is kept, or the
        share name is used for a new mapping.
    type: str
  delete_data:
    description:
      - With O(state=absent), also delete the folder and all its contents.
        Otherwise the data is kept on disk.
    type: bool
    default: false
  shares_dir:
    description:
      - Directory holding the shared folders. Must match the one used by
        cockpit-samba-dc for the two to manage the same shares.
    type: path
    default: /srv/samba/shares
  sam_ldb_path:
    description: Samba directory database.
    type: path
    default: /var/lib/samba/private/sam.ldb
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Requires C(registry shares = yes) in C(smb.conf) (set by the samba_dc_build
    role), C(setfacl) from the C(acl) package, and domain accounts resolvable
    through NSS (winbind), since the POSIX ACL refers to their uid and gid.
  - Only the ACL of the share's root folder is compared; when it matches, the
    rest of the tree is assumed to match too. A difference rewrites the ACL of
    the whole tree.
  - Clients pick up drive mapping changes at the next logon or C(gpupdate).
  - The Cockpit plugin serializes its own GPO writes, but nothing serializes
    them against this module, so avoid changing drive mappings from both at
    the same moment.
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
  sample: ["net conf addshare Projects /srv/samba/shares/Projects writeable=y guest_ok=n"]
"""

import os

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.samba_share import (
    SambaShares,
    access_key,
    format_user_list,
    is_managed_path,
    normalize_drive_letter,
    parse_smb_bool,
    validate_share_name,
)


def merge_access(current, requested, mode):
    """Access list resulting from applying requested to current."""
    if mode == "replace":
        merged = []
        for entry in requested:
            merged = [e for e in merged if e["name"].lower() != entry["name"].lower()] + [entry]
        return merged
    if mode == "remove":
        drop = set(e["name"].lower() for e in requested)
        return [e for e in current if e["name"].lower() not in drop]
    merged = [dict(e) for e in current]
    for entry in requested:
        for e in merged:
            if e["name"].lower() == entry["name"].lower():
                e["level"] = entry["level"]
                if entry.get("kind"):
                    e["kind"] = entry["kind"]
                break
        else:
            merged.append(entry)
    return merged


def resolve_access(module, shares, access):
    """Canonical names and kinds from the directory, plus each SID."""
    found = shares.resolve_principals([e["name"] for e in access])
    unknown = [e["name"] for e in access if e["name"].lower() not in found]
    if unknown:
        module.fail_json(msg="Unknown user or group: %s" % ", ".join(unknown))
    resolved = []
    for entry in access:
        principal = found[entry["name"].lower()]
        if entry.get("kind") and entry["kind"] != principal["kind"]:
            module.fail_json(msg="%s is a %s, not a %s" % (principal["name"], principal["kind"], entry["kind"]))
        resolved.append(dict(principal, level=entry["level"]))
    return resolved


def run_module():
    module = AnsibleModule(
        argument_spec=dict(
            name=dict(type="str", required=True),
            state=dict(type="str", default="present", choices=["present", "absent"]),
            access=dict(
                type="list",
                elements="dict",
                options=dict(
                    name=dict(type="str", required=True),
                    kind=dict(type="str", choices=["user", "group"]),
                    level=dict(type="str", default="read", choices=["read", "write"]),
                ),
            ),
            access_mode=dict(type="str", default="replace", choices=["replace", "append", "remove"]),
            comment=dict(type="str"),
            browseable=dict(type="bool"),
            drive_letter=dict(type="str"),
            drive_label=dict(type="str"),
            delete_data=dict(type="bool", default=False),
            shares_dir=dict(type="path", default="/srv/samba/shares"),
            sam_ldb_path=dict(type="path", default="/var/lib/samba/private/sam.ldb"),
        ),
        supports_check_mode=True,
    )
    p = module.params
    shares = SambaShares(module, p["shares_dir"], p["sam_ldb_path"])

    violation = validate_share_name(p["name"])
    if violation:
        module.fail_json(msg="Invalid share name %r: %s" % (p["name"], violation))

    section, params = shares.find_section(p["name"])
    if section is not None and not is_managed_path(params.get("path", ""), shares.shares_dir):
        module.fail_json(
            msg="Share %s exists with path %r, outside %s: it is not managed by this module"
                % (section, params.get("path", ""), shares.shares_dir))

    gpo, entries = shares.drive_entries()
    before = shares.describe(section, params, shares.drive_mappings(entries)) if section else None
    diff_before = dict(before, state="present") if before else {"state": "absent"}

    if p["state"] == "absent":
        if before is None:
            module.exit_json(changed=False, commands=[], diff={"before": diff_before, "after": diff_before})
        if before["drive"]:
            shares.set_drive_mapping(section, [], None)
        shares.change(["net", "conf", "delshare", section])
        if p["delete_data"] and os.path.exists(before["path"]):
            shares.change(["rm", "-rf", "--one-file-system", "--", before["path"]])
        module.exit_json(changed=True, commands=shares.commands,
                         diff={"before": diff_before, "after": {"state": "absent"}})

    # state == present
    name = section or p["name"]
    path = before["path"] if before else "%s/%s" % (shares.shares_dir, name)
    current_access = before["access"] if before else []

    if p["access"] is None:
        if before is None:
            module.fail_json(msg="access is required to create share %s" % name)
        desired = current_access
    else:
        if before is None and p["access_mode"] == "remove":
            module.fail_json(msg="Share %s does not exist" % name)
        desired = merge_access(current_access, p["access"], p["access_mode"])
    if not desired:
        module.fail_json(msg="A shared folder needs at least one user or group")
    resolved = resolve_access(module, shares, desired)
    access = [{"name": e["name"], "kind": e["kind"], "level": e["level"]} for e in resolved]

    # Drive mapping, checked before touching anything so that a letter clash
    # does not leave a share created without its mapping.
    current_drive = before["drive"] if before else None
    if p["drive_letter"] is None:
        drive = current_drive
    elif p["drive_letter"] == "":
        drive = None
    else:
        drive = {"letter": normalize_drive_letter(p["drive_letter"])}
        drive["label"] = p["drive_label"] or (current_drive or {}).get("label") or name
        shares.check_drive_letter(name, drive["letter"], entries)
    if drive is not None and p["drive_letter"] is None and p["drive_label"]:
        drive = dict(drive, label=p["drive_label"])

    changed = shares.ensure_root(path)
    changed = shares.ensure_acl(path, access, current_access) or changed

    if before is None:
        shares.change(["net", "conf", "addshare", name, path, "writeable=y", "guest_ok=n"])
        changed = True
        current_params = {"path": path, "read only": "no", "guest ok": "no"}
    else:
        current_params = params

    wanted = {"inherit acls": "yes"}
    if access_key(access) != access_key(current_access):
        readers = [e for e in access if e["level"] == "read"]
        wanted["valid users"] = format_user_list(access, shares.workgroup)
        wanted["read list"] = format_user_list(readers, shares.workgroup) if readers else None
    if p["comment"] is not None:
        wanted["comment"] = p["comment"] or None
    changed = shares.set_params(name, current_params, wanted) or changed

    browseable = p["browseable"]
    if browseable is None and before is None:
        browseable = True
    if browseable is not None:
        current_browseable = parse_smb_bool(
            current_params.get("browseable", current_params.get("browsable")), True)
        if "browseable" not in current_params or current_browseable != browseable:
            shares.change(["net", "conf", "setparm", name, "browseable", "yes" if browseable else "no"])
            changed = True
    else:
        browseable = before["browseable"]

    # Also when only the access list changed: the mapping targets it.
    if drive is not None or current_drive is not None:
        changed = shares.set_drive_mapping(name, resolved, drive) or changed

    comment = p["comment"] if p["comment"] is not None else (before or {}).get("comment", "")
    after = {
        "name": name,
        "path": path,
        "comment": comment,
        "browseable": browseable,
        "access": access,
        "drive": drive,
    }
    module.exit_json(
        changed=changed,
        share=after,
        commands=shares.commands,
        diff={"before": diff_before, "after": dict(after, state="present")},
    )


def main():
    run_module()


if __name__ == "__main__":
    main()
