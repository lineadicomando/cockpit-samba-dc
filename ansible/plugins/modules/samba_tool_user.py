# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_tool_user
short_description: Manage Samba AD DC users via samba-tool
version_added: "0.2.0"
description:
  - Create, delete, enable, disable and set passwords for users in a Samba 4
    Active Directory Domain Controller, wrapping the C(samba-tool user) command.
  - Runs on the domain controller itself and requires elevated privileges
    (typically C(become=true)), because C(samba-tool) reads the local
    C(sam.ldb) database.
  - Account attributes (given name, surname, mail, ...) are only applied at
    creation time. Modifying them on an existing user, moving users between
    organizational units and changing account expiry are not yet supported,
    because C(samba-tool) offers no scriptable, idempotent sub-command for them.
options:
  name:
    description:
      - The user logon name (sAMAccountName).
    type: str
    required: true
    aliases: [username]
  state:
    description:
      - C(present) ensures the user exists, C(absent) ensures it does not.
    type: str
    choices: [present, absent]
    default: present
  password:
    description:
      - Password for the user. Used at creation, and on existing users
        according to O(update_password).
      - If omitted at creation time, a random password is generated
        (C(--random-password)).
    type: str
  update_password:
    description:
      - C(on_create) only sets the password when the user is created.
      - C(always) sets O(password) on every run; because the current password
        cannot be read back, this always reports C(changed).
    type: str
    choices: [on_create, always]
    default: on_create
  enabled:
    description:
      - Whether the account is enabled. When unset, the enabled state is left
        unmanaged.
    type: bool
  given_name:
    description: First name. Applied only at creation time.
    type: str
  surname:
    description: Last name. Applied only at creation time.
    type: str
  mail:
    description: Email address. Applied only at creation time.
    type: str
    aliases: [mail_address]
  description:
    description: Free-text description. Applied only at creation time.
    type: str
  job_title:
    description: Job title. Applied only at creation time.
    type: str
  department:
    description: Department. Applied only at creation time.
    type: str
  company:
    description: Company. Applied only at creation time.
    type: str
  ou:
    description:
      - Organizational unit DN, relative to the domain base, in which to create
        the user (maps to C(--userou)). Applied only at creation time.
    type: str
  must_change_password:
    description:
      - Force the user to change the password at next logon
        (C(--must-change-at-next-login)). Applied only at creation time.
    type: bool
    default: false
  primary_group:
    description:
      - Name of the group to set as the user's primary group (C(primaryGroupID)).
      - The group must exist. If the user is not yet a member it is added
        automatically before the primary group is set.
      - Applied on every run when set, and is a no-op when already correct.
      - Requires C(ldbmodify) on the domain controller. Only applies when
        O(state=present).
    type: str
  sam_ldb_path:
    description:
      - Path to the Samba C(sam.ldb) database used by C(ldbmodify).
      - Only relevant when O(primary_group) is set.
    type: path
    default: /var/lib/samba/private/sam.ldb
  samba_tool_path:
    description:
      - Path to the C(samba-tool) executable. Autodetected on C(PATH) when unset.
    type: path
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Passwords are handed to C(samba-tool) as command line arguments, because it
    offers no way to read them from stdin or from a file. They are therefore
    visible in the process list of the domain controller for the duration of the
    call. Restrict local shell access on the DC accordingly.
"""

EXAMPLES = r"""
- name: Ensure a user exists
  lineadicomando.samba_dc.samba_tool_user:
    name: alice
    password: "{{ vault_alice_password }}"
    given_name: Alice
    surname: Rossi
    mail: alice@example.com
  become: true

- name: Disable a user
  lineadicomando.samba_dc.samba_tool_user:
    name: bob
    enabled: false
  become: true

- name: Rotate a password on every run
  lineadicomando.samba_dc.samba_tool_user:
    name: svc-backup
    password: "{{ vault_svc_password }}"
    update_password: always
  become: true

- name: Remove a user
  lineadicomando.samba_dc.samba_tool_user:
    name: olduser
    state: absent
  become: true

- name: Set primary group of an existing user
  lineadicomando.samba_dc.samba_tool_user:
    name: alice
    primary_group: Staff
  become: true
"""

RETURN = r"""
user:
  description: The user logon name acted upon.
  type: str
  returned: always
  sample: alice
commands:
  description: The samba-tool command lines that were executed (passwords redacted).
  type: list
  elements: str
  returned: changed
  sample: ["user create alice", "user enable alice"]
