# SPDX-License-Identifier: LGPL-2.1-or-later
"""Commands and file writes, recorded, and skipped in check mode.

Commands are argv lists, never a shell. Secrets go on stdin (input), which
is neither recorded nor logged.
"""
import os
import subprocess

from .errors import AddcError


class Runner:
    def __init__(self, check=False):
        self.check = check
        # What a mutation did, or would do in check mode
        self.commands = []

    def query(self, args, input=None, ok=(0,)):
        """Run a read-only command; its output, or AddcError."""
        try:
            proc = subprocess.run(args, input=input, capture_output=True, text=True)
        except FileNotFoundError:
            raise AddcError("%s is not installed" % args[0]) from None
        if proc.returncode not in ok:
            message = (proc.stderr or proc.stdout).strip()
            raise AddcError("%s failed: %s" % (" ".join(args[:3]), message or "exit code %d" % proc.returncode))
        return proc.stdout

    def change(self, args, input=None):
        """Run a mutating command; recorded, skipped in check mode."""
        self.commands.append(" ".join(args))
        if self.check:
            return ""
        return self.query(args, input=input)

    def record(self, description):
        """A change made without a command (a library call)."""
        self.commands.append(description)

    def write_file(self, path, content):
        """Write path aside and rename it, so that readers never see half a
        file. The new file takes the attributes of the one it replaces (mode,
        owner, xattrs: the NT ACL in security.NTACL and the POSIX ACL).
        Returns False when there was none to take them from."""
        self.commands.append("write %s" % path)
        if self.check:
            return os.path.exists(path)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(content.encode("utf-8"))
        os.chmod(tmp, 0o644)
        kept = os.path.exists(path)
        if kept:
            proc = subprocess.run(
                ["cp", "--attributes-only", "--preserve=mode,ownership,xattr", path, tmp],
                capture_output=True)
            kept = proc.returncode == 0
        os.rename(tmp, path)
        return kept
