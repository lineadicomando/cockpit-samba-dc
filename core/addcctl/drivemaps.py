# SPDX-License-Identifier: LGPL-2.1-or-later
"""Network drives mapped at logon through one GPO, "Cockpit - Mapped drives".

Its Group Policy Preferences Drives.xml holds one <Drive> per mapped share,
targeted (item-level targeting) at the share's users and groups. The GPO is
written to the local sam.ldb and sysvol, so no domain credentials are needed.
"""
import datetime
import os
import re
import uuid

from .errors import AddcError

GPO_NAME = "Cockpit - Mapped drives"
# E-Z except H (home directories); A-C are reserved, D is usually optical.
DRIVE_LETTERS = "EFGIJKLMNOPQRSTUVWXYZ"

_DRIVES_CLSID = "{8FDDCC1A-0C3C-43cd-A6B4-71A6DF20DA8C}"
_DRIVE_CLSID = "{935D1B74-9CB8-4e3c-9914-7DD559B7A417}"
# Client-side extensions that process Group Policy Preferences drive maps
USER_EXTENSION_NAMES = (
    "[{00000000-0000-0000-0000-000000000000}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]"
    "[{5794DAFD-BE60-433F-88A2-1A31939AC01F}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]"
)
# The user-side version lives in the high 16 bits; clients only reapply a GPO
# whose version has changed.
_USER_VERSION_STEP = 65536


def xml_escape(value):
    return (value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def xml_unescape(value):
    return (value.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
            .replace("&apos;", "'").replace("&amp;", "&"))


def _attr(tag, name):
    m = re.search(r'\s%s="([^"]*)"' % name, tag)
    return xml_unescape(m.group(1)) if m else ""


def parse_drives_xml(raw):
    """<Drive> items of a Drives.xml, each with its original XML, so that
    the entries of other shares are written back untouched."""
    drives = []
    for m in re.finditer(r"<Drive\s[\s\S]*?</Drive>", raw or ""):
        xml = m.group(0)
        drive_tag = re.search(r"<Drive\s[^>]*>", xml)
        props = re.search(r"<Properties\s[^>]*>", xml)
        filters = re.search(r"<Filters>[\s\S]*?</Filters>", xml)
        drive_tag = drive_tag.group(0) if drive_tag else ""
        props = props.group(0) if props else ""
        drives.append({
            "uid": _attr(drive_tag, "uid"),
            "path": _attr(props, "path"),
            "letter": _attr(props, "letter").upper(),
            "label": _attr(props, "label"),
            "filters": filters.group(0) if filters else "",
            "xml": xml,
        })
    return drives


def filter_targets(filters):
    """Order-insensitive identity of a <Filters> block: {(kind, sid, name)}.
    The name counts too, so that a renamed principal is written again."""
    return {(kind.lower(), _attr(" " + tag, "sid"), _attr(" " + tag, "name").lower())
            for kind, tag in re.findall(r"<Filter(User|Group)\s([^>]*)>", filters or "")}


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
        % (_DRIVE_CLSID, letter, letter, changed, uid, xml_escape(path), xml_escape(label), letter, filters))


def build_drives_xml(drives):
    return '<?xml version="1.0" encoding="utf-8"?>\r\n<Drives clsid="%s">%s</Drives>\r\n' % (
        _DRIVES_CLSID, "".join(drives))


def gpt_ini(version):
    return "[General]\r\nVersion=%d\r\ndisplayName=%s\r\n" % (version, GPO_NAME)


def new_guid():
    return "{%s}" % str(uuid.uuid4()).upper()


def normalize_letter(letter):
    return (letter or "").strip().rstrip(":").upper()


