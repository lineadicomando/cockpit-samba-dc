# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_password_policy
short_description: Manage the password and lockout policy of a Samba AD domain
version_added: "0.11.0"
description:
  - Bring the domain password policy (complexity, length, history, ages) and
    the account lockout policy to the given settings, the same way the
    cockpit-samba-dc Cockpit page does; settings left unset keep their value.
  - The ranges and checks are those of C(samba-tool domain passwordsettings
    set); the lockout window must not be longer than the lockout duration.
  - Runs C(addcctl domain set-password-policy), the core of cockpit-samba-dc,
    on the domain controller itself; it needs elevated privileges (typically
    C(become=true)).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_password_policy
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The policy applies to every account without a fine-grained policy (PSO).
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
"""

EXAMPLES = r"""
- name: Long passwords that do not expire, accounts locked for 15 minutes
  lineadicomando.samba_dc.samba_password_policy:
    complexity: true
    min_length: 12
    max_age_days: 0
    lockout_threshold: 5
    lockout_duration_minutes: 15
    lockout_window_minutes: 15
"""

RETURN = r"""
policy:
  description: The policy, after the change (or as it would be, in check mode).
    C(null) for an age or an interval means never.
  type: dict
  returned: always
  sample:
    complexity: true
    min_length: 12
    history_length: 24
    min_age_days: 1
    max_age_days: null
    lockout_threshold: 5
    lockout_duration_minutes: 15
    lockout_window_minutes: 15
commands:
  description: What was changed, or would be in check mode.
  type: list
  elements: str
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call

SETTINGS = ("complexity", "min_length", "history_length", "min_age_days", "max_age_days",
            "lockout_threshold", "lockout_duration_minutes", "lockout_window_minutes")
# 0 means never for these, as in samba-tool; addcctl takes null
NEVER_AT_ZERO = ("max_age_days", "lockout_duration_minutes", "lockout_window_minutes")


def build_request(params):
    """The settings given, as addcctl takes them."""
    request = {}
    for key in SETTINGS:
        value = params.get(key)
        if value is None:
            continue
        request[key] = None if key in NEVER_AT_ZERO and value == 0 else value
    return request


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_password_policy"),
        supports_check_mode=True,
    )
    result = call(module, "domain", "set-password-policy", build_request(module.params), check=module.check_mode)
    module.exit_json(changed=result["changed"], policy=result["policy"], commands=result["commands"],
                     diff=result["diff"])


def main():
    run_module()


if __name__ == "__main__":
    main()
