# SPDX-License-Identifier: LGPL-2.1-or-later
"""Home directories: /srv/samba/home/<user>, mapped as H: through homeDrive
and homeDirectory, served by the hidden registry share "home"."""
import os

from .accounts import Users, first
from .errors import AddcError
from .shares import check_principal_names
from .smbconf import parse_bool

HOMES_DIR = "/srv/samba/home"
HOME_SHARE = "home"
# Parameters the home share converges to, besides its path
_SHARE_PARAMS = {"read only": "no", "guest ok": "no", "browseable": "no",
                 "create mask": "0700", "directory mask": "0700"}


def is_home_path(path, name):
    return path == "%s/%s" % (HOMES_DIR, name) and name not in ("", ".", "..") and "/" not in name


class Homes:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner

    def _user(self, name):
        check_principal_names([name])
        users = Users(self.dc, self.runner)
        record = users._record(name)
        if record is None:
            raise AddcError('User "%s" not found' % name)
        return record

    def _ensure_share(self):
        """The "home" share: created when missing, pointed at HOMES_DIR when
        an older setup used another directory, its parameters converged."""
        shares = self.dc.shares()
        section = next((s for s in shares if s.lower() == HOME_SHARE), None)
        params = shares.get(section, {}) if section else {}
        wanted = {}
        if params.get("path") != HOMES_DIR:
            wanted["path"] = HOMES_DIR
        for param, value in _SHARE_PARAMS.items():
            current = params.get(param)
            same = (current is not None and parse_bool(current, None) == parse_bool(value, None)
                    if value in ("yes", "no") else current == value)
            if not same:
                wanted[param] = value
        if wanted:
            self.dc.update_share(section or HOME_SHARE, wanted, create=section is None)
        return bool(wanted)

    def provision(self, request):
        record = self._user(request["name"])
        name = first(record, "sAMAccountName")
        drive = request.get("drive", "H:")
        account = self.dc.posix_account(name, first(record, "objectSid"))
        if account is None:
            raise AddcError("user %s\\%s cannot be resolved through winbind; check that winbind is running"
                            % (self.dc.workgroup, name))
        uid, gid = account
        path = "%s/%s" % (HOMES_DIR, name)
        changed = False

        try:
            st = os.stat(path)
        except OSError:
            st = None
        if st is None:
            self.runner.record("mkdir %s" % path)
            if not self.runner.check:
                os.makedirs(path, exist_ok=True)
            changed = True
        if st is None or (st.st_mode & 0o7777) != 0o700:
            self.runner.record("chmod 700 %s" % path)
            if not self.runner.check:
                os.chmod(path, 0o700)
            changed = True
        # The user and its login group, by number: does not depend on winbind
        # mapping the user's SID as a group too
        if st is None or (st.st_uid, st.st_gid) != (uid, gid):
            self.runner.record("chown %d:%d %s" % (uid, gid, path))
            if not self.runner.check:
                os.chown(path, uid, gid)
            changed = True

        unc = "\\\\%s\\%s\\%s" % (self.dc.netbios_name, HOME_SHARE, name)
        attrs = {}
        if first(record, "homeDrive") != drive:
            attrs["homeDrive"] = drive
        if first(record, "homeDirectory") != unc:
            attrs["homeDirectory"] = unc
        if attrs:
            self.dc.modify(first(record, "dn"), attrs)
            changed = True
        changed = self._ensure_share() or changed
        return {"changed": changed, "home": {"name": name, "path": path, "drive": drive, "unc": unc}}

    def delete(self, request):
        """Clear homeDrive and homeDirectory; with delete_data, remove the
        folder, only when it is exactly <HOMES_DIR>/<user>."""
        record = self._user(request["name"])
        name = first(record, "sAMAccountName")
        changed = False
        attrs = {a: None for a in ("homeDrive", "homeDirectory") if first(record, a)}
        if attrs:
            self.dc.modify(first(record, "dn"), attrs)
            changed = True
        path = "%s/%s" % (HOMES_DIR, name)
        if request.get("delete_data") and is_home_path(path, name) and os.path.exists(path):
            self.runner.change(["rm", "-rf", "--one-file-system", "--", path])
            changed = True
        return {"changed": changed}
