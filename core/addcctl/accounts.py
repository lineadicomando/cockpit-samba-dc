# SPDX-License-Identifier: LGPL-2.1-or-later
"""Users, groups and computers of the directory.

Read from the local sam.ldb; changed through Samba's SamDB API, or through
samba-tool where only it does the job right (renames, the primary group,
deleting a computer with its DNS records). Built-in accounts are protected
here, so every interface gets the same rules.
"""
from . import ad
from .errors import AddcError
from .shares import Shares, check_principal_names

_USER_ATTRS = [
    "sAMAccountName", "cn", "givenName", "sn", "mail", "description", "title", "department",
    "company", "uidNumber", "userAccountControl", "msDS-User-Account-Control-Computed",
    "lastLogon", "lastLogonTimestamp", "accountExpires", "objectSid", "memberOf",
    "primaryGroupID", "isCriticalSystemObject", "homeDrive", "homeDirectory",
]
_GROUP_ATTRS = ["sAMAccountName", "description", "member", "objectSid", "isCriticalSystemObject",
                "groupType", "mail"]
_COMPUTER_ATTRS = ["sAMAccountName", "operatingSystem", "operatingSystemVersion", "objectSid",
                   "dNSHostName", "lastLogon", "lastLogonTimestamp", "description"]
_USERS = "(&(objectClass=user)(!(objectClass=computer)))"

# Settings of "user set" and the attributes they write directly
_DIRECT_ATTRS = {"description": "description", "title": "title", "department": "department",
                 "company": "company"}
# Settings that "samba-tool user rename" writes, and its options
_RENAME_OPTIONS = {"given_name": "--given-name", "surname": "--surname", "email": "--mail-address",
                   "new_name": "--samaccountname"}


def first(record, attr, default=""):
    values = record.get(attr) or [default]
    return values[0]


def _latest(*raws):
    stamps = [ad.filetime_to_iso(r) for r in raws]
    stamps = [s for s in stamps if s]
    return max(stamps) if stamps else None


class Directory:
    """Reads shared by the operations, done once per call."""

    def __init__(self, dc):
        self.dc = dc
        self._groups = None
        self._accounts = None

    def groups(self):
        if self._groups is None:
            self._groups = [g for g in self.dc.search("(objectClass=group)", _GROUP_ATTRS)
                            if first(g, "sAMAccountName")]
        return self._groups

    def accounts(self):
        """Users and computers, for names of members and primary groups."""
        if self._accounts is None:
            self._accounts = self.dc.search("(objectClass=user)", ["sAMAccountName", "primaryGroupID"])
        return self._accounts

    def dn_names(self):
        """Lowercased DN -> sAMAccountName. A user's CN is often its full name."""
        names = {}
        for record in self.groups() + self.accounts():
            name = first(record, "sAMAccountName")
            if name:
                names[first(record, "dn").lower()] = name
        return names

    def rid_groups(self):
        return {ad.rid(first(g, "objectSid")): first(g, "sAMAccountName") for g in self.groups()}

    def name_of(self, dn, names):
        if dn.lower() in names:
            return names[dn.lower()]
        # Outside the map (a foreign security principal): its CN
        return dn.split(",", 1)[0].split("=", 1)[-1]


