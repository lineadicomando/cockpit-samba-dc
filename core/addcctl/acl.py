# SPDX-License-Identifier: LGPL-2.1-or-later
"""The POSIX ACL of a shared folder; acl_xattr derives the Windows ACL."""

# Base entries the share root carries besides the named ones; user::rwx and
# other::--- come from mode 2770, the rest from setfacl.
_BASE_ADD = ["g::---", "d:u::rwx", "d:g::---", "d:o::---"]
_BASE_EXPECTED = [
    "user::rwx", "group::---", "other::---",
    "default:user::rwx", "default:group::---", "default:other::---",
]


def parse_getfacl(raw):
    """Entries of `getfacl -n -p -c -E`, masks left out (setfacl recomputes
    them): {"user:3000021:r-x", "default:group::---", ...}."""
    entries = set()
    for line in raw.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "mask:" not in line:
            entries.add(line)
    return entries


def expected_acl(grants):
    """ACL of the share root for grants [(tag, id, level)], tag "u" or "g"."""
    entries = set(_BASE_EXPECTED)
    for tag, posix_id, level in grants:
        perms = "rwx" if level == "write" else "r-x"
        name = "user" if tag == "u" else "group"
        entries.add("%s:%s:%s" % (name, posix_id, perms))
        entries.add("default:%s:%s:%s" % (name, posix_id, perms))
    return entries


def named_ids(entries):
    """{(tag, id)} of the named user and group entries of an ACL."""
    ids = set()
    for entry in entries:
        parts = entry.split(":")
        if parts[0] == "default":
            parts = parts[1:]
        if len(parts) == 3 and parts[1]:
            ids.add(("u" if parts[0] == "user" else "g", parts[1]))
    return ids


def setfacl_args(path, grants, stale_ids):
    """setfacl rewriting the ACL of the whole tree.

    Files created over SMB carry each principal as both a "u:" and a "g:"
    entry (winbind maps a SID as both a uid and a gid), so every id of the
    old, new and unexpected principals is cleared before the grants are
    added again: a stale "g:" entry would keep granting write access after a
    downgrade to read-only.
    """
    remove = []
    for tag, posix_id in sorted(stale_ids):
        remove += ["%s:%s" % (tag, posix_id), "d:%s:%s" % (tag, posix_id)]
    add = list(_BASE_ADD)
    for tag, posix_id, level in grants:
        entry = "%s:%s:%s" % (tag, posix_id, "rwX" if level == "write" else "r-X")
        add += [entry, "d:" + entry]
    args = ["setfacl", "-R"]
    if remove:
        args += ["-x", ",".join(remove)]
    return args + ["-m", ",".join(add), path]
