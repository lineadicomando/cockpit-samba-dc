# SPDX-License-Identifier: LGPL-2.1-or-later
"""smb.conf values: share names, user lists, booleans."""
import re

SHARES_DIR = "/srv/samba/shares"

# smb.conf section syntax and Windows path rules forbid most of these; "%"
# would trigger variable substitution in the path, which derives from the name.
_SHARE_INVALID_CHARS = re.compile(r'["/\\\[\]:;|=,+*?<>%\x00-\x1f]')
_SHARE_NAME_MAX_LENGTH = 80
# Built-in sections, the DC shares, the home share, and names that would
# resolve to a parent directory in the derived path.
_RESERVED_SHARE_NAMES = frozenset([
    "global", "homes", "printers", "print$", "ipc$", "admin$",
    "sysvol", "netlogon", "home", ".", "..",
])


def share_name_violation(name):
    """Why name cannot be a share name, or None."""
    if not isinstance(name, str) or not name:
        return "the name is empty"
    if len(name) > _SHARE_NAME_MAX_LENGTH:
        return "the name exceeds %d characters" % _SHARE_NAME_MAX_LENGTH
    if _SHARE_INVALID_CHARS.search(name):
        return 'the name contains one of " / \\ [ ] : ; | = , + * ? < > % or a control character'
    if name != name.strip():
        return "the name starts or ends with a space"
    if name.startswith("-"):
        return "the name starts with a dash"
    if name.lower() in _RESERVED_SHARE_NAMES:
        return "the name is reserved by Samba"
    return None


def is_managed_path(path, shares_dir=SHARES_DIR):
    """Only shares whose path is exactly <shares_dir>/<name> are managed, so
    that no recursive setfacl or rm ever runs on a path addcctl did not
    create: the home share, hand-made shares, shares_dir itself."""
    prefix = shares_dir.rstrip("/") + "/"
    if not path.startswith(prefix):
        return False
    rest = path[len(prefix):]
    return rest not in ("", ".", "..") and "/" not in rest


def parse_user_list(value):
    """An smb.conf user list as [(name, kind)]: entries separated by spaces
    or commas unless quoted; "@", "+" or "&" marks a group; the "DOMAIN\\"
    prefix is dropped."""
    entries = []
    for prefix, quoted, bare in re.findall(r'([@+&]*)(?:"([^"]*)"|([^\s,"]+))', value or ""):
        raw = quoted or bare
        name = raw[raw.rfind("\\") + 1:]
        if name:
            entries.append((name, "group" if prefix else "user"))
    return entries


def format_user_list(entries, workgroup):
    return " ".join('%s"%s\\%s"' % ("@" if e["kind"] == "group" else "", workgroup, e["name"])
                    for e in entries)


def parse_bool(value, fallback):
    if value is None:
        return fallback
    v = str(value).strip().lower()
    if v in ("yes", "true", "1"):
        return True
    if v in ("no", "false", "0"):
        return False
    return fallback


def share_access(params):
    """Access entries of a share: "valid users", read-only where "read list"
    (or a read-only share without "write list") says so, as smbd decides."""
    if params.get("read only") is not None:
        read_only = parse_bool(params["read only"], True)
    else:
        writeable = params.get("writeable", params.get("writable", params.get("write ok")))
        read_only = not parse_bool(writeable, False)
    read_list = {(n.lower(), k) for n, k in parse_user_list(params.get("read list", ""))}
    write_list = {(n.lower(), k) for n, k in parse_user_list(params.get("write list", ""))}
    access = []
    for name, kind in parse_user_list(params.get("valid users", "")):
        key = (name.lower(), kind)
        can_write = key not in read_list and (not read_only or key in write_list)
        access.append({"name": name, "kind": kind, "level": "write" if can_write else "read"})
    return access


def access_key(entries):
    """Order- and case-insensitive identity of an access list."""
    return sorted((e["name"].lower(), e["kind"], e["level"]) for e in entries)
