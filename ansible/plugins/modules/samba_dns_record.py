# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_dns_record
short_description: Manage DNS records of a Samba AD DC
version_added: "0.14.0"
description:
  - Set and delete the static DNS records (A, AAAA, CNAME, MX, PTR, SRV, TXT)
    of a zone served by a Samba 4 Active Directory Domain Controller, the
    same way the cockpit-samba-dc Cockpit page does.
  - With O(state=present), the records of O(type) at O(name) become exactly
    O(values); the other types at that name are left alone.
  - Runs C(addcctl dns ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
    The records are written locally in the directory, with no domain
    credentials.
  - The records the domain depends on are never changed (the C(_msdcs) zone,
    SOA and NS, the AD service records, the domain controllers' names and
    the addresses of the domain's name).
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_dns_record
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
seealso:
  - module: lineadicomando.samba_dc.samba_computer
"""

EXAMPLES = r"""
- name: A web server with two addresses
  lineadicomando.samba_dc.samba_dns_record:
    zone: school.internal
    name: www
    type: A
    values: [192.168.1.80, 192.168.1.81]
    ttl: 300

- name: Mail for the domain, and its SPF policy
  lineadicomando.samba_dc.samba_dns_record:
    zone: school.internal
    name: "@"
    type: "{{ item.type }}"
    values: "{{ item.values }}"
  loop:
    - {type: MX, values: ["mail.school.internal 10"]}
    - {type: TXT, values: ["v=spf1 mx -all"]}

- name: Drop one address
  lineadicomando.samba_dc.samba_dns_record:
    zone: school.internal
    name: www
    type: A
    values: [192.168.1.81]
    state: absent
"""

RETURN = r"""
records:
  description:
    - The records of O(name) after the change (or as they would be, in check mode), every type,
      as C(addcctl dns list) reports them.
  type: list
  elements: dict
  returned: always
commands:
  description: What was changed, or would be in check mode.
  type: list
  elements: str
  returned: always
"""

from ansible.module_utils.basic import AnsibleModule
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.addcctl import call


def request(params):
    """The input of `addcctl dns set` or `dns delete`."""
    req = {"zone": params["zone"], "name": params["name"], "type": params["type"]}
    if params["state"] == "present":
        req["values"] = params["values"]
        if params.get("ttl") is not None:
            req["ttl"] = params["ttl"]
    elif params.get("values"):
        req["values"] = params["values"]
    return req


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_dns_record"),
        required_if=[("state", "present", ("values",))],
        supports_check_mode=True,
    )
    p = module.params
    action = "set" if p["state"] == "present" else "delete"
    result = call(module, "dns", action, request(p), check=module.check_mode)
    module.exit_json(changed=result["changed"], records=result["records"], commands=result["commands"],
                     diff=result["diff"])


def main():
    run_module()


if __name__ == "__main__":
    main()
