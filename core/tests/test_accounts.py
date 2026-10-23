# SPDX-License-Identifier: LGPL-2.1-or-later
import re
import unittest

from addcctl import ad
from addcctl.accounts import Computers, Groups, Users
from addcctl.domain import Domain
from addcctl.errors import AddcError

from test_shares import FakeRunner

SID = "S-1-5-21-1-2-3-"
BASE = "DC=school,DC=internal"


def user(name, rid, primary="513", groups=(), uac="512", computed="0", critical=False, **extra):
    record = {"dn": ["CN=%s,CN=Users,%s" % (name, BASE)], "sAMAccountName": [name], "cn": [name],
              "objectSid": [SID + rid], "primaryGroupID": [primary], "userAccountControl": [uac],
              "msDS-User-Account-Control-Computed": [computed], "objectClass": ["user"],
              "memberOf": ["CN=%s,CN=Users,%s" % (g, BASE) for g in groups],
              "accountExpires": [str(ad.NEVER)]}
    if critical:
        record["isCriticalSystemObject"] = ["TRUE"]
    record.update({k: [v] for k, v in extra.items()})
    return record


def group(name, rid, members=(), gtype="-2147483646", critical=False):
    record = {"dn": ["CN=%s,CN=Users,%s" % (name, BASE)], "sAMAccountName": [name], "objectSid": [SID + rid],
              "member": ["CN=%s,CN=Users,%s" % (m, BASE) for m in members], "groupType": [gtype],
              "objectClass": ["group"]}
    if critical:
        record["isCriticalSystemObject"] = ["TRUE"]
    return record


class FakeDirDc:
    """A directory in memory, answering the filters addcctl uses."""
    workgroup = "SCHOOL"
    netbios_name = "DC"
    realm = "SCHOOL.INTERNAL"
    sysvol = "/nonexistent"

    def __init__(self, runner):
        self.runner = runner
        self.users = [
            user("Administrator", "500", groups=["Domain Admins"], critical=True),
            user("krbtgt", "502", uac="514", critical=True),
            user("mrossi", "1200", groups=["Teachers"], givenName="Mario", sn="Rossi",
                 lastLogonTimestamp="133000000000000000"),
            user("bianchi", "1201", primary="1108"),
        ]
        self.groups = [group("Domain Users", "513", critical=True), group("Domain Admins", "512", ["Administrator"]),
                       group("Teachers", "1108", ["mrossi"]), group("Staff", "1109", ["Teachers"])]
        self.computers = [{"dn": ["CN=PC01,CN=Computers,%s" % BASE], "sAMAccountName": ["PC01$"],
                           "objectSid": [SID + "1300"], "objectClass": ["computer"]},
                          {"dn": ["CN=DC,OU=Domain Controllers,%s" % BASE], "sAMAccountName": ["DC$"],
                           "objectSid": [SID + "1000"], "objectClass": ["computer"]}]
        self.modified = []
        self.calls = []

    def search(self, expression, attrs, base=None, scope="sub"):
        name = re.search(r"sAMAccountName=([^)]*)", expression)
        if "objectClass=group" in expression:
            pool = self.groups
        elif "objectClass=computer)" in expression and "!(" not in expression:
            pool = self.computers
        elif "!(objectClass=computer)" in expression:
            pool = self.users
        else:
            pool = self.users + self.computers
        if name:
            pool = [r for r in pool if r["sAMAccountName"][0].lower() == name.group(1).lower()]
        return [dict(r) for r in pool]

    def domain_attrs(self, attrs):
        return {"pwdProperties": ["1"], "minPwdLength": ["7"], "pwdHistoryLength": ["24"],
                "minPwdAge": ["-864000000000"], "maxPwdAge": ["-9223372036854775808"],
                "lockoutThreshold": ["5"], "lockoutDuration": ["-18000000000"],
                "lockOutObservationWindow": ["-18000000000"]}

    def _do(self, *call):
        self.calls.append(call)
        self.runner.record(" ".join(str(c) for c in call))

    def modify(self, dn, changes):
        self._do("modify", dn, sorted(changes.items(), key=str))
        self.modified.append((dn, changes))

    def new_user(self, name, password, **attributes):
        self._do("new_user", name)
        self.users.append(user(name, "1500"))
        self.last_password = password

    def delete_user(self, name):
        self._do("delete_user", name)

    def set_password(self, name, password, must_change):
        self._do("set_password", name, must_change)

    def set_enabled(self, name, enabled):
        self._do("set_enabled", name, enabled)

    def unlock(self, name):
        self._do("unlock", name)

    def change_members(self, grp, members, add):
        self._do("members", grp, "add" if add else "remove", tuple(members))

    def new_group(self, name, grouptype, description=None):
        self._do("new_group", name, grouptype)
        self.groups.append(group(name, "1600"))

    def delete_group(self, name):
        self._do("delete_group", name)

    def new_computer(self, name, ou=None, description=None):
        self._do("new_computer", name)

    def samba_tool(self, args):
        self._do("samba-tool", *args)
        if args[:2] in (["user", "rename"], ["group", "rename"]):
            new = [a.split("=", 1)[1] for a in args if a.startswith("--samaccountname=")]
            pool = self.users if args[0] == "user" else self.groups
            for record in pool:
                if new and record["sAMAccountName"][0] == args[2]:
                    record["sAMAccountName"] = new

    def shares(self):
        return {}

    def find_gpo(self, name):
        return None


