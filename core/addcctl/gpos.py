# SPDX-License-Identifier: LGPL-2.1-or-later
"""Group Policy objects and where they are linked, read and written in sam.ldb.

A GPO is a groupPolicyContainer entry under CN=Policies,CN=System; a link is
an item "[LDAP://<GPO DN>;<flags>]" of the gPLink attribute of the domain or
of an OU (flags: 1 disabled, 2 enforced). Links are written as "samba-tool
gpo setlink" and "dellink" write them, but locally (rule 5): a new link goes
first, which gives it the lowest precedence of the container, as in the
Group Policy Management Console; the others keep their order; with no link
left the attribute is deleted.

The default GPOs stay linked where provisioning put them, and the
drive-mapping GPO (drivemaps.py) stays linked to the domain: those links are
never removed or disabled.
"""
import re

from . import ad
from .ad import first
from .drivemaps import GPO_NAME as DRIVE_MAPS_GPO
from .errors import AddcError

DEFAULT_DOMAIN_POLICY = "{31B2F340-016D-11D2-945F-00C04FB984F9}"
DEFAULT_DC_POLICY = "{6AC1786C-016F-11D2-945F-00C04FB984F9}"
LINK_DISABLED = 1
LINK_ENFORCED = 2
# flags of the GPO itself
_USER_DISABLED = 1
_COMPUTER_DISABLED = 2

_ATTRS = ["cn", "displayName", "versionNumber", "flags", "gPCFileSysPath"]
_GUID = re.compile(r"^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$")
_LINK = re.compile(r"\[LDAP://([^;\]]+);([0-9]+)\]", re.IGNORECASE)


def parse_gplink(value):
    """[{dn, options}] of a gPLink, in its order. Refuses one it cannot read
    whole, rather than writing back only part of it."""
    links, end = [], 0
    for m in _LINK.finditer(value or ""):
        if (value[end:m.start()]).strip():
            break
        links.append({"dn": m.group(1), "options": int(m.group(2))})
        end = m.end()
    if (value or "")[end:].strip():
        raise AddcError("Cannot read the gPLink value %r" % value)
    return links


def encode_gplink(links):
    return "".join("[LDAP://%s;%d]" % (link["dn"], link["options"]) for link in links)


def _guid_of(dn):
    """The GUID of a GPO's DN (its first component, CN={...}), upper case."""
    rdn = ad.split_dn(dn)[0] if dn else ""
    return rdn.split("=", 1)[-1].upper() if rdn.upper().startswith("CN=") else ""


def _int(text):
    try:
        return int(text)
    except (TypeError, ValueError):
        return 0