class Users:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner
        self.directory = Directory(dc)

    def _describe(self, record, rid_groups=None, names=None):
        rid_groups = self.directory.rid_groups() if rid_groups is None else rid_groups
        names = self.directory.dn_names() if names is None else names
        name = first(record, "sAMAccountName")
        sid = first(record, "objectSid")
        primary = rid_groups.get(first(record, "primaryGroupID"), "")
        groups = [self.directory.name_of(dn, names) for dn in record.get("memberOf", [])]
        # primaryGroupID is not reflected in memberOf
        if primary and primary not in groups:
            groups.append(primary)
        uac = int(first(record, "userAccountControl", "0") or 0)
        computed = int(first(record, "msDS-User-Account-Control-Computed", "0") or 0)
        return {
            "name": name,
            "cn": first(record, "cn"),
            "given_name": first(record, "givenName"),
            "surname": first(record, "sn"),
            "email": first(record, "mail"),
            "description": first(record, "description"),
            "title": first(record, "title"),
            "department": first(record, "department"),
            "company": first(record, "company"),
            "uid_number": first(record, "uidNumber"),
            "sid": sid,
            "rid": ad.rid(sid),
            "enabled": not uac & ad.UF_ACCOUNTDISABLE,
            "locked_out": bool(computed & ad.UF_LOCKOUT),
            "expires": ad.filetime_to_iso(first(record, "accountExpires")),
            "last_logon": _latest(first(record, "lastLogonTimestamp"), first(record, "lastLogon")),
            "groups": groups,
            "primary_group": primary,
            "critical": first(record, "isCriticalSystemObject").upper() == "TRUE",
            "home_drive": first(record, "homeDrive"),
            "home_directory": first(record, "homeDirectory"),
        }

    def _record(self, name):
        found = self.dc.search("(&%s(sAMAccountName=%s))" % (_USERS, _escape(name)), _USER_ATTRS)
        return found[0] if found else None

    def _require(self, name):
        check_principal_names([name])
        record = self._record(name)
        if record is None:
            raise AddcError('User "%s" not found' % name)
        return record

    def list(self):
        rid_groups, names = self.directory.rid_groups(), self.directory.dn_names()
        users = [self._describe(r, rid_groups, names) for r in self.dc.search(_USERS, _USER_ATTRS)
                 if first(r, "sAMAccountName")]
        return sorted(users, key=lambda u: u["name"].lower())

    def get(self, name):
        return self._describe(self._require(name))

    @staticmethod
    def protected(user):
        return user["name"].lower() in ad.PROTECTED_USERS or user["critical"]

    def create(self, request):
        name = request["name"]
        check_principal_names([name])
        if self._record(name) is not None:
            raise AddcError('User "%s" already exists' % name)
        attributes = {
            "force_password_change_at_next_login_req": bool(request.get("must_change_password")),
            "givenname": request.get("given_name") or None,
            "surname": request.get("surname") or None,
            "mailaddress": request.get("email") or None,
            "description": request.get("description") or None,
            "jobtitle": request.get("title") or None,
            "department": request.get("department") or None,
            "company": request.get("company") or None,
            "userou": request.get("ou") or None,
        }
        self.dc.new_user(name, request["password"], **attributes)
        groups = request.get("groups") or []
        for group in groups:
            self.dc.change_members(group, [name], add=True)
        if self.runner.check:
            return {"changed": True, "user": None}
        return {"changed": True, "user": self.get(name)}

    def set(self, request):
        """Bring an existing user to the given settings; settings left out
        keep their value. Returns {changed, user, diff}."""
        name = request["name"]
        before = self._describe(self._require(name))
        changed = False

        # Names, mail and the account name: samba-tool user rename, which also
        # renames the CN when it follows the full name
        rename = []
        for key, option in _RENAME_OPTIONS.items():
            if key in request and request[key] != (before["name"] if key == "new_name" else before[key]):
                value = request[key]
                if key == "new_name":
                    check_principal_names([value])
                    if value.lower() != name.lower() and self._record(value) is not None:
                        raise AddcError('User "%s" already exists' % value)
                rename.append("%s=%s" % (option, value))
        if rename:
            self.dc.samba_tool(["user", "rename", name] + rename)
            changed = True
        new_name = request.get("new_name") or name

        direct = {attr: (request[key] or None) for key, attr in _DIRECT_ATTRS.items()
                  if key in request and (request[key] or "") != before[key]}
        if direct:
            self.dc.modify(self._dn(new_name, before), direct)
            changed = True

        if "enabled" in request and request["enabled"] != before["enabled"]:
            if before["rid"] in ad.STATUS_LOCKED_RIDS:
                raise AddcError("The status of %s cannot be changed" % before["name"])
            self.dc.set_enabled(new_name, request["enabled"])
            changed = True

        if "expires" in request:
            wanted = None if request["expires"] is None else ad.iso_to_filetime(request["expires"])
            current = None if before["expires"] is None else ad.iso_to_filetime(before["expires"])
            if wanted != current:
                if self.protected(before):
                    raise AddcError("System accounts cannot be given an expiry date")
                self.dc.modify(self._dn(new_name, before), {"accountExpires": ad.NEVER if wanted is None else wanted})
                changed = True

        # Groups first, so that a new primary group is one the user is in
        groups = before["groups"]
        if "groups" in request:
            mode = request.get("groups_mode", "replace")
            changed = self._set_groups(new_name, before, request["groups"], mode) or changed
            groups = self._merge(before["groups"], request["groups"], mode, before["primary_group"])
        if request.get("primary_group") and request["primary_group"].lower() != before["primary_group"].lower():
            if request["primary_group"].lower() not in {g.lower() for g in groups}:
                raise AddcError("%s is not a member of %s: add it to the group first"
                                % (new_name, request["primary_group"]))
            self.dc.samba_tool(["user", "setprimarygroup", new_name, request["primary_group"]])
            changed = True

        if new_name != name:
            _follow_rename(self.dc, self.runner, "user", name, new_name)

        after = before if not changed or self.runner.check else self._describe(self._require(new_name))
        return {"changed": changed, "user": after, "diff": {"before": before, "after": after}}

    def _dn(self, name, before):
        """DN of the user, renamed or not yet (check mode)."""
        record = self._record(name) or self._record(before["name"])
        return first(record, "dn") if record else ""

    @staticmethod
    def _merge(current, requested, mode, primary):
        if mode == "append":
            return current + [g for g in requested if g.lower() not in {c.lower() for c in current}]
        if mode == "remove":
            drop = {g.lower() for g in requested}
            return [g for g in current if g.lower() not in drop or g.lower() == primary.lower()]
        return list(requested) + ([primary] if primary and primary.lower() not in {g.lower() for g in requested} else [])

    def _set_groups(self, name, before, requested, mode):
        current = {g.lower(): g for g in before["groups"]}
        primary = before["primary_group"].lower()
        wanted = {g.lower(): g for g in self._merge(before["groups"], requested, mode, before["primary_group"])}
        add = [g for k, g in wanted.items() if k not in current]
        remove = [g for k, g in current.items() if k not in wanted and k != primary]
        if mode == "remove" and primary in {g.lower() for g in requested}:
            raise AddcError("%s is the primary group of %s: change the primary group first"
                            % (before["primary_group"], name))
        for group in add:
            self.dc.change_members(group, [name], add=True)
        for group in remove:
            self.dc.change_members(group, [name], add=False)
        return bool(add or remove)

    def password(self, request):
        name = request["name"]
        self._require(name)
        self.dc.set_password(name, request["password"], bool(request.get("must_change")))
        return {"changed": True}

    def unlock(self, request):
        user = self.get(request["name"])
        if not user["locked_out"]:
            return {"changed": False}
        self.dc.unlock(user["name"])
        return {"changed": True}

    def delete(self, request):
        name = request["name"]
        check_principal_names([name])
        record = self._record(name)
        if record is None:
            return {"changed": False, "diff": {"before": None, "after": None}}
        before = self._describe(record)
        if self.protected(before):
            raise AddcError("%s is a built-in account and cannot be deleted" % before["name"])
        # Shared folders keep listing it: removing the only entry of a share
        # would open it to every domain user
        self.dc.delete_user(before["name"])
        return {"changed": True, "diff": {"before": before, "after": None}}


