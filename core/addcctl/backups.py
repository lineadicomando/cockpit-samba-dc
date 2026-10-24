# SPDX-License-Identifier: LGPL-2.1-or-later
"""Offline backups of the domain (samba-tool domain backup offline), in a
directory of the project's own: they hold the password hashes of every
account, so the directory and the archives are root's alone."""
import datetime
import os
import re

BACKUP_DIR = "/var/backups/samba-dc"
_ARCHIVE = re.compile(r"^samba-backup-.+\.tar\.bz2$")


class Backups:
    def __init__(self, runner, directory=BACKUP_DIR):
        self.runner = runner
        self.directory = directory

    def list(self):
        """The archives, newest first."""
        try:
            names = os.listdir(self.directory)
        except FileNotFoundError:
            return []
        found = []
        for name in names:
            path = os.path.join(self.directory, name)
            if not _ARCHIVE.match(name) or not os.path.isfile(path):
                continue
            st = os.stat(path)
            created = datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc)
            found.append({"name": name, "path": path, "size": st.st_size,
                          "created": created.isoformat(timespec="seconds")})
        found.sort(key=lambda b: (b["created"], b["name"]), reverse=True)
        return found

    def create(self):
        before = {b["name"] for b in self.list()}
        if not os.path.isdir(self.directory):
            self.runner.record("mkdir -m 0700 %s" % self.directory)
            if not self.runner.check:
                os.makedirs(self.directory, mode=0o700, exist_ok=True)
        self.runner.change(["samba-tool", "domain", "backup", "offline", "--targetdir=%s" % self.directory])
        if self.runner.check:
            return {"changed": True, "backup": None}
        os.chmod(self.directory, 0o700)
        new = [b for b in self.list() if b["name"] not in before]
        for b in new:
            os.chmod(b["path"], 0o600)
        return {"changed": True, "backup": new[0] if new else None}
