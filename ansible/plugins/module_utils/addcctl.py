# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
"""addcctl, the core of cockpit-samba-dc, called by the modules.

addcctl runs on the DC as root: one operation per call, a JSON object on
stdin, one on stdout. It is installed by the addcctl Debian package, which
samba_dc_build installs with the Cockpit page.
"""
from __future__ import annotations

import json

SHARES_DIR = "/srv/samba/shares"
SAM_LDB = "/var/lib/samba/private/sam.ldb"


def call(module, obj, action, request, check=False):
    """The JSON result of `addcctl OBJ ACTION`, or fail_json with its error."""
    binary = module.get_bin_path("addcctl")
    if binary is None:
        module.fail_json(msg="addcctl is not installed on the DC: install the addcctl package "
                             "(samba_dc_build installs it, with the Cockpit page)")
    args = [binary, obj, action] + (["--check"] if check else [])
    rc, out, err = module.run_command(args, data=json.dumps(request), binary_data=True)
    try:
        result = json.loads(out)
    except ValueError:
        result = None
    if rc != 0 or not isinstance(result, dict) or "error" in result:
        message = result.get("error") if isinstance(result, dict) else None
        module.fail_json(msg=message or (err or out).strip() or "addcctl failed", rc=rc)
    return result


def check_fixed_paths(module):
    """shares_dir and sam_ldb_path are kept for compatibility: addcctl works
    on the paths of the DC it runs on, the defaults."""
    for option, fixed in (("shares_dir", SHARES_DIR), ("sam_ldb_path", SAM_LDB)):
        value = module.params.get(option)
        if value is not None and value.rstrip("/") != fixed:
            module.fail_json(msg="%s can only be %s: addcctl manages the shared folders there" % (option, fixed))
