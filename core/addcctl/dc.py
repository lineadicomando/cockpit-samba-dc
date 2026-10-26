# SPDX-License-Identifier: LGPL-2.1-or-later
"""The local DC: smb.conf, registry shares, sam.ldb and NSS.

Everything is read locally, as root: the configuration through Samba's
loadparm, the directory from sam.ldb with the system session, never with a
network query or domain credentials. The samba Python bindings are imported
on first use, so the pure parts of addcctl load without them (tests).
"""
import grp
import pwd

from .errors import AddcError

SAM_LDB = "/var/lib/samba/private/sam.ldb"


class Dc:
    def __init__(self, runner):
        self.runner = runner
        self._lp = None
        self._samdb = None
        self._domain_dn = None
        self._registry = None
        self._posix_ids = {}

    # -- smb.conf

    @property
    def lp(self):
        if self._lp is None:
            from samba.param import LoadParm
            self._lp = LoadParm()
            self._lp.load_default()
        return self._lp

    def param(self, name, section=None):
        value = self.lp.get(name, section) if section else self.lp.get(name)
        if value in (None, ""):
            raise AddcError('Cannot determine "%s" from smb.conf' % name)
        return value

    @property
    def workgroup(self):
        return self.param("workgroup")

    @property
    def netbios_name(self):
        return self.param("netbios name")

    @property
    def realm(self):
        return self.param("realm")

    @property
    def sysvol(self):
        return self.param("path", "sysvol")

    # -- registry shares (what "net conf" edits)

    @property
    def registry(self):
        if self._registry is None:
            from samba.samba3 import param as s3param
            from samba.samba3 import smbconf
            s3param.get_context().load_default()
            self._registry = smbconf.init_reg(None)
        return self._registry

    def shares(self):
        """{registry name: {lowercased parameter: value}}."""
        result = {}
        for name in self.registry.share_names():
            _, params = self.registry.get_share(name)
            result[name] = {k.lower(): v for k, v in params}
        return result

    def update_share(self, name, set_params, delete_params=(), create=False):
        """Apply a share's changes in one registry transaction."""
        if create:
            self.runner.record("registry: create share [%s]" % name)
        for param, value in set_params.items():
            self.runner.record("registry: [%s] %s = %s" % (name, param, value))
        for param in delete_params:
            self.runner.record("registry: [%s] delete %s" % (name, param))
        if self.runner.check:
            return
        reg = self.registry
        reg.transaction_start()
        try:
            if create:
                reg.create_share(name)
            for param, value in set_params.items():
                reg.set_parameter(name, param, value)
            for param in delete_params:
                reg.delete_parameter(name, param)
        except Exception as e:
            reg.transaction_cancel()
            raise AddcError("Cannot change share %s: %s" % (name, e)) from None
        reg.transaction_commit()

    def delete_share(self, name):
        self.runner.record("registry: delete share [%s]" % name)
        if not self.runner.check:
            self.registry.delete_share(name)

    # -- sam.ldb

    @property
    def samdb(self):
        if self._samdb is None:
            from samba.auth import system_session
            from samba.samdb import SamDB
            self._samdb = SamDB(url=SAM_LDB, session_info=system_session(), lp=self.lp)
        return self._samdb

    @property
    def domain_dn(self):
        if self._domain_dn is None:
            self._domain_dn = str(self.samdb.domain_dn())
        return self._domain_dn

    @property
    def config_dn(self):
        return str(self.samdb.get_config_basedn())

    @property
    def schema_dn(self):
        return str(self.samdb.get_schema_basedn())

    @property
    def samba_version(self):
        import samba
        return samba.version

    def entry(self, dn, attrs):
        """The record of one entry (see search), or None when it does not exist."""
        import ldb
        try:
            found = self.search("(objectClass=*)", attrs, base=dn, scope="base")
        except ldb.LdbError as e:
            if e.args[0] == ldb.ERR_NO_SUCH_OBJECT:
                return None
            raise
        return found[0] if found else None

    def resolve_principals(self, names):
        """{lowercased name: {name, kind, sid}} of the names in the directory."""
        if not names:
            return {}
        import ldb
        from samba.dcerpc import security
        from samba.ndr import ndr_unpack
        expression = "(|%s)" % "".join("(sAMAccountName=%s)" % ldb.binary_encode(n) for n in names)
        found = {}
        for msg in self.samdb.search(base=self.domain_dn, scope=ldb.SCOPE_SUBTREE, expression=expression,
                                     attrs=["sAMAccountName", "objectSid", "objectClass"]):
            sam = str(msg["sAMAccountName"][0])
            classes = [str(c).lower() for c in msg["objectClass"]]
            found[sam.lower()] = {
                "name": sam,
                "kind": "group" if "group" in classes else "user",
                "sid": str(ndr_unpack(security.dom_sid, msg["objectSid"][0])),
            }
        return found

    def find_gpo(self, display_name):
        """{guid, dn, version} of the GPO with that display name, or None."""
        import ldb
        res = self.samdb.search(
            base="CN=Policies,CN=System,%s" % self.domain_dn, scope=ldb.SCOPE_ONELEVEL,
            expression="(&(objectClass=groupPolicyContainer)(displayName=%s))" % ldb.binary_encode(display_name),
            attrs=["cn", "versionNumber"])
        for msg in res:
            try:
                version = int(str(msg["versionNumber"][0])) if "versionNumber" in msg else 0
            except ValueError:
                version = 0
            return {"guid": str(msg["cn"][0]), "dn": str(msg.dn), "version": version}
        return None

    def add_gpo(self, guid, display_name, user_extension_names):
        """The objects "samba-tool gpo create" writes, linked to the domain
        root; written to sam.ldb directly, so no domain credentials."""
        dn = "CN=%s,CN=Policies,CN=System,%s" % (guid, self.domain_dn)
        domain = self.realm.lower()
        self.runner.record("sam.ldb: add GPO %s" % dn)
        if not self.runner.check:
            self.samdb.add({
                "dn": dn,
                "objectClass": ["top", "container", "groupPolicyContainer"],
                "displayName": display_name,
                "gPCFileSysPath": "\\\\%s\\sysvol\\%s\\Policies\\%s" % (domain, domain, guid),
                "flags": "0",
                "versionNumber": "0",
                "gPCFunctionalityVersion": "2",
                "showInAdvancedViewOnly": "TRUE",
                "gPCUserExtensionNames": user_extension_names,
            })
            for child in ("User", "Machine"):
                self.samdb.add({"dn": "CN=%s,%s" % (child, dn), "objectClass": ["top", "container"],
                                "showInAdvancedViewOnly": "TRUE"})
        return {"guid": guid, "dn": dn, "version": 0}

    def ensure_gpo_linked(self, gpo_dn):
        """Link the GPO to the domain root unless it already is: checked on
        every write, so that a link that failed once is made later."""
        import ldb
        res = self.samdb.search(base=self.domain_dn, scope=ldb.SCOPE_BASE, attrs=["gPLink"])
        old = str(res[0]["gPLink"][0]) if res and "gPLink" in res[0] else ""
        if ("[ldap://%s;" % gpo_dn).lower() in old.lower():
            return
        self._replace(self.domain_dn, "gPLink", "%s[LDAP://%s;0]" % (old, gpo_dn))

    def set_gpo_version(self, gpo_dn, version):
        self._replace(gpo_dn, "versionNumber", str(version))

    def _replace(self, dn, attribute, value):
        self.runner.record("sam.ldb: %s %s = %s" % (dn, attribute, value))
        if self.runner.check:
            return
        import ldb
        msg = ldb.Message()
        msg.dn = ldb.Dn(self.samdb, dn)
        msg[attribute] = ldb.MessageElement(value, ldb.FLAG_MOD_REPLACE, attribute)
        self.samdb.modify(msg)

    # -- directory records: {attribute: [str]}, objectSid as text, "dn"

    def search(self, expression, attrs, base=None, scope="sub"):
        import ldb
        from samba.dcerpc import security
        from samba.ndr import ndr_unpack
        scopes = {"sub": ldb.SCOPE_SUBTREE, "base": ldb.SCOPE_BASE, "one": ldb.SCOPE_ONELEVEL}
        records = []
        for msg in self.samdb.search(base=base or self.domain_dn, scope=scopes[scope],
                                     expression=expression, attrs=attrs):
            record = {"dn": [str(msg.dn)]}
            for attr in attrs:
                if attr in msg:
                    if attr.lower() == "objectsid":
                        record[attr] = [str(ndr_unpack(security.dom_sid, v)) for v in msg[attr]]
                    else:
                        record[attr] = [str(v) for v in msg[attr]]
            records.append(record)
        return records

    def domain_attrs(self, attrs):
        return self.search("(objectClass=*)", attrs, scope="base")[0]

    def modify(self, dn, changes):
        """Replace (a value, or a list for every value) or delete (None)
        attributes of one entry."""
        import ldb
        for attr, value in changes.items():
            shown = ("(deleted)" if value is None else "; ".join(map(str, value)) or "(none)" if isinstance(value, list)
                     else value)
            self.runner.record("sam.ldb: %s %s = %s" % (dn, attr, shown))
        if self.runner.check or not changes:
            return
        msg = ldb.Message()
        msg.dn = ldb.Dn(self.samdb, dn)
        for attr, value in changes.items():
            if value is None:
                msg[attr] = ldb.MessageElement([], ldb.FLAG_MOD_DELETE, attr)
            elif isinstance(value, list):
                msg[attr] = ldb.MessageElement([str(v) for v in value], ldb.FLAG_MOD_REPLACE, attr)
            else:
                msg[attr] = ldb.MessageElement(str(value), ldb.FLAG_MOD_REPLACE, attr)
        self._samdb_call(self.samdb.modify, msg)

    def add_entry(self, dn, attributes):
        """Add an entry: {attribute: value or list of values}."""
        self.runner.record("sam.ldb: add %s" % dn)
        if self.runner.check:
            return
        message = {"dn": dn}
        message.update({k: [str(x) for x in v] if isinstance(v, list) else str(v) for k, v in attributes.items()})
        self._samdb_call(self.samdb.add, message)

    def delete_entry(self, dn, tree=False):
        """Delete an entry; with tree, everything below it too."""
        self.runner.record("sam.ldb: delete %s%s" % (dn, " and everything in it" if tree else ""))
        if not self.runner.check:
            self._samdb_call(self.samdb.delete, dn, ["tree_delete:1"] if tree else [])

    # -- DNs, built and checked by ldb (rule 3)

    def absolute_dn(self, relative):
        """The DN of a container given relative to the domain ("OU=Students",
        "" for the domain itself) or in full; only OU= and CN= components."""
        import ldb
        domain = ldb.Dn(self.samdb, self.domain_dn)
        if not relative:
            return str(domain)
        try:
            dn = ldb.Dn(self.samdb, relative)
            valid = dn.is_valid()
        except ValueError:
            valid = False
        if not valid or len(dn) == 0:
            raise AddcError('Invalid DN: "%s"' % relative)
        if not dn.is_child_of(domain):
            dn.add_base(domain)
        for i in range(len(dn) - len(domain)):
            if dn.get_component_name(i).upper() not in ("OU", "CN") or not dn.get_component_value(i):
                raise AddcError('Invalid DN: "%s": use OU= and CN= components' % relative)
        return str(dn)

    def child_dn(self, parent, attr, value):
        """parent with one more component, value escaped by ldb."""
        import ldb
        child = ldb.Dn(self.samdb, "%s=x" % attr)
        child.set_component(0, attr, value)
        dn = ldb.Dn(self.samdb, parent)
        dn.add_child(child)
        return str(dn)

    def rdn(self, dn):
        """(attribute, value) of the first component of dn."""
        import ldb
        parsed = ldb.Dn(self.samdb, dn)
        return parsed.get_rdn_name(), parsed.get_rdn_value()

    def rename_entry(self, old, new):
        """Rename or move an entry, with everything in it."""
        self.runner.record("sam.ldb: move %s to %s" % (old, new))
        if not self.runner.check:
            import ldb
            self._samdb_call(self.samdb.rename, ldb.Dn(self.samdb, old), ldb.Dn(self.samdb, new))

    def new_ou(self, dn, description=None):
        self.runner.record("sam.ldb: create OU %s" % dn)
        if not self.runner.check:
            self._samdb_call(self.samdb.create_ou, dn, description=description)

    @property
    def pso_container(self):
        return "CN=Password Settings Container,CN=System,%s" % self.domain_dn

    def pso_dn(self, name):
        """The DN of a PSO, its name escaped by ldb (rule 3)."""
        import ldb
        dn = ldb.Dn(self.samdb, "CN=pso,%s" % self.pso_container)
        dn.set_component(0, "CN", name)
        return str(dn)

    def _samdb_call(self, fn, *args, **kwargs):
        """A SamDB call whose failure becomes an AddcError with Samba's message
        (a password the policy refuses, an entry that exists)."""
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            message = e.args[1] if len(getattr(e, "args", ())) > 1 else str(e)
            raise AddcError(str(message).strip()) from None

    def _filter(self, name, object_class):
        import ldb
        return "(&(objectClass=%s)(sAMAccountName=%s))" % (object_class, ldb.binary_encode(name))

    def new_user(self, name, password, **attributes):
        ou = attributes.get("userou")
        self.runner.record("sam.ldb: create user %s%s" % (name, " in %s" % ou if ou else ""))
        if not self.runner.check:
            self._samdb_call(self.samdb.newuser, name, password, **attributes)

    def delete_user(self, name):
        self.runner.record("sam.ldb: delete user %s" % name)
        if not self.runner.check:
            self._samdb_call(self.samdb.deleteuser, name)

    def set_password(self, name, password, must_change):
        self.runner.record("sam.ldb: set password of %s%s" % (name, ", must change at next logon" if must_change else ""))
        if not self.runner.check:
            self._samdb_call(self.samdb.setpassword, self._filter(name, "user"), password,
                             force_change_at_next_login=must_change)

    def set_enabled(self, name, enabled):
        self.runner.record("sam.ldb: %s %s" % ("enable" if enabled else "disable", name))
        if not self.runner.check:
            fn = self.samdb.enable_account if enabled else self.samdb.disable_account
            self._samdb_call(fn, self._filter(name, "user"))

    def unlock(self, name):
        self.runner.record("sam.ldb: unlock %s" % name)
        if not self.runner.check:
            self._samdb_call(self.samdb.unlock_account, self._filter(name, "user"))

    def change_members(self, group, members, add):
        self.runner.record("sam.ldb: %s %s %s" % (group, "add" if add else "remove", ", ".join(members)))
        if not self.runner.check and members:
            self._samdb_call(self.samdb.add_remove_group_members, group, members, add_members_operation=add)

    def new_group(self, name, grouptype, description=None, ou=None, mail=None):
        self.runner.record("sam.ldb: create group %s%s" % (name, " in %s" % ou if ou else ""))
        if not self.runner.check:
            self._samdb_call(self.samdb.newgroup, name, groupou=ou, grouptype=grouptype, description=description,
                             mailaddress=mail)

    def delete_group(self, name):
        self.runner.record("sam.ldb: delete group %s" % name)
        if not self.runner.check:
            self._samdb_call(self.samdb.deletegroup, name)

    def new_computer(self, name, ou=None, description=None):
        self.runner.record("sam.ldb: create computer %s%s" % (name, " in %s" % ou if ou else ""))
        if not self.runner.check:
            self._samdb_call(self.samdb.newcomputer, name, computerou=ou, description=description)

    def samba_tool(self, args):
        """What only samba-tool does (renames, primary group, computer delete
        with its DNS records): argv, never a shell."""
        return self.runner.change(["samba-tool"] + args)

    # -- POSIX ids (winbind)
    #
    # By SID, read from sam.ldb, whenever it is known: a name goes through
    # winbind's cache, which keeps the SID of a deleted account for a while,
    # so a user or group deleted and created again under the same name would
    # get the uid or gid of the old one.

    def _sid_to_id(self, flag, sid):
        out = self.runner.query(["wbinfo", flag, sid], ok=(0, 1)).strip()
        return out if out.isdigit() else None

    def posix_account(self, name, sid=None):
        """(uid, gid of the login group) of a domain user, or None."""
        try:
            if sid is None:
                entry = pwd.getpwnam("%s\\%s" % (self.workgroup, name))
            else:
                uid = self._sid_to_id("--sid-to-uid", sid)
                if uid is None:
                    return None
                entry = pwd.getpwuid(int(uid))
        except KeyError:
            return None
        return entry.pw_uid, entry.pw_gid

    def posix_ids(self, name, sid=None):
        """{"u": uid, "g": gid} of a domain principal; a missing mapping is
        absent. Users usually map to both, well-known groups such as "Domain
        Users" only to a gid. Without a SID (a name left in a share by a
        deleted account), through NSS."""
        key = sid or name.lower()
        if key not in self._posix_ids:
            ids = {}
            if sid is not None:
                for tag, flag in (("u", "--sid-to-uid"), ("g", "--sid-to-gid")):
                    found = self._sid_to_id(flag, sid)
                    if found is not None:
                        ids[tag] = found
            else:
                qualified = "%s\\%s" % (self.workgroup, name)
                try:
                    ids["u"] = str(pwd.getpwnam(qualified).pw_uid)
                except KeyError:
                    pass
                try:
                    ids["g"] = str(grp.getgrnam(qualified).gr_gid)
                except KeyError:
                    pass
            self._posix_ids[key] = ids
        return self._posix_ids[key]