class Groups:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner
        self.directory = Directory(dc)

    def _describe(self, record, names=None, primary_members=None):
        names = self.directory.dn_names() if names is None else names
        if primary_members is None:
            primary_members = self._primary_members()
        name = first(record, "sAMAccountName")
        sid = first(record, "objectSid")
        members = [self.directory.name_of(dn, names) for dn in record.get("member", [])]
        scope, category = ad.group_type(first(record, "groupType"))
        critical = first(record, "isCriticalSystemObject").upper() == "TRUE"
        return {
            "name": name,
            "description": first(record, "description"),
            "email": first(record, "mail"),
            "sid": sid,
            "rid": ad.rid(sid),
            "members": members,
            # Accounts whose primary group this is: not in "member"
            "primary_members": sorted(primary_members.get(ad.rid(sid), []), key=str.lower),
            "member_count": len(members) + len(primary_members.get(ad.rid(sid), [])),
            "scope": scope,
            "category": category,
            "critical": critical,
            "protected": name.lower() in ad.PROTECTED_GROUPS or critical,
        }

    def _primary_members(self):
        """Group RID -> the accounts whose primary group it is."""
        members = {}
        for account in self.directory.accounts():
            pgid = first(account, "primaryGroupID")
            if pgid:
                members.setdefault(pgid, []).append(first(account, "sAMAccountName"))
        return members

    def _record(self, name):
        found = [g for g in self.directory.groups() if first(g, "sAMAccountName").lower() == name.lower()]
        return found[0] if found else None

    def _require(self, name):
        check_principal_names([name])
        record = self._record(name)
        if record is None:
            raise AddcError('Group "%s" not found' % name)
        return record

    def list(self):
        names, primary = self.directory.dn_names(), self._primary_members()
        return sorted((self._describe(g, names, primary) for g in self.directory.groups()),
                      key=lambda g: g["name"].lower())

    def get(self, name):
        return self._describe(self._require(name))

    def create(self, request):
        name = request["name"]
        check_principal_names([name])
        if self._record(name) is not None:
            raise AddcError('Group "%s" already exists' % name)
        grouptype = ad.group_type_value(request.get("scope", "global"), request.get("category", "security"))
        self.dc.new_group(name, grouptype, description=request.get("description") or None)
        if request.get("members"):
            self.dc.change_members(name, request["members"], add=True)
        if self.runner.check:
            return {"changed": True, "group": None}
        self.directory = Directory(self.dc)
        return {"changed": True, "group": self.get(name)}

    def set(self, request):
        name = request["name"]
        before = self._describe(self._require(name))
        changed = False
        new_name = request.get("new_name") or before["name"]
        if new_name != before["name"]:
            check_principal_names([new_name])
            if before["protected"]:
                raise AddcError("%s is a built-in group and cannot be renamed" % before["name"])
            if new_name.lower() != before["name"].lower() and self._record(new_name) is not None:
                raise AddcError('Group "%s" already exists' % new_name)
            # The CN follows the new sAMAccountName
            self.dc.samba_tool(["group", "rename", before["name"], "--samaccountname=%s" % new_name])
            changed = True
        if "description" in request and (request["description"] or "") != before["description"]:
            dn = first(self._record(before["name"]), "dn")
            if new_name != before["name"] and not self.runner.check:
                self.directory = Directory(self.dc)
                dn = first(self._record(new_name), "dn")
            self.dc.modify(dn, {"description": request["description"] or None})
            changed = True
        if "members" in request:
            changed = self._set_members(new_name, before, request["members"],
                                        request.get("members_mode", "replace")) or changed
        if new_name != before["name"]:
            _follow_rename(self.dc, self.runner, "group", before["name"], new_name)
        if changed and not self.runner.check:
            self.directory = Directory(self.dc)
            after = self.get(new_name)
        else:
            after = before
        return {"changed": changed, "group": after, "diff": {"before": before, "after": after}}

    def _set_members(self, group, before, requested, mode):
        check_principal_names(requested)
        current = {m.lower(): m for m in before["members"]}
        if mode == "append":
            add, remove = [m for m in requested if m.lower() not in current], []
        elif mode == "remove":
            add, remove = [], [current[m.lower()] for m in requested if m.lower() in current]
        else:
            wanted = {m.lower(): m for m in requested}
            add = [m for k, m in wanted.items() if k not in current]
            remove = [m for k, m in current.items() if k not in wanted]
        # Members whose primary group this is already belong to it, and Samba
        # refuses to add them
        primary_members = {first(a, "sAMAccountName").lower() for a in self.directory.accounts()
                           if first(a, "primaryGroupID") == before["rid"]}
        add = [m for m in add if m.lower() not in primary_members]
        if add:
            self.dc.change_members(group, add, add=True)
        if remove:
            self.dc.change_members(group, remove, add=False)
        return bool(add or remove)

    def delete(self, request):
        name = request["name"]
        check_principal_names([name])
        record = self._record(name)
        if record is None:
            return {"changed": False, "diff": {"before": None, "after": None}}
        before = self._describe(record)
        if before["protected"]:
            raise AddcError("%s is a built-in group and cannot be deleted" % before["name"])
        self.dc.delete_group(before["name"])
        return {"changed": True, "diff": {"before": before, "after": None}}


