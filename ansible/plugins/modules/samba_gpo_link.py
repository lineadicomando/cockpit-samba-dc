# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

DOCUMENTATION = r"""
---
module: samba_gpo_link
short_description: Link Group Policy objects of a Samba AD DC to the domain or an OU
version_added: "0.14.0"
description:
  - Link an existing Group Policy object (GPO) of a Samba 4 Active Directory
    Domain Controller to the domain or to an organizational unit, change the
    flags of the link (enforced, disabled), or remove it.
  - A new link gets the lowest precedence among the links of its container;
    the precedence of the other links is left alone.
  - The default GPOs (Default Domain Policy, Default Domain Controllers
    Policy) and the drive-mapping GPO of cockpit-samba-dc
    (C(Cockpit - Mapped drives)) stay linked where they are; their links
    there cannot be removed or disabled.
  - Runs C(addcctl gpo ...), the core of cockpit-samba-dc, on the domain
    controller itself; it needs elevated privileges (typically C(become=true)).
    The links are written locally in the directory, with no domain
    credentials.
extends_documentation_fragment:
  - lineadicomando.samba_dc.options.samba_gpo_link
author:
  - Alessandro Gagliano (@lineadicomando)
notes:
  - Supports check mode (C(addcctl --check)) and diff.
  - The C(addcctl) Debian package must be installed on the DC (the
    samba_dc_build role installs it).
  - The GPO must exist; this module does not create or delete GPOs.
seealso:
  - module: lineadicomando.samba_dc.samba_ou
"""

EXAMPLES = r"""
- name: Apply a GPO to the students' OU
  lineadicomando.samba_dc.samba_gpo_link:
    gpo: Students lockdown
    container: OU=Students,OU=School

- name: Enforce a GPO on the whole domain
  lineadicomando.samba_dc.samba_gpo_link:
    gpo: "{6AC1786C-016F-11D2-945F-00C04FB984F9}"
    container: ""
    enforced: true

- name: Keep the link but stop applying the GPO there
  lineadicomando.samba_dc.samba_gpo_link:
    gpo: Students lockdown
    container: OU=Students,OU=School
    disabled: true

- name: Remove the link
  lineadicomando.samba_dc.samba_gpo_link:
    gpo: Students lockdown
    container: OU=Students,OU=School
    state: absent
"""

RETURN = r"""
gpo:
  description:
    - The GPO after the change (or as it would be, in check mode), with every place it is linked to,
      as C(addcctl gpo get) reports it.
  type: dict
  returned: always
  contains:
    guid:
      description: The GPO's GUID, in braces.
      type: str
    name:
      description: The GPO's display name.
      type: str
    links:
      description: Where it is linked, each as in RV(link).
      type: list
      elements: dict
link:
  description:
    - The link to O(container) after the change; null when there is none (O(state=absent)).
  type: dict
  returned: always
  contains:
    container:
      description: The OU, relative to the domain; empty for the domain.
      type: str
    enforced:
      description: Whether the link is enforced.
      type: bool
    disabled:
      description: Whether the link is disabled.
      type: bool
    order:
      description: The link's precedence in its container, 1 the highest.
      type: int
    protected:
      description: Whether the link cannot be removed or disabled.
      type: bool
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
    """The input of `addcctl gpo link` or `gpo unlink`."""
    req = {"gpo": params["gpo"], "container": params["container"] or ""}
    if params["state"] == "present":
        for flag in ("enforced", "disabled"):
            if params.get(flag) is not None:
                req[flag] = params[flag]
    return req


def run_module():
    module = AnsibleModule(
        argument_spec=argument_spec("samba_gpo_link"),
        supports_check_mode=True,
    )
    p = module.params
    action = "link" if p["state"] == "present" else "unlink"
    result = call(module, "gpo", action, request(p), check=module.check_mode)
    module.exit_json(changed=result["changed"], gpo=result["gpo"], link=result["diff"]["after"],
                     commands=result["commands"], diff=result["diff"])


def main():
    run_module()


if __name__ == "__main__":
    main()
