# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared folders on a Samba AD DC, compatible with cockpit-samba-dc.

The on-disk and in-directory model is the one cockpit-samba-dc uses
(src/lib/shares.ts and src/lib/drivemaps.ts), so that a share created here
shows up in the Cockpit UI and vice versa:

- a shared folder is a registry share ("net conf") whose path is
  <shares_dir>/<name>; shares with a path elsewhere are never touched;
- access is enforced twice: by "valid users" (plus "read list" for read-only
  entries) and by a POSIX ACL on the folder tree, from which acl_xattr
  derives the Windows ACL;
- a share can be mapped as a network drive at logon through one dedicated
  GPO, "Cockpit - Mapped drives", whose Group Policy Preferences Drives.xml
  holds one <Drive> per mapped share, targeted at the share's principals.
"""
from __future__ import annotations

import base64
import datetime
import os
import re
import uuid

SHARES_DIR = "/srv/samba/shares"
SAM_LDB = "/var/lib/samba/private/sam.ldb"

DRIVE_MAP_GPO_NAME = "Cockpit - Mapped drives"
# E-Z except H (home directories); A-C are reserved, D is usually optical.
DRIVE_LETTERS = "EFGIJKLMNOPQRSTUVWXYZ"

_DRIVES_CLSID = "{8FDDCC1A-0C3C-43cd-A6B4-71A6DF20DA8C}"
_DRIVE_CLSID = "{935D1B74-9CB8-4e3c-9914-7DD559B7A417}"
# Client-side extensions that process Group Policy Preferences drive maps.
_USER_EXTENSION_NAMES = (
    "[{00000000-0000-0000-0000-000000000000}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]"
    "[{5794DAFD-BE60-433F-88A2-1A31939AC01F}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]"
)
# The user-side GPO version lives in the high 16 bits; clients only reapply
# a GPO whose version has changed.
_USER_VERSION_STEP = 65536

# smb.conf section syntax and Windows path rules forbid most of these; "%"
# would trigger variable substitution in the path, which derives from the name.
_SHARE_INVALID_CHARS = re.compile(r'["/\\\[\]:;|=,+*?<>%\x00-\x1f]')
_SHARE_NAME_MAX_LENGTH = 80
_RESERVED_SHARE_NAMES = frozenset([
    "global", "homes", "printers", "print$", "ipc$", "admin$",
    "sysvol", "netlogon", "home", ".", "..",
])

# --- share names and smb.conf values ---------------------------------------


def validate_share_name(name):
    """Return why name cannot be a share name, or None when it can."""
    if not name:
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


def parse_net_conf(raw):
    """Parse "net conf list" into {section: {lowercased param: value}}."""
    sections = {}
    current = None
    for line in raw.splitlines():
        header = re.match(r"^\s*\[(.+)\]\s*$", line)
        if header:
            current = sections[header.group(1)] = {}
            continue
        key, sep, value = line.partition("=")
        if current is None or not sep or not key.strip():
            continue
        current[key.strip().lower()] = value.strip()
    return sections


def parse_smb_user_list(value):
    """Parse an smb.conf user list into [(name, kind)].

    Entries are separated by spaces or commas unless quoted; a leading "@",
    "+" or "&" marks a group; the "DOMAIN\\" prefix is stripped.
    """
    entries = []
    for prefix, quoted, bare in re.findall(r'([@+&]*)(?:"([^"]*)"|([^\s,"]+))', value or ""):
        raw = quoted or bare
        name = raw[raw.rfind("\\") + 1:]
        if name:
            entries.append((name, "group" if prefix else "user"))
    return entries


def parse_smb_bool(value, fallback):
    if value is None:
        return fallback
    v = value.strip().lower()
    if v in ("yes", "true", "1"):
        return True
    if v in ("no", "false", "0"):
        return False
    return fallback


def is_managed_path(path, shares_dir=SHARES_DIR):
    """Only shares under shares_dir are managed: never setfacl -R or rm -rf
    a path this code did not create (the home share, hand-made shares)."""
    prefix = shares_dir.rstrip("/") + "/"
    return path.startswith(prefix) and ".." not in path[len(prefix):].split("/")


def share_access(params):
    """Access entries of a share, as cockpit reads them back."""
    if params.get("read only") is not None:
        read_only = parse_smb_bool(params["read only"], True)
    else:
        writeable = params.get("writeable", params.get("writable", params.get("write ok")))
        read_only = not parse_smb_bool(writeable, False)
    read_list = set((n.lower(), k) for n, k in parse_smb_user_list(params.get("read list", "")))
    write_list = set((n.lower(), k) for n, k in parse_smb_user_list(params.get("write list", "")))
    access = []
    for name, kind in parse_smb_user_list(params.get("valid users", "")):
        key = (name.lower(), kind)
        can_write = key not in read_list and (not read_only or key in write_list)
        access.append({"name": name, "kind": kind, "level": "write" if can_write else "read"})
    return access


def format_user_list(entries, workgroup):
    return " ".join(
        '%s"%s\\%s"' % ("@" if e["kind"] == "group" else "", workgroup, e["name"])
        for e in entries
    )


def access_key(entries):
    """Order- and case-insensitive identity of an access list."""
    return sorted((e["name"].lower(), e["kind"], e["level"]) for e in entries)


# --- LDIF --------------------------------------------------------------------


def parse_ldif_records(raw):
    """Parse ldbsearch output into a list of {attribute: [values]}.

    Handles comments, RFC 2849 line folding and base64 values ("attr:: ...").
    Referral records ("ref:" only) are dropped.
    """
    records = []
    current = {}
    last = None
    for line in raw.splitlines():
        if line.startswith("#"):
            continue
        if not line.strip():
            if current:
                records.append(current)
            current, last = {}, None
            continue
        if line.startswith(" ") and last is not None:
            last[1].append(line[1:])
            continue
        key, sep, value = line.partition(":")
        if not sep:
            last = None
            continue
        encoded = value.startswith(":")
        if encoded:
            value = value[1:]
        last = [key.strip(), [value[1:] if value.startswith(" ") else value], encoded]
        current.setdefault(last[0], []).append(last)
    if current:
        records.append(current)

    result = []
    for record in records:
        attrs = {}
        for key, entries in record.items():
            values = []
            for entry in entries:
                value = "".join(entry[1])
                if entry[2]:
                    try:
                        value = base64.b64decode(value).decode("utf-8", "replace")
                    except ValueError:
                        pass
                values.append(value.strip())
            attrs[key] = values
        if "dn" in attrs:
            result.append(attrs)
    return result


def first(attrs, key, default=""):
    values = attrs.get(key) or [default]
    return values[0]


def escape_ldap_filter(value):
    """RFC 4515: sAMAccountName may contain "(", ")" and "*"."""
    return re.sub(r"[\\*()\x00]", lambda m: "\\%02x" % ord(m.group(0)), value)


# --- POSIX ACL ---------------------------------------------------------------

# Base entries the share root must carry besides the named ones; user::rwx and
# other::--- come from mode 2770, the rest from setfacl.
_ACL_BASE_ADD = ["g::---", "d:u::rwx", "d:g::---", "d:o::---"]
_ACL_BASE_EXPECTED = [
    "user::rwx", "group::---", "other::---",
    "default:user::rwx", "default:group::---", "default:other::---",
]


def parse_getfacl(raw):
    """Entries of `getfacl -n -p -c -E`, without the masks (recomputed by
    setfacl) — e.g. {"user:3000021:r-x", "default:group::---"}."""
    entries = set()
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "mask:" in line:
            continue
        entries.add(line)
    return entries


def expected_acl(grants):
    """ACL of the share root for grants [(tag, id, level)], tag "u" or "g"."""
    entries = set(_ACL_BASE_EXPECTED)
    for tag, posix_id, level in grants:
        perms = "rwx" if level == "write" else "r-x"
        name = "user" if tag == "u" else "group"
        entries.add("%s:%s:%s" % (name, posix_id, perms))
        entries.add("default:%s:%s:%s" % (name, posix_id, perms))
    return entries


def named_acl_ids(entries):
    """{(tag, id)} of the named user/group entries of an ACL."""
    ids = set()
    for entry in entries:
        parts = entry.split(":")
        if parts[0] == "default":
            parts = parts[1:]
        if len(parts) == 3 and parts[1]:
            ids.add(("u" if parts[0] == "user" else "g", parts[1]))
    return ids


def setfacl_args(path, grants, stale_ids):
    """setfacl command rewriting the ACL of the whole tree.

    Files created over SMB carry each principal as both a "u:" and a "g:"
    entry (winbind maps a SID as both a uid and a gid), so every id of the
    old, new and unexpected principals is cleared before the current grants
    are re-added: a stale "g:" entry would otherwise keep granting write
    access after a downgrade to read-only.
    """
    remove = []
    for tag, posix_id in sorted(stale_ids):
        remove += ["%s:%s" % (tag, posix_id), "d:%s:%s" % (tag, posix_id)]
    add = list(_ACL_BASE_ADD)
    for tag, posix_id, level in grants:
        entry = "%s:%s:%s" % (tag, posix_id, "rwX" if level == "write" else "r-X")
        add += [entry, "d:" + entry]
    args = ["setfacl", "-R"]
    if remove:
        args += ["-x", ",".join(remove)]
    return args + ["-m", ",".join(add), path]


# --- Drives.xml --------------------------------------------------------------


def xml_escape(value):
    return (value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def xml_unescape(value):
    return (value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
            .replace("&apos;", "'").replace("&amp;", "&"))


def _xml_attr(tag, name):
    m = re.search(r'\s%s="([^"]*)"' % name, tag)
    return xml_unescape(m.group(1)) if m else ""


def parse_drives_xml(raw):
    """<Drive> items of a Drives.xml, keeping each item's original XML so that
    entries this code does not own are rewritten untouched."""
    drives = []
    for m in re.finditer(r"<Drive\s[\s\S]*?</Drive>", raw or ""):
        xml = m.group(0)
        drive_tag = re.search(r"<Drive\s[^>]*>", xml)
        props = re.search(r"<Properties\s[^>]*>", xml)
        filters = re.search(r"<Filters>[\s\S]*?</Filters>", xml)
        drive_tag = drive_tag.group(0) if drive_tag else ""
        props = props.group(0) if props else ""
        drives.append({
            "uid": _xml_attr(drive_tag, "uid"),
            "path": _xml_attr(props, "path"),
            "letter": _xml_attr(props, "letter").upper(),
            "label": _xml_attr(props, "label"),
            "filters": filters.group(0) if filters else "",
            "xml": xml,
        })
    return drives


def filter_targets(filters):
    """Order-insensitive identity of a <Filters> block: {(kind, sid)}."""
    targets = set()
    for kind, tag in re.findall(r"<Filter(User|Group)\s([^>]*)>", filters or ""):
        targets.add((kind.lower(), _xml_attr(" " + tag, "sid")))
    return targets


def build_filters_xml(principals, workgroup):
    """Any listed principal matches ("OR"); userContext evaluates group
    membership for the logged-on user rather than for the computer."""
    items = []
    for p in principals:
        name = xml_escape("%s\\%s" % (workgroup, p["name"]))
        if p["kind"] == "group":
            items.append('<FilterGroup bool="OR" not="0" name="%s" sid="%s" userContext="1" '
                         'primaryGroup="0" localGroup="0"/>' % (name, p["sid"]))
        else:
            items.append('<FilterUser bool="OR" not="0" name="%s" sid="%s"/>' % (name, p["sid"]))
    return "<Filters>%s</Filters>" % "".join(items)


def build_drive_xml(uid, changed, path, letter, label, filters):
    letter = letter.upper()
    return (
        '<Drive clsid="%s" name="%s:" status="%s:" image="2" changed="%s" uid="%s" bypassErrors="1">'
        '<Properties action="U" thisDrive="NOCHANGE" allDrives="NOCHANGE" userName="" path="%s" '
        'label="%s" persistent="0" useLetter="1" letter="%s"/>%s</Drive>'
        % (_DRIVE_CLSID, letter, letter, changed, uid, xml_escape(path), xml_escape(label), letter, filters)
    )


def build_drives_xml(drives):
    return '<?xml version="1.0" encoding="utf-8"?>\r\n<Drives clsid="%s">%s</Drives>\r\n' % (
        _DRIVES_CLSID, "".join(drives))


def gpt_ini(version):
    return "[General]\r\nVersion=%d\r\ndisplayName=%s\r\n" % (version, DRIVE_MAP_GPO_NAME)


def new_guid():
    return "{%s}" % str(uuid.uuid4()).upper()


def normalize_drive_letter(letter):
    return (letter or "").strip().rstrip(":").upper()


# --- the DC ------------------------------------------------------------------


class SambaShares:
    """Reads and changes shared folders on the local DC.

    Mutating helpers honour check mode themselves: they report what they
    would change and only touch the system when check mode is off.
    """

    def __init__(self, module, shares_dir=SHARES_DIR, sam_ldb=SAM_LDB):
        self.module = module
        self.shares_dir = shares_dir.rstrip("/")
        self.sam_ldb = sam_ldb
        self.commands = []
        self._smbconf = {}
        self._base_dn = None
        self._posix_ids = {}

    # -- plumbing

    def run(self, args, data=None, check_rc=True, record=True):
        rc, out, err = self.module.run_command(args, data=data)
        if check_rc and rc != 0:
            self.module.fail_json(
                msg="%s failed: %s" % (args[0], (err or out).strip()),
                rc=rc, cmd=" ".join(args), stdout=out, stderr=err,
            )
        if record:
            self.commands.append(" ".join(args))
        return rc, out, err

    def query(self, args, check_rc=True):
        """Read-only command: not recorded among the changes."""
        return self.run(args, check_rc=check_rc, record=False)

    def change(self, args, data=None):
        """Mutating command, skipped (but recorded) in check mode."""
        if self.module.check_mode:
            self.commands.append(" ".join(args))
            return ""
        return self.run(args, data=data)[1]

    def smbconf(self, name, section="global"):
        """Read from the local config rather than "samba-tool domain info",
        a CLDAP network query that fails when Samba skips loopback."""
        key = (section, name)
        if key not in self._smbconf:
            args = ["testparm", "-s", "--parameter-name=%s" % name]
            if section != "global":
                args.append("--section-name=%s" % section)
            value = self.query(args)[1].strip()
            if not value:
                self.module.fail_json(msg='Cannot determine "%s" from smb.conf' % name)
            self._smbconf[key] = value
        return self._smbconf[key]

    @property
    def workgroup(self):
        return self.smbconf("workgroup")

    @property
    def netbios_name(self):
        return self.smbconf("netbios name")

    @property
    def base_dn(self):
        if self._base_dn is None:
            out = self.query(["ldbsearch", "-H", self.sam_ldb, "-s", "base", "-b", "",
                              "defaultNamingContext"])[1]
            records = parse_ldif_records(out)
            self._base_dn = first(records[0], "defaultNamingContext") if records else ""
            if not self._base_dn:
                self.module.fail_json(msg="Cannot read defaultNamingContext from %s" % self.sam_ldb)
        return self._base_dn

    # -- shares

    def net_conf(self):
        return parse_net_conf(self.query(["net", "conf", "list"])[1])

    def find_section(self, name, conf=None):
        """(registry name, params) of a share, matched case-insensitively."""
        conf = self.net_conf() if conf is None else conf
        for section, params in conf.items():
            if section.lower() == name.lower():
                return section, params
        return None, None

    def describe(self, name, params, mappings):
        return {
            "name": name,
            "path": params.get("path", ""),
            "comment": params.get("comment", ""),
            "browseable": parse_smb_bool(params.get("browseable", params.get("browsable")), True),
            "access": share_access(params),
            "drive": mappings.get(name.lower()),
        }

    def list_shares(self):
        mappings = self.drive_mappings()
        return [
            self.describe(name, params, mappings)
            for name, params in self.net_conf().items()
            if is_managed_path(params.get("path", ""), self.shares_dir)
        ]

    def set_params(self, share, current, desired):
        """Converge share parameters; desired maps param -> value or None
        (parameter must be absent). Returns True when something changed."""
        changed = False
        for param, value in desired.items():
            if value is None:
                if param in current:
                    self.change(["net", "conf", "delparm", share, param])
                    changed = True
            elif current.get(param) != value:
                self.change(["net", "conf", "setparm", share, param, value])
                changed = True
        return changed

    # -- principals

    def resolve_principals(self, names):
        """{lowercased name: {name, kind, sid}} for the names found in the
        directory; kind is taken from objectClass."""
        if not names:
            return {}
        flt = "(|%s)" % "".join("(sAMAccountName=%s)" % escape_ldap_filter(n) for n in names)
        out = self.query(["ldbsearch", "-H", self.sam_ldb, "-b", self.base_dn, flt,
                          "sAMAccountName", "objectSid", "objectClass"])[1]
        found = {}
        for attrs in parse_ldif_records(out):
            sam = first(attrs, "sAMAccountName")
            if not sam:
                continue
            classes = [c.lower() for c in attrs.get("objectClass", [])]
            found[sam.lower()] = {
                "name": sam,
                "kind": "group" if "group" in classes else "user",
                "sid": first(attrs, "objectSid"),
            }
        return found

    def posix_ids(self, name):
        """{"u": uid, "g": gid} of a domain principal through NSS (winbind);
        a missing mapping is absent. Users usually map to both (ID_TYPE_BOTH),
        well-known groups such as "Domain Users" only to a gid."""
        key = name.lower()
        if key not in self._posix_ids:
            ids = {}
            qualified = "%s\\%s" % (self.workgroup, name)
            for tag, database in (("u", "passwd"), ("g", "group")):
                rc, out, err = self.query(["getent", database, qualified], check_rc=False)
                fields = out.strip().split(":")
                if rc == 0 and len(fields) > 2 and fields[2].isdigit():
                    ids[tag] = fields[2]
            self._posix_ids[key] = ids
        return self._posix_ids[key]

    # -- POSIX ACL

    def acl_grants(self, access):
        """[(tag, id, level)] for the access list; fails on principals NSS
        cannot resolve, since setfacl needs a uid/gid."""
        grants = []
        for entry in access:
            ids = self.posix_ids(entry["name"])
            tag = "g" if entry["kind"] == "group" else "u"
            if tag not in ids:
                self.module.fail_json(
                    msg="%s %s\\%s cannot be resolved to a %s through NSS; check that winbind "
                        "is listed in /etc/nsswitch.conf on the DC"
                        % (entry["kind"], self.workgroup, entry["name"], "gid" if tag == "g" else "uid"))
            grants.append((tag, ids[tag], entry["level"]))
        return grants

    def ensure_root(self, path):
        """Directory owned by root, mode 2770 (setgid keeps new files in the
        directory's group). Returns True when it had to change."""
        try:
            st = os.stat(path)
        except OSError:
            st = None
        if st is not None and st.st_uid == 0 and st.st_gid == 0 and (st.st_mode & 0o2000):
            return False
        if st is None:
            self.change(["mkdir", "-p", path])
        self.change(["chown", "root:root", path])
        self.change(["chmod", "2770", path])
        return True

    def ensure_acl(self, path, access, old_access):
        """Rewrite the tree's ACL when the root's differs from the expected
        one. Returns True when it did."""
        grants = self.acl_grants(access)
        expected = expected_acl(grants)
        current = set()
        if os.path.isdir(path):
            current = parse_getfacl(self.query(["getfacl", "-n", "-p", "-c", "-E", path])[1])
        if current == expected:
            return False
        # Every id of the old and new principals, plus any named entry the
        # root carries unexpectedly; the grants themselves are re-added.
        stale = named_acl_ids(current)
        for entry in list(access) + list(old_access):
            stale |= set(self.posix_ids(entry["name"]).items())
        stale -= set((tag, posix_id) for tag, posix_id, level in grants)
        self.change(setfacl_args(path, grants, stale))
        return True

    # -- drive mapping GPO

    def _sysvol_dir(self, guid):
        realm = self.smbconf("realm").lower()
        return "%s/%s/Policies/%s" % (self.smbconf("path", "sysvol"), realm, guid)

    def find_gpo(self):
        out = self.query([
            "ldbsearch", "-H", self.sam_ldb, "-b", "CN=Policies,CN=System,%s" % self.base_dn,
            "-s", "one",
            "(&(objectClass=groupPolicyContainer)(displayName=%s))" % escape_ldap_filter(DRIVE_MAP_GPO_NAME),
            "cn", "versionNumber",
        ])[1]
        for attrs in parse_ldif_records(out):
            if first(attrs, "cn"):
                try:
                    version = int(first(attrs, "versionNumber", "0"))
                except ValueError:
                    version = 0
                return {"guid": first(attrs, "cn"), "dn": first(attrs, "dn"), "version": version}
        return None

    def read_drives(self, gpo):
        path = "%s/USER/Preferences/Drives/Drives.xml" % self._sysvol_dir(gpo["guid"])
        try:
            with open(path, "rb") as f:
                return f.read().decode("utf-8", "replace")
        except (IOError, OSError):
            return ""

    def drive_entries(self):
        gpo = self.find_gpo()
        return gpo, (parse_drives_xml(self.read_drives(gpo)) if gpo else [])

    def unc_path(self, share):
        return "\\\\%s\\%s" % (self.netbios_name, share)

    def drive_mappings(self, entries=None):
        """{lowercased share name: {letter, label}} of the mapped shares."""
        if entries is None:
            entries = self.drive_entries()[1]
        prefix = ("\\\\%s\\" % self.netbios_name).lower()
        result = {}
        for d in entries:
            path = d["path"].lower()
            if path.startswith(prefix):
                result[path[len(prefix):]] = {"letter": d["letter"], "label": d["label"]}
        return result

    def check_drive_letter(self, share, letter, entries):
        if letter not in DRIVE_LETTERS:
            self.module.fail_json(
                msg="Invalid drive letter %s: use one of %s (H is reserved for home directories)"
                    % (letter, ", ".join(DRIVE_LETTERS)))
        own = self.unc_path(share).lower()
        for d in entries:
            if d["letter"] == letter and d["path"].lower() != own:
                self.module.fail_json(msg="Drive letter %s: is already used by %s" % (letter, d["path"]))

    def _write_file(self, path, content):
        # Written aside and renamed, so clients never read a half-written file.
        self.commands.append("write %s" % path)
        if self.module.check_mode:
            return
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(content.encode("utf-8"))
        os.chmod(tmp, 0o644)
        os.rename(tmp, path)

    def _create_gpo(self):
        """Same objects "samba-tool gpo create" writes, plus the domain-root
        link. Written to the local sam.ldb and sysvol, so no domain
        credentials are needed."""
        realm = self.smbconf("realm").lower()
        guid = new_guid()
        dn = "CN=%s,CN=Policies,CN=System,%s" % (guid, self.base_dn)
        directory = self._sysvol_dir(guid)
        self.change(["mkdir", "-p", "%s/MACHINE" % directory, "%s/USER/Preferences/Drives" % directory])
        self._write_file("%s/GPT.INI" % directory, gpt_ini(0))
        self._write_file("%s/USER/Preferences/Drives/Drives.xml" % directory, build_drives_xml([]))
        self.change(["ldbadd", "-H", self.sam_ldb], data="\n".join([
            "dn: %s" % dn,
            "objectClass: top",
            "objectClass: container",
            "objectClass: groupPolicyContainer",
            "displayName: %s" % DRIVE_MAP_GPO_NAME,
            "gPCFileSysPath: \\\\%s\\sysvol\\%s\\Policies\\%s" % (realm, realm, guid),
            "flags: 0",
            "versionNumber: 0",
            "gPCFunctionalityVersion: 2",
            "showInAdvancedViewOnly: TRUE",
            "gPCUserExtensionNames: %s" % _USER_EXTENSION_NAMES,
            "",
            "dn: CN=User,%s" % dn,
            "objectClass: top",
            "objectClass: container",
            "showInAdvancedViewOnly: TRUE",
            "",
            "dn: CN=Machine,%s" % dn,
            "objectClass: top",
            "objectClass: container",
            "showInAdvancedViewOnly: TRUE",
            "",
        ]))
        out = self.query(["ldbsearch", "-H", self.sam_ldb, "-s", "base", "-b", self.base_dn, "gPLink"])[1]
        records = parse_ldif_records(out)
        old_link = first(records[0], "gPLink") if records else ""
        self.change(["ldbmodify", "-H", self.sam_ldb], data="\n".join([
            "dn: %s" % self.base_dn,
            "changetype: modify",
            "replace: gPLink",
            "gPLink: %s[LDAP://%s;0]" % (old_link, dn),
            "-",
            "",
        ]))
        return {"guid": guid, "dn": dn, "version": 0}

    def set_drive_mapping(self, share, principals, mapping):
        """Map share for principals ([{name, kind, sid}]) or, with mapping
        None, remove its mapping. Returns True when Drives.xml changed."""
        gpo, entries = self.drive_entries()
        if gpo is None and mapping is None:
            return False
        path = self.unc_path(share)
        current = None
        for d in entries:
            if d["path"].lower() == path.lower():
                current = d
        others = [d for d in entries if d is not current]

        entry = None
        if mapping is not None:
            letter = normalize_drive_letter(mapping["letter"])
            self.check_drive_letter(share, letter, entries)
            label = mapping.get("label") or share
            filters = build_filters_xml(principals, self.workgroup)
            if (current is not None and current["letter"] == letter and current["label"] == label
                    and filter_targets(current["filters"]) == filter_targets(filters)):
                return False
            uid = (current or {}).get("uid") or new_guid()
            changed = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            entry = build_drive_xml(uid, changed, path, letter, label, filters)
        elif current is None:
            return False

        if gpo is None:
            gpo = self._create_gpo()
        directory = self._sysvol_dir(gpo["guid"])
        version = gpo["version"] + _USER_VERSION_STEP
        self._write_file("%s/USER/Preferences/Drives/Drives.xml" % directory,
                         build_drives_xml([d["xml"] for d in others] + ([entry] if entry else [])))
        self._write_file("%s/GPT.INI" % directory, gpt_ini(version))
        self.change(["ldbmodify", "-H", self.sam_ldb], data="\n".join([
            "dn: %s" % gpo["dn"],
            "changetype: modify",
            "replace: versionNumber",
            "versionNumber: %d" % version,
            "-",
            "",
        ]))
        # Files written by root carry no NT ACL; restore the sysvol ACLs
        # clients expect (otherwise "samba-tool ntacl sysvolcheck" fails).
        self.change(["samba-tool", "ntacl", "sysvolreset"])
        return True