class Gpos:
    def __init__(self, dc, runner, ous):
        self.dc = dc
        self.runner = runner
        self.ous = ous

    @property
    def _policies(self):
        return "CN=Policies,CN=System,%s" % self.dc.domain_dn

    # -- reading

    def _records(self):
        return self.dc.search("(objectClass=groupPolicyContainer)", _ATTRS, base=self._policies, scope="one")

    def _containers(self):
        """[(container DN, [links])] of every entry of the domain with a gPLink."""
        out = []
        for record in self.dc.search("(gPLink=*)", ["gPLink"]):
            dn = first(record, "dn")
            try:
                links = parse_gplink(first(record, "gPLink"))
            except AddcError:
                links = []
            out.append((dn, links))
        return out

    def _protected(self, guid, name, container_dn):
        container = container_dn.lower()
        if container == self.dc.domain_dn.lower():
            return guid == DEFAULT_DOMAIN_POLICY or name == DRIVE_MAPS_GPO
        dcs = self.ous.defaults().get("domain_controllers", "")
        return guid == DEFAULT_DC_POLICY and container == dcs.lower()

    def _describe(self, record, containers):
        guid = first(record, "cn").upper()
        name = first(record, "displayName")
        version, flags = _int(first(record, "versionNumber")), _int(first(record, "flags"))
        links = []
        for container_dn, items in containers:
            for i, item in enumerate(items):
                if _guid_of(item["dn"]) == guid:
                    links.append(self._link(guid, name, container_dn, item["options"], len(items) - i))
        links.sort(key=lambda link: (link["container"] != "", [c.lower() for c in reversed(
            ad.split_dn(link["container"]))] if link["container"] else []))
        return {
            "guid": guid,
            "name": name,
            "path": first(record, "gPCFileSysPath"),
            "version": {"user": version >> 16, "computer": version & 0xFFFF},
            "user_enabled": not flags & _USER_DISABLED,
            "computer_enabled": not flags & _COMPUTER_DISABLED,
            "builtin": guid in (DEFAULT_DOMAIN_POLICY, DEFAULT_DC_POLICY),
            "drive_mapping": name == DRIVE_MAPS_GPO,
            "links": links,
        }

    def _link(self, guid, name, container_dn, options, order):
        return {"container": self.ous.relative(container_dn),
                "enforced": bool(options & LINK_ENFORCED),
                "disabled": bool(options & LINK_DISABLED),
                "order": order,
                "protected": self._protected(guid, name, container_dn)}

    def list(self):
        containers = self._containers()
        gpos = [self._describe(r, containers) for r in self._records()]
        return sorted(gpos, key=lambda g: (g["name"].lower(), g["guid"]))

    def _find(self, gpo):
        """The record of a GPO given by GUID or display name."""
        if not isinstance(gpo, str) or not gpo.strip():
            raise AddcError("Give the GPO's GUID or display name")
        gpo = gpo.strip()
        records = self._records()
        if _GUID.match(gpo) or _GUID.match("{%s}" % gpo):
            guid = gpo.upper() if gpo.startswith("{") else "{%s}" % gpo.upper()
            found = [r for r in records if first(r, "cn").upper() == guid]
        else:
            found = [r for r in records if first(r, "displayName").lower() == gpo.lower()]
        if not found:
            raise AddcError('GPO "%s" not found' % gpo)
        if len(found) > 1:
            raise AddcError('More than one GPO is named "%s": give its GUID (%s)'
                            % (gpo, ", ".join(first(r, "cn") for r in found)))
        return found[0]

    def get(self, gpo):
        return self._describe(self._find(gpo), self._containers())

    # -- links

    def _container(self, relative):
        """The DN of a place a GPO can be linked to: the domain ("") or an OU
        (OU=Domain Controllers too; not CN=Users or CN=Computers, which AD
        does not apply GPOs to)."""
        if not relative:
            return self.dc.domain_dn
        ou = self.ous.get(relative)
        if ou["kind"] != "ou":
            raise AddcError("A GPO cannot be linked to %s: link it to the domain or to an OU" % ou["dn"])
        return self.dc.absolute_dn(ou["dn"])

    def _container_links(self, dn):
        record = self.dc.entry(dn, ["gPLink"])
        return parse_gplink(first(record or {}, "gPLink"))

    def _write(self, dn, links):
        self.dc.modify(dn, {"gPLink": encode_gplink(links) if links else None})

    def _result(self, record, guid, container_dn, links, before, changed):
        """The GPO as it is after the change: re-read, or, in check mode,
        with the container's links as they would be."""
        containers = [(dn, items) for dn, items in self._containers() if dn.lower() != container_dn.lower()]
        containers.append((container_dn, links))
        gpo = self._describe(record, containers)
        after = next((link for link in gpo["links"]
                      if link["container"].lower() == self.ous.relative(container_dn).lower()), None)
        return {"changed": changed, "gpo": gpo, "diff": {"before": before, "after": after}}

    def link(self, request):
        """Link a GPO to the domain or an OU, or change the flags of its link;
        flags left out keep their value (false for a new link)."""
        record = self._find(request["gpo"])
        guid, name = first(record, "cn").upper(), first(record, "displayName")
        container_dn = self._container(request.get("container") or "")
        links = self._container_links(container_dn)
        index = next((i for i, link in enumerate(links) if _guid_of(link["dn"]) == guid), None)
        before = None
        if index is None:
            options = 0
        else:
            options = links[index]["options"]
            before = self._link(guid, name, container_dn, options, len(links) - index)
        for key, bit in (("enforced", LINK_ENFORCED), ("disabled", LINK_DISABLED)):
            if key in request:
                options = options | bit if request[key] else options & ~bit
        if options & LINK_DISABLED and self._protected(guid, name, container_dn):
            raise AddcError("The link of %s to %s cannot be disabled"
                            % (name, self.ous.relative(container_dn) or "the domain"))
        if index is None:
            links = [{"dn": first(record, "dn"), "options": options}] + links
        elif options != links[index]["options"]:
            links = [dict(link, options=options) if i == index else link for i, link in enumerate(links)]
        else:
            return self._result(record, guid, container_dn, links, before, False)
        self._write(container_dn, links)
        return self._result(record, guid, container_dn, links, before, True)

    def unlink(self, request):
        record = self._find(request["gpo"])
        guid, name = first(record, "cn").upper(), first(record, "displayName")
        container_dn = self._container(request.get("container") or "")
        links = self._container_links(container_dn)
        index = next((i for i, link in enumerate(links) if _guid_of(link["dn"]) == guid), None)
        if index is None:
            return self._result(record, guid, container_dn, links, None, False)
        if self._protected(guid, name, container_dn):
            raise AddcError("%s stays linked to %s" % (name, self.ous.relative(container_dn) or "the domain"))
        before = self._link(guid, name, container_dn, links[index]["options"], len(links) - index)
        links = links[:index] + links[index + 1:]
        self._write(container_dn, links)
        return self._result(record, guid, container_dn, links, before, True)
