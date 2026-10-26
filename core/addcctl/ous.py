# SPDX-License-Identifier: LGPL-2.1-or-later
"""Organizational units, and the containers users, groups and computers
live in.

Read from sam.ldb and changed through SamDB as samba-tool ou does (create_ou,
rename, delete with the tree_delete control). DNs are given relative to the
domain (OU=Students,OU=School) and built by ldb (rule 3). The domain's
default containers (CN=Users, CN=Computers, OU=Domain Controllers, as its
wellKnownObjects name them) are listed, but never renamed, moved or deleted.
"""
from . import ad
from .ad import first
from .errors import AddcError

_ATTRS = ["name", "description", "objectClass", "isCriticalSystemObject"]
_INSIDE_ATTRS = ["sAMAccountName", "isCriticalSystemObject", "userAccountControl", "objectClass"]
_MAX_NAME = 64  # rangeUpper of ou


def check_ou_name(name):
    if not name or name != name.strip() or len(name) > _MAX_NAME or any(ord(c) < 32 for c in name):
        raise AddcError('Invalid OU name: "%s"' % name)


class Ous:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner
        self._defaults = None

    # -- reading

    def defaults(self):
        """{"users"|"computers"|"domain_controllers": DN} of the domain."""
        if self._defaults is None:
            values = self.dc.domain_attrs(["wellKnownObjects"]).get("wellKnownObjects", [])
            self._defaults = ad.well_known(values)
        return self._defaults

    def relative(self, dn):
        return ad.relative_dn(dn, self.dc.domain_dn)

    def _describe(self, record):
        dn = first(record, "dn")
        default_for = {v.lower(): k for k, v in self.defaults().items()}.get(dn.lower())
        classes = {c.lower() for c in record.get("objectClass", [])}
        critical = first(record, "isCriticalSystemObject").upper() == "TRUE"
        return {
            "dn": self.relative(dn),
            "name": first(record, "name"),
            "description": first(record, "description"),
            "parent": self.relative(ad.parent_dn(dn)),
            "kind": "ou" if "organizationalunit" in classes else "container",
            "builtin": default_for is not None or critical,
            "default_for": default_for,
        }

    def list(self):
        records = self.dc.search("(objectClass=organizationalUnit)", _ATTRS)
        known = {first(r, "dn").lower() for r in records}
        for kind in ("users", "computers"):
            dn = self.defaults().get(kind)
            if dn and dn.lower() not in known:
                record = self.dc.entry(dn, _ATTRS)
                if record is not None:
                    records.append(record)
                    known.add(dn.lower())
        ous = [self._describe(r) for r in records]
        # By name, each OU after its parent
        return sorted(ous, key=lambda o: [c.split("=", 1)[-1].lower() for c in reversed(ad.split_dn(o["dn"]))])

    def _record(self, relative):
        """The record of an OU or of a default container, or None."""
        record = self.dc.entry(self.dc.absolute_dn(relative), _ATTRS)
        if record is None:
            return None
        classes = {c.lower() for c in record.get("objectClass", [])}
        defaults = {v.lower() for v in self.defaults().values()}
        if "organizationalunit" not in classes and first(record, "dn").lower() not in defaults:
            return None
        return record

    def _require(self, relative):
        record = self._record(relative)
        if record is None:
            raise AddcError('OU "%s" not found' % relative)
        return record

    def get(self, relative):
        return self._describe(self._require(relative))

    def container(self, relative):
        """The DN of an OU or default container that accounts can be put in."""
        record = self._require(relative)
        dn = first(record, "dn")
        if dn.lower() == self.defaults().get("domain_controllers", "").lower():
            raise AddcError("Accounts cannot be put in %s" % self.relative(dn))
        return dn

    def _parent(self, relative):
        """The DN of a place for an OU: the domain ("") or an OU."""
        if not relative:
            return self.dc.domain_dn
        ou = self._describe(self._require(relative))
        if ou["kind"] != "ou" or ou["default_for"] == "domain_controllers":
            raise AddcError("An OU cannot be put in %s" % ou["dn"])
        return self.dc.absolute_dn(ou["dn"])

    # -- accounts

    def move(self, dn, target):
        """Move the entry dn into the container target (relative), unless it
        is there already. Returns whether it moved."""
        container = self.container(target)
        if ad.parent_dn(dn).lower() == container.lower():
            return False
        attr, value = self.dc.rdn(dn)
        self.dc.rename_entry(dn, self.dc.child_dn(container, attr, value))
        return True

    # -- changes

    def create(self, request):
        name = request["name"]
        check_ou_name(name)
        parent = self._parent(request.get("parent") or "")
        dn = self.dc.child_dn(parent, "OU", name)
        if self.dc.entry(dn, ["name"]) is not None:
            raise AddcError('"%s" already exists' % self.relative(dn))
        self.dc.new_ou(dn, description=request.get("description") or None)
        if self.runner.check:
            ou = {"dn": self.relative(dn), "name": name, "description": request.get("description") or "",
                  "parent": self.relative(parent), "kind": "ou", "builtin": False, "default_for": None}
        else:
            ou = self.get(self.relative(dn))
        return {"changed": True, "ou": ou, "diff": {"before": None, "after": ou}}

    def set(self, request):
        """Rename, move or describe an OU; settings left out keep their value."""
        record = self._require(request["dn"])
        before = self._describe(record)
        old = first(record, "dn")
        name = request.get("new_name", before["name"])
        parent = self._parent(request["parent"]) if "parent" in request else ad.parent_dn(old)
        current, changed = old, False
        if name != before["name"] or parent.lower() != ad.parent_dn(old).lower():
            if before["builtin"]:
                raise AddcError("%s is a built-in container and cannot be renamed or moved" % before["dn"])
            check_ou_name(name)
            if ad.is_under(parent, old):
                raise AddcError("%s cannot be moved into itself" % before["dn"])
            current = self.dc.child_dn(parent, "OU", name)
            if current.lower() != old.lower() and self.dc.entry(current, ["name"]) is not None:
                raise AddcError('"%s" already exists' % self.relative(current))
            self.dc.rename_entry(old, current)
            changed = True
        description = before["description"]
        if "description" in request and (request["description"] or "") != before["description"]:
            description = request["description"] or ""
            self.dc.modify(current, {"description": description or None})
            changed = True
        if not changed:
            after = before
        elif self.runner.check:
            after = dict(before, dn=self.relative(current), name=name, parent=self.relative(parent),
                         description=description)
        else:
            after = self.get(self.relative(current))
        return {"changed": changed, "ou": after, "diff": {"before": before, "after": after}}

    def delete(self, request):
        record = self._record(request["dn"])
        if record is None:
            return {"changed": False, "deleted_accounts": [], "diff": {"before": None, "after": None}}
        before = self._describe(record)
        if before["builtin"] or before["kind"] != "ou":
            raise AddcError("%s is a built-in container and cannot be deleted" % before["dn"])
        dn = first(record, "dn")
        inside = [r for r in self.dc.search("(objectClass=*)", _INSIDE_ATTRS, base=dn, scope="sub")
                  if first(r, "dn").lower() != dn.lower()]
        if inside and not request.get("recursive"):
            raise AddcError("%s is not empty (%d objects): move them out, or delete it with recursive"
                            % (before["dn"], len(inside)))
        for r in inside:
            uac = int(first(r, "userAccountControl", "0") or 0)
            if first(r, "isCriticalSystemObject").upper() == "TRUE" or uac & ad.UF_SERVER_TRUST_ACCOUNT:
                raise AddcError("%s holds %s, a built-in object or a domain controller: move it out first"
                                % (before["dn"], self.relative(first(r, "dn"))))
        # Computers first, with their DNS records, as "computer delete" does
        computers = [first(r, "sAMAccountName").rstrip("$") for r in inside
                     if "computer" in {c.lower() for c in r.get("objectClass", [])} and first(r, "sAMAccountName")]
        for name in computers:
            self.dc.samba_tool(["computer", "delete", name])
        # Home directories and shared folders stay, as for "user delete"
        self.dc.delete_entry(dn, tree=len(inside) > len(computers))
        accounts = sorted((first(r, "sAMAccountName") for r in inside if first(r, "sAMAccountName")), key=str.lower)
        return {"changed": True, "deleted_accounts": accounts, "diff": {"before": before, "after": None}}