"""

import base64

from ansible.module_utils.basic import AnsibleModule

# ACCOUNTDISABLE flag in userAccountControl.
_UAC_ACCOUNTDISABLE = 0x0002

# Mapping option -> samba-tool create flag, for attributes applied at creation.
_CREATE_ATTR_FLAGS = {
    "given_name": "--given-name",
    "surname": "--surname",
    "mail": "--mail-address",
    "description": "--description",
    "job_title": "--job-title",
    "department": "--department",
    "company": "--company",
    "ou": "--userou",
}


def _parse_ldif(text):
    """Parse the simple LDIF emitted by `samba-tool user show` into a dict.

    Handles RFC 2849 line folding (continuation lines start with a space) and
    base64-encoded values (`attribute:: <base64>`), which samba-tool emits
    whenever a value is not safe ASCII.
    Returns the last value seen for each attribute, which is sufficient for the
    single-valued attributes we inspect (userAccountControl, objectSid, dn).
    """
    entries = []
    open_entry = None
    for raw in text.splitlines():
        if raw.startswith(" ") and open_entry is not None:
            open_entry[2].append(raw[1:])
            continue
        if ":" not in raw:
            open_entry = None
            continue
        key, val = raw.split(":", 1)
        encoded = val.startswith(":")
        if encoded:
            val = val[1:]
        open_entry = (key.strip(), encoded, [val[1:] if val.startswith(" ") else val])
        entries.append(open_entry)

    attrs = {}
    for key, encoded, chunks in entries:
        value = "".join(chunks).strip()
        if encoded:
            try:
                value = base64.b64decode(value).decode("utf-8", "replace")
            except ValueError:
                pass
        attrs[key] = value
    return attrs


class SambaUser:
    def __init__(self, module):
        self.module = module
        self.name = module.params["name"]
        self.samba_tool = module.params["samba_tool_path"] or module.get_bin_path(
            "samba-tool", required=True
        )
        self.commands = []

    def _run(self, args, redact=False, check_rc=True):
        """Run `samba-tool <args>`; record a redacted command line on success."""
        cmd = [self.samba_tool] + args
        rc, out, err = self.module.run_command(cmd)
        if check_rc and rc != 0:
            self.module.fail_json(
                msg="samba-tool failed: %s" % (err.strip() or out.strip()),
                rc=rc,
                cmd=" ".join(args[:2] + [self.name]) if redact else " ".join(args),
            )
        if redact:
            self.commands.append(" ".join(args[:2] + [self.name]))
        else:
            self.commands.append(" ".join(args))
        return rc, out, err

    def show(self):
        """Return parsed attributes if the user exists, else None."""
        cmd = [self.samba_tool, "user", "show", self.name]
        rc, out, err = self.module.run_command(cmd)
        if rc != 0:
            return None
        return _parse_ldif(out)

    @staticmethod
    def is_disabled(attrs):
        try:
            uac = int(attrs.get("userAccountControl", "0"))
        except (TypeError, ValueError):
            return False
        return bool(uac & _UAC_ACCOUNTDISABLE)

    def create_args(self):
        params = self.module.params
        args = ["user", "create", self.name]
        if params["password"]:
            args.append(params["password"])
        else:
            args.append("--random-password")
        for opt, flag in _CREATE_ATTR_FLAGS.items():
            if params.get(opt):
                args.append("%s=%s" % (flag, params[opt]))
        if params["must_change_password"]:
            args.append("--must-change-at-next-login")
        return args

    def get_group_rid(self, group_name):
        """Return the RID (int) of group_name extracted from objectSid, or fail."""
        cmd = [self.samba_tool, "group", "show", group_name]
        rc, out, err = self.module.run_command(cmd)
        if rc != 0:
            self.module.fail_json(msg="Group not found: %s" % group_name)
        sid = _parse_ldif(out).get("objectSid", "")
        if not sid.startswith("S-1-"):
            self.module.fail_json(
                msg="Unexpected objectSid format for group %s: %r" % (group_name, sid)
            )
        try:
            return int(sid.rsplit("-", 1)[-1])
        except (ValueError, IndexError):
            self.module.fail_json(msg="Cannot parse RID from objectSid: %s" % sid)

    def is_group_member(self, group_name):
        """Return True if this user is a member of group_name."""
        cmd = [self.samba_tool, "group", "listmembers", group_name]
        rc, out, err = self.module.run_command(cmd)
        if rc != 0:
            return False
        members = [m.strip().lower() for m in out.splitlines() if m.strip()]
        return self.name.lower() in members

    def set_primary_group(self, group_name, rid, dn):
        """Set primaryGroupID to rid. Ensures group membership first."""
        sam_ldb = self.module.params.get("sam_ldb_path") or "/var/lib/samba/private/sam.ldb"
        if not self.is_group_member(group_name):
            self._run(["group", "addmembers", group_name, self.name])
        ldif = (
            "dn: %s\nchangetype: modify\nreplace: primaryGroupID\nprimaryGroupID: %d\n"
            % (dn, rid)
        )
        rc, out, err = self.module.run_command(["ldbmodify", "-H", sam_ldb], data=ldif)
        if rc != 0:
            self.module.fail_json(
                msg="ldbmodify failed: %s" % (err.strip() or out.strip()), rc=rc
            )
        self.commands.append("ldbmodify %s [primaryGroupID=%d]" % (sam_ldb, rid))


def run_module():
    module = AnsibleModule(
        argument_spec=dict(
            name=dict(type="str", required=True, aliases=["username"]),
            state=dict(type="str", default="present", choices=["present", "absent"]),
            password=dict(type="str", no_log=True),
            update_password=dict(
                type="str", default="on_create", choices=["on_create", "always"]
            ),
            enabled=dict(type="bool"),
            given_name=dict(type="str"),
            surname=dict(type="str"),
            mail=dict(type="str", aliases=["mail_address"]),
            description=dict(type="str"),
            job_title=dict(type="str"),
            department=dict(type="str"),
            company=dict(type="str"),
            ou=dict(type="str"),
            must_change_password=dict(type="bool", default=False),
            primary_group=dict(type="str"),
            sam_ldb_path=dict(type="path", default="/var/lib/samba/private/sam.ldb"),
            samba_tool_path=dict(type="path"),
        ),
        supports_check_mode=True,
    )

    user = SambaUser(module)
    params = module.params
    state = params["state"]

    existing = user.show()
    changed = False
    diff_before = {"state": "present" if existing else "absent"}
    diff_after = {"state": state}

    if state == "absent":
        if existing:
            changed = True
            if not module.check_mode:
                user._run(["user", "delete", user.name])
        module.exit_json(
            changed=changed,
            user=user.name,
            commands=user.commands,
            diff={"before": diff_before, "after": diff_after},
        )

    # state == present
    if not existing:
        changed = True
        if not module.check_mode:
            user._run(user.create_args(), redact=bool(params["password"]))
        # On a freshly created account, enabled defaults to True.
        if params["enabled"] is False:
            changed = True
            if not module.check_mode:
                user._run(["user", "disable", user.name])
    else:
        # Enabled state reconciliation.
        if params["enabled"] is not None:
            currently_disabled = SambaUser.is_disabled(existing)
            want_disabled = not params["enabled"]
            diff_before["enabled"] = not currently_disabled
            diff_after["enabled"] = params["enabled"]
            if currently_disabled != want_disabled:
                changed = True
                verb = "disable" if want_disabled else "enable"
                if not module.check_mode:
                    user._run(["user", verb, user.name])

        # Password reconciliation (cannot read current password back).
        if params["password"] and params["update_password"] == "always":
            changed = True
            if not module.check_mode:
                user._run(
                    [
                        "user",
                        "setpassword",
                        user.name,
                        "--newpassword=%s" % params["password"],
                    ],
                    redact=True,
                )

    # Primary group reconciliation.
    if params.get("primary_group"):
        target_rid = user.get_group_rid(params["primary_group"])
        if existing:
            try:
                current_rid = int(existing.get("primaryGroupID", "-1"))
            except (TypeError, ValueError):
                current_rid = -1
            needs_change = current_rid != target_rid
            dn = existing.get("dn", "")
        else:
            # User was just created (or check_mode dry-run); always set.
            needs_change = True
            dn = ""
        if needs_change:
            changed = True
            diff_before["primary_group"] = str(current_rid) if existing else "N/A"
            diff_after["primary_group"] = params["primary_group"]
            if not module.check_mode:
                if not dn:
                    fresh = user.show()
                    dn = fresh.get("dn", "") if fresh else ""
                user.set_primary_group(params["primary_group"], target_rid, dn)

    module.exit_json(
        changed=changed,
        user=user.name,
        commands=user.commands,
        diff={"before": diff_before, "after": diff_after},
    )


def main():
    run_module()


if __name__ == "__main__":
    main()