class Computers:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner

    @staticmethod
    def _describe(record):
        sid = first(record, "objectSid")
        return {
            "name": first(record, "sAMAccountName").rstrip("$"),
            "dn": first(record, "dn"),
            "sid": sid,
            "rid": ad.rid(sid),
            "os": first(record, "operatingSystem"),
            "os_version": first(record, "operatingSystemVersion"),
            "dns_name": first(record, "dNSHostName"),
            "description": first(record, "description"),
            "last_logon": _latest(first(record, "lastLogonTimestamp"), first(record, "lastLogon")),
        }

    def _record(self, name):
        found = self.dc.search("(&(objectClass=computer)(sAMAccountName=%s))" % _escape(name.rstrip("$") + "$"),
                               _COMPUTER_ATTRS)
        return found[0] if found else None

    def list(self):
        computers = [self._describe(r) for r in self.dc.search("(objectClass=computer)", _COMPUTER_ATTRS)
                     if first(r, "sAMAccountName")]
        return sorted(computers, key=lambda c: c["name"].lower())

    def get(self, name):
        check_principal_names([name])
        record = self._record(name)
        if record is None:
            raise AddcError('Computer "%s" not found' % name)
        return self._describe(record)

    def create(self, request):
        name = request["name"].rstrip("$")
        check_principal_names([name])
        if self._record(name) is not None:
            raise AddcError('Computer "%s" already exists' % name)
        self.dc.new_computer(name, ou=request.get("ou") or None, description=request.get("description") or None)
        return {"changed": True, "computer": None if self.runner.check else self.get(name)}

    def delete(self, request):
        name = request["name"].rstrip("$")
        check_principal_names([name])
        record = self._record(name)
        if record is None:
            return {"changed": False, "diff": {"before": None, "after": None}}
        before = self._describe(record)
        if "OU=Domain Controllers," in before["dn"]:
            raise AddcError("%s is a domain controller and cannot be deleted" % before["name"])
        # Also removes its DNS records
        self.dc.samba_tool(["computer", "delete", before["name"]])
        return {"changed": True, "diff": {"before": before, "after": None}}


def _follow_rename(dc, runner, kind, old, new):
    """The shared folders list principals by name. The rename itself is done:
    say so, so that a failure here is not read as "nothing changed"."""
    try:
        Shares(dc, runner).rename_principal({"kind": kind, "old": old, "new": new})
    except AddcError as e:
        raise AddcError('Renamed "%s" to "%s", but updating its shared folders failed: %s' % (old, new, e)) from None


def _escape(value):
    try:
        import ldb
        return ldb.binary_encode(value)
    except ImportError:  # tests without Samba's bindings
        return value.replace("\\", "\\5c").replace("*", "\\2a").replace("(", "\\28").replace(")", "\\29")