class Base(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.dc = FakeDirDc(self.runner)

    def users(self):
        return Users(self.dc, self.runner)


class TestRead(Base):
    def test_users(self):
        users = {u["name"]: u for u in self.users().list()}
        self.assertEqual(users["mrossi"]["groups"], ["Teachers", "Domain Users"])
        self.assertEqual(users["mrossi"]["last_logon"], "2022-06-18T04:26:40Z")
        self.assertEqual(users["bianchi"]["primary_group"], "Teachers")
        self.assertFalse(users["krbtgt"]["enabled"])
        self.assertIsNone(users["mrossi"]["expires"])

    def test_groups_count_primary_members(self):
        groups = {g["name"]: g for g in Groups(self.dc, self.runner).list()}
        # mrossi by member, bianchi by primary group
        self.assertEqual(groups["Teachers"]["member_count"], 2)
        self.assertEqual(groups["Teachers"]["primary_members"], ["bianchi"])
        self.assertEqual(groups["Staff"]["members"], ["Teachers"])
        self.assertTrue(groups["Domain Users"]["protected"])
        self.assertEqual((groups["Teachers"]["scope"], groups["Teachers"]["category"]), ("global", "security"))

    def test_password_policy(self):
        policy = Domain(self.dc, self.runner).password_policy()
        self.assertEqual(policy, {"complexity": True, "min_length": 7, "history_length": 24, "min_age_days": 1,
                                  "max_age_days": None, "lockout_threshold": 5, "lockout_duration_minutes": 30,
                                  "lockout_window_minutes": 30})


class TestUserSet(Base):
    def test_rename_is_samba_tool_and_follows_into_shares(self):
        result = self.users().set({"name": "mrossi", "new_name": "mario.rossi", "given_name": "Mario"})
        self.assertIn(("samba-tool", "user", "rename", "mrossi", "--samaccountname=mario.rossi"), self.dc.calls)
        self.assertTrue(result["changed"])
        self.assertEqual(result["user"]["name"], "mario.rossi")
        # The given name was already Mario: not passed again
        self.assertFalse(any("--given-name" in str(c) for c in self.dc.calls))

    def test_nothing_to_do(self):
        result = self.users().set({"name": "mrossi", "given_name": "Mario", "surname": "Rossi", "enabled": True,
                                   "expires": None, "groups": ["Teachers"]})
        self.assertFalse(result["changed"], self.dc.calls)
        self.assertEqual(self.dc.calls, [])

    def test_expiry_written_and_compared_as_instants(self):
        self.users().set({"name": "mrossi", "expires": "2027-07-01T00:00:00+02:00"})
        dn, changes = self.dc.modified[-1]
        self.assertEqual(changes, {"accountExpires": 134588664000000000})
        self.dc.users[2]["accountExpires"] = ["134588664000000000"]
        self.assertFalse(self.users().set({"name": "mrossi", "expires": "2027-06-30T22:00:00Z"})["changed"])
        self.users().set({"name": "mrossi", "expires": None})
        self.assertEqual(self.dc.modified[-1][1], {"accountExpires": ad.NEVER})
        with self.assertRaisesRegex(AddcError, "time zone"):
            self.users().set({"name": "mrossi", "expires": "2027-07-01T00:00:00"})

    def test_groups_modes_and_primary_group(self):
        self.users().set({"name": "mrossi", "groups": ["Staff"], "groups_mode": "append", "primary_group": "Staff"})
        self.assertEqual(self.dc.calls, [("members", "Staff", "add", ("mrossi",)),
                                         ("samba-tool", "user", "setprimarygroup", "mrossi", "Staff")])
        self.dc.calls.clear()
        # replace: the primary group stays, the others follow the list
        self.users().set({"name": "mrossi", "groups": ["Staff"]})
        self.assertEqual(self.dc.calls, [("members", "Staff", "add", ("mrossi",)),
                                         ("members", "Teachers", "remove", ("mrossi",))])
        with self.assertRaisesRegex(AddcError, "primary group of bianchi"):
            self.users().set({"name": "bianchi", "groups": ["Teachers"], "groups_mode": "remove"})
        with self.assertRaisesRegex(AddcError, "not a member of Staff"):
            self.users().set({"name": "bianchi", "primary_group": "Staff"})

    def test_built_in_accounts(self):
        with self.assertRaisesRegex(AddcError, "status of krbtgt"):
            self.users().set({"name": "krbtgt", "enabled": True})
        with self.assertRaisesRegex(AddcError, "expiry date"):
            self.users().set({"name": "Administrator", "expires": "2030-01-01T00:00:00Z"})
        with self.assertRaisesRegex(AddcError, "cannot be deleted"):
            self.users().delete({"name": "administrator"})
        self.assertEqual(self.dc.calls, [])

    def test_names(self):
        with self.assertRaisesRegex(AddcError, "Invalid account name"):
            self.users().set({"name": "-x"})
        with self.assertRaisesRegex(AddcError, "not found"):
            self.users().set({"name": "ghost"})
        with self.assertRaisesRegex(AddcError, "already exists"):
            self.users().create({"name": "MRossi", "password": "x"})


class TestOthers(Base):
    def test_create_user_keeps_the_password_out_of_the_output(self):
        result = self.users().create({"name": "t-new", "password": "S3cret!pw", "groups": ["Teachers"]})
        self.assertNotIn("S3cret!pw", repr(result) + repr(self.runner.commands))
        self.assertEqual(self.dc.last_password, "S3cret!pw")

    def test_unlock_only_when_locked(self):
        self.assertEqual(self.users().unlock({"name": "mrossi"}), {"changed": False})
        self.dc.users[2]["msDS-User-Account-Control-Computed"] = ["16"]
        self.assertEqual(self.users().unlock({"name": "mrossi"}), {"changed": True})

    def test_group_members_skip_primary_members(self):
        groups = Groups(self.dc, self.runner)
        result = groups.set({"name": "Teachers", "members": ["bianchi", "Administrator"], "members_mode": "append"})
        self.assertEqual(self.dc.calls, [("members", "Teachers", "add", ("Administrator",))])
        self.assertTrue(result["changed"])
        with self.assertRaisesRegex(AddcError, "built-in group"):
            groups.delete({"name": "Domain Users"})
        with self.assertRaisesRegex(AddcError, "built-in group"):
            Groups(self.dc, self.runner).set({"name": "Domain Users", "new_name": "Everyone"})

    def test_computers(self):
        computers = Computers(self.dc, self.runner)
        self.assertEqual([c["name"] for c in computers.list()], ["DC", "PC01"])
        self.assertTrue(computers.delete({"name": "pc01$"})["changed"])
        self.assertIn(("samba-tool", "computer", "delete", "PC01"), self.dc.calls)
        with self.assertRaisesRegex(AddcError, "domain controller"):
            computers.delete({"name": "DC"})


class TestAdValues(unittest.TestCase):
    def test_filetime(self):
        self.assertIsNone(ad.filetime_to_iso("0"))
        self.assertIsNone(ad.filetime_to_iso(str(ad.NEVER)))
        self.assertEqual(ad.iso_to_filetime("2027-06-30T22:00:00Z"), 134588664000000000)
        self.assertEqual(ad.filetime_to_iso("134588664000000000"), "2027-06-30T22:00:00Z")

    def test_group_types(self):
        self.assertEqual(ad.group_type("-2147483643"), ("builtin", "security"))
        self.assertEqual(ad.group_type("8"), ("universal", "distribution"))
        self.assertEqual(ad.group_type_value("global", "security"), 2147483650)


if __name__ == "__main__":
    unittest.main()