class DriveMaps:
    """The drive-mapping GPO of the local DC."""

    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner
        self._entries = None

    def _dir(self, guid):
        return "%s/%s/Policies/%s" % (self.dc.sysvol, self.dc.realm.lower(), guid)

    def _drives_path(self, guid):
        return "%s/USER/Preferences/Drives/Drives.xml" % self._dir(guid)

    def entries(self):
        """(gpo or None, [drive entries])."""
        if self._entries is None:
            gpo = self.dc.find_gpo(GPO_NAME)
            raw = ""
            if gpo is not None:
                try:
                    with open(self._drives_path(gpo["guid"]), "rb") as f:
                        raw = f.read().decode("utf-8", "replace")
                except OSError:
                    raw = ""
            self._entries = (gpo, parse_drives_xml(raw))
        return self._entries

    def unc_path(self, share):
        return "\\\\%s\\%s" % (self.dc.netbios_name, share)

    def mappings(self):
        """{lowercased share name: {letter, label}}."""
        prefix = ("\\\\%s\\" % self.dc.netbios_name).lower()
        result = {}
        for d in self.entries()[1]:
            path = d["path"].lower()
            if path.startswith(prefix):
                result[path[len(prefix):]] = {"letter": d["letter"], "label": d["label"]}
        return result

    def check_letter(self, share, letter):
        if len(letter) != 1 or letter not in DRIVE_LETTERS:
            raise AddcError("Invalid drive letter %s: use one of %s (H is reserved for home directories)"
                            % (letter or '""', ", ".join(DRIVE_LETTERS)))
        own = self.unc_path(share).lower()
        for d in self.entries()[1]:
            if d["letter"] == letter and d["path"].lower() != own:
                raise AddcError("Drive letter %s: is already used by %s" % (letter, d["path"]))

    def set(self, share, principals, mapping):
        """Map share for principals [{name, kind, sid}] or, with mapping None,
        drop its mapping. Returns True when something changed."""
        gpo, entries = self.entries()
        if gpo is None and mapping is None:
            return False
        path = self.unc_path(share)
        current = next((d for d in entries if d["path"].lower() == path.lower()), None)
        others = [d for d in entries if d is not current]

        entry = None
        if mapping is not None:
            letter = normalize_letter(mapping["letter"])
            self.check_letter(share, letter)
            label = mapping.get("label") or share
            filters = build_filters_xml(principals, self.dc.workgroup)
            if (current is not None and current["letter"] == letter and current["label"] == label
                    and filter_targets(current["filters"]) == filter_targets(filters)):
                return False
            uid = (current or {}).get("uid") or new_guid()
            changed = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            entry = build_drive_xml(uid, changed, path, letter, label, filters)
        elif current is None:
            return False

        acls_complete = True
        if gpo is None:
            gpo = self._create_gpo()
            acls_complete = False
        self.dc.ensure_gpo_linked(gpo["dn"])
        version = gpo["version"] + _USER_VERSION_STEP
        directory = self._dir(gpo["guid"])
        acls_complete &= self.runner.write_file(
            self._drives_path(gpo["guid"]),
            build_drives_xml([d["xml"] for d in others] + ([entry] if entry else [])))
        acls_complete &= self.runner.write_file("%s/GPT.INI" % directory, gpt_ini(version))
        self.dc.set_gpo_version(gpo["dn"], version)
        # A file with no NT ACL breaks "samba-tool ntacl sysvolcheck" and the
        # ACLs clients expect. The reset rewrites every GPO's ACLs, slow on a
        # large sysvol: only when a file was new.
        if not acls_complete:
            self.runner.change(["samba-tool", "ntacl", "sysvolreset"])
        gpo["version"] = version
        self._entries = None
        return True

    def _create_gpo(self):
        guid = new_guid()
        directory = self._dir(guid)
        self.runner.record("mkdir %s" % directory)
        if not self.runner.check:
            os.makedirs("%s/MACHINE" % directory, exist_ok=True)
            os.makedirs("%s/USER/Preferences/Drives" % directory, exist_ok=True)
        gpo = self.dc.add_gpo(guid, GPO_NAME, USER_EXTENSION_NAMES)
        self.runner.write_file("%s/GPT.INI" % directory, gpt_ini(0))
        self.runner.write_file(self._drives_path(guid), build_drives_xml([]))
        return gpo
