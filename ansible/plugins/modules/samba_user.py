# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_user
short_description: Manage users of a Samba AD DC
version_added: "0.9.0"
description:
  - Create, change and delete the users of a Samba 4 Active Directory Domain
    Controller, the same way the cockpit-samba-dc Cockpit page does.
  - Runs C(addcctl user ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
  - Settings left unset keep their current value. The built-in accounts are
    protected by addcctl, which refuses to delete them, to change the status
    of Administrator and krbtgt, or to give a system account an expiry date.
options:
  name:
    description: sAMAccountName of the user.
    type: str
    required: true
  state:
    description:
      - C(present) creates the user when it is missing (then O(password) is
        required) and brings it to the given settings; C(absent) deletes it.
      - Shared folders keep listing a deleted user, so that none is left open
        to every domain user.
    type: str
    choices: [present, absent]
    default: present
  password:
    description:
      - Password, set when the user is created, or on every run with
        O(update_password=always).
    type: str
  update_password:
    description:
      - C(on_create) sets O(password) only when the user is created;
        C(always) sets it on every run, which then always reports a change.
    type: str
    choices: [on_create, always]
    default: on_create
  must_change_password:
    description: Ask for a new password at the next logon, when the password is set.
    type: bool
    default: false
  given_name:
    description: Given name.
    type: str
  surname:
    description: Surname.
    type: str
  email:
    description: E-mail address; an empty string removes it.
    type: str
    aliases: [mail]
  description:
    description: Description; an empty string removes it.
    type: str
  title:
    description: Job title; an empty string removes it.
    type: str
    aliases: [job_title]
  department:
    description: Department; an empty string removes it.
    type: str
  company:
    description: Company; an empty string removes it.
    type: str
  ou:
    description:
      - Container the user is created in, relative to the domain (e.g.
        C(OU=Students)). Only used when the user is created.
    type: str
  enabled:
    description: Whether the account can log on.
    type: bool
  expires:
    description:
      - When the account stops working, ISO 8601 with a time zone (e.g.
        C(2027-07-01T00:00:00+02:00)); C(never) removes the expiry.
    type: str
  groups:
    description: Groups of the user, the primary group aside; see O(groups_mode).
    type: list
    elements: str
  groups_mode:
    description: C(replace) makes O(groups) the whole list, C(append) adds them, C(remove) drops them.
    type: str
    choices: [replace, append, remove]
    default: replace
  primary_group:
    description: Primary group; the user must belong to it, through O(groups) or already.
    type: str
  new_name:
    description: Rename the user; its shared folders follow the new name.
    type: str
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: A user, created with an initial password changed at the first logon
  lineadicomando.samba_dc.samba_user:
    name: mrossi
    password: "{{ initial_password }}"
    must_change_password: true
    given_name: Mario
    surname: Rossi
    groups: [Staff]
    primary_group: Staff

- name: Expire an account at the end of June
  lineadicomando.samba_dc.samba_user:
    name: mrossi
    expires: "2027-07-01T00:00:00+02:00"

- name: Delete a user
  lineadicomando.samba_dc.samba_user:
    name: mrossi
    state: absent
"""

RETURN = r"""
user:
  description: The user after the change (before it, in check mode), as C(addcctl user get) reports it.
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

# Core setting -> module parameter
FIELDS = dict(given_name="given_name", surname="surname", email="email", description="description",
              title="title", department="department", company="company")


def settings(params):
    """The input of `addcctl user set` besides the name."""
    request = given(params, FIELDS)
    request.update(given(params, dict(enabled="enabled", groups="groups", primary_group="primary_group",
                                      new_name="new_name")))
    if params.get("groups") is not None:
        request["groups_mode"] = params["groups_mode"]
    if params.get("expires") is not None:
        request["expires"] = None if params["expires"].lower() == "never" else params["expires"]
    return request


def run_module():
    module = AnsibleModule(
        argument_spec=dict(
            name=dict(type="str", required=True),
            state=dict(type="str", default="present", choices=["present", "absent"]),
            password=dict(type="str", no_log=True),
            update_password=dict(type="str", default="on_create", choices=["on_create", "always"]),
            must_change_password=dict(type="bool", default=False),
            given_name=dict(type="str"),
            surname=dict(type="str"),
            email=dict(type="str", aliases=["mail"]),
            description=dict(type="str"),
            title=dict(type="str", aliases=["job_title"]),
            department=dict(type="str"),
            company=dict(type="str"),
            ou=dict(type="str"),
            enabled=dict(type="bool"),
            expires=dict(type="str"),
            groups=dict(type="list", elements="str"),
            groups_mode=dict(type="str", default="replace", choices=["replace", "append", "remove"]),
            primary_group=dict(type="str"),
            new_name=dict(type="str"),
        ),
        supports_check_mode=True,
    )
    p = module.params
    check = module.check_mode
    before = get(module, "user", p["name"])
    commands = []

    if p["state"] == "absent":
        if before is None:
            module.exit_json(changed=False, commands=[])
        result = call(module, "user", "delete", {"name": p["name"]}, check=check)
        module.exit_json(changed=result["changed"], commands=result["commands"],
                         diff=dict(before=before, after={}))

    rest = settings(p)
    changed = False
    if before is None:
        if not p["password"]:
            module.fail_json(msg='User "%s" not found: give a password to create it' % p["name"])
        create = dict(given(p, FIELDS), name=p["name"], password=p["password"],
                      must_change_password=p["must_change_password"])
        if p["ou"]:
            create["ou"] = p["ou"]
        if p["groups"] and p["groups_mode"] != "remove":
            create["groups"] = p["groups"]
        result = call(module, "user", "create", create, check=check)
        commands += result["commands"]
        changed = True
        # The rest applies to the new user, which check mode did not create
        for key in list(FIELDS) + ["groups", "groups_mode"]:
            rest.pop(key, None)
        if check:
            rest = {}
    elif p["password"] and p["update_password"] == "always":
        result = call(module, "user", "password", {"name": p["name"], "password": p["password"],
                                                   "must_change": p["must_change_password"]}, check=check)
        commands += result["commands"]
        changed = True

    user = before
    if rest:
        result = call(module, "user", "set", dict(rest, name=p["name"]), check=check)
        commands += result["commands"]
        changed = changed or result["changed"]
        user = result["user"]
    elif before is None and not check:
        user = get(module, "user", p["name"])
    module.exit_json(changed=changed, user=user, commands=commands, diff=dict(before=before or {}, after=user or {}))


def main():
    run_module()


if __name__ == "__main__":
    main()
