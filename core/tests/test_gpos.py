# SPDX-License-Identifier: LGPL-2.1-or-later
import unittest

from addcctl.cli import InvalidInput, execute
from addcctl.errors import AddcError
from addcctl.gpos import DEFAULT_DC_POLICY, DEFAULT_DOMAIN_POLICY, Gpos, encode_gplink, parse_gplink
from addcctl.operations import OPERATIONS
from addcctl.ous import Ous

from test_accounts import BASE, FakeDirDc
from test_shares import FakeRunner

POLICIES = "CN=Policies,CN=System," + BASE
CUSTOM = "{11111111-2222-3333-4444-555555555555}"
MAPS = "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"


def gpo_dn(guid, lower=False):
    dn = "CN=%s,%s" % (guid, POLICIES)
    return dn.lower() if lower else dn


def gpo(guid, name, version="0", flags="0"):
    return {"dn": [gpo_dn(guid)], "cn": [guid], "displayName": [name], "versionNumber": [version],
            "flags": [flags], "gPCFileSysPath": ["\\\\school.internal\\sysvol\\school.internal\\Policies\\" + guid]}


class FakeGpoDc(FakeDirDc):
    def __init__(self, runner):
        super().__init__(runner)
        self.gpos = [gpo(DEFAULT_DOMAIN_POLICY, "Default Domain Policy", "65537"),
                     gpo(DEFAULT_DC_POLICY, "Default Domain Controllers Policy"),
                     gpo(CUSTOM, "Lab settings", "131075", "1"),
                     gpo(MAPS, "Cockpit - Mapped drives", "65536")]
        self.gplink = {
            BASE.lower(): "[LDAP://%s;0][LDAP://%s;0]" % (gpo_dn(DEFAULT_DOMAIN_POLICY), gpo_dn(MAPS)),
            ("OU=Domain Controllers," + BASE).lower(): "[LDAP://%s;0]" % gpo_dn(DEFAULT_DC_POLICY, lower=True),
            ("OU=School," + BASE).lower(): "[LDAP://%s;2]" % gpo_dn(CUSTOM),
        }

    def search(self, expression, attrs, base=None, scope="sub"):
        if expression == "(objectClass=groupPolicyContainer)":
            assert base == POLICIES and scope == "one"
            return [dict(r) for r in self.gpos]
        if expression == "(gPLink=*)":
            return [{"dn": [dn], "gPLink": [value]} for dn, value in self._gplinks() if value]
        return super().search(expression, attrs, base, scope)

    def _gplinks(self):
        names = {r["dn"][0].lower(): r["dn"][0] for r in self.containers}
        names[BASE.lower()] = BASE
        return [(names[k], v) for k, v in self.gplink.items()]

    def entry(self, dn, attrs):
        if attrs == ["gPLink"]:
            value = self.gplink.get(dn.lower())
            return {"dn": [dn], "gPLink": [value]} if value else {"dn": [dn]}
        return super().entry(dn, attrs)

    def modify(self, dn, changes):
        self.modified.append((dn, changes))
        self.runner.record("sam.ldb: %s %s" % (dn, changes))
        if not self.runner.check:
            if changes["gPLink"] is None:
                self.gplink.pop(dn.lower(), None)
            else:
                self.gplink[dn.lower()] = changes["gPLink"]


class Base(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.dc = FakeGpoDc(self.runner)

    def gpos(self):
        return Gpos(self.dc, self.runner, Ous(self.dc, self.runner))


class TestGplink(unittest.TestCase):
    def test_round_trip(self):
        value = "[LDAP://cn={A},cn=policies,cn=system,DC=x;0][LDAP://CN={B},DC=x;3]"
        links = parse_gplink(value)
        self.assertEqual(links, [{"dn": "cn={A},cn=policies,cn=system,DC=x", "options": 0},
                                 {"dn": "CN={B},DC=x", "options": 3}])
        self.assertEqual(encode_gplink(links), value)
        self.assertEqual(parse_gplink(""), [])
        self.assertEqual(parse_gplink(" "), [])

    def test_refuses_what_it_cannot_read(self):
        for value in ("[LDAP://x;0]junk", "junk[LDAP://x;0]", "[LDAP://x]", "[LDAP://x;0][LDAP://y;a]"):
            with self.assertRaises(AddcError, msg=value):
                parse_gplink(value)


class TestRead(Base):
    def test_list(self):
        gpos = self.gpos().list()
        self.assertEqual([g["name"] for g in gpos], ["Cockpit - Mapped drives", "Default Domain Controllers Policy",
                                                     "Default Domain Policy", "Lab settings"])
        by = {g["guid"]: g for g in gpos}
        self.assertEqual(by[CUSTOM], {
            "guid": CUSTOM, "name": "Lab settings",
            "path": "\\\\school.internal\\sysvol\\school.internal\\Policies\\" + CUSTOM,
            "version": {"user": 2, "computer": 3}, "user_enabled": False, "computer_enabled": True,
            "builtin": False, "drive_mapping": False,
            "links": [{"container": "OU=School", "enforced": True, "disabled": False, "order": 1,
                       "protected": False}]})
        # Link order 1 is the last item of gPLink, as in the GPMC
        self.assertEqual(by[MAPS]["links"], [{"container": "", "enforced": False, "disabled": False, "order": 1,
                                              "protected": True}])
        self.assertEqual(by[DEFAULT_DOMAIN_POLICY]["links"][0]["order"], 2)
        self.assertTrue(by[DEFAULT_DC_POLICY]["links"][0]["protected"])
        self.assertTrue(by[DEFAULT_DC_POLICY]["builtin"])
        self.assertTrue(by[MAPS]["drive_mapping"])

    def test_get_by_guid_or_name(self):
        self.assertEqual(self.gpos().get("lab SETTINGS")["guid"], CUSTOM)
        self.assertEqual(self.gpos().get(CUSTOM.lower())["name"], "Lab settings")
        self.assertEqual(self.gpos().get(CUSTOM.strip("{}"))["name"], "Lab settings")
        with self.assertRaisesRegex(AddcError, "not found"):
            self.gpos().get("Nothing")
        self.dc.gpos.append(gpo("{99999999-2222-3333-4444-555555555555}", "Lab settings"))
        with self.assertRaisesRegex(AddcError, "give its GUID"):
            self.gpos().get("Lab settings")


class TestLink(Base):
    def test_new_link_goes_first(self):
        result = self.gpos().link({"gpo": "Lab settings", "container": ""})
        self.assertTrue(result["changed"])
        self.assertIsNone(result["diff"]["before"])
        self.assertEqual(result["diff"]["after"], {"container": "", "enforced": False, "disabled": False,
                                                   "order": 3, "protected": False})
        self.assertEqual(parse_gplink(self.dc.gplink[BASE.lower()])[0]["dn"], gpo_dn(CUSTOM))
        self.assertEqual(len(parse_gplink(self.dc.gplink[BASE.lower()])), 3)
        self.assertEqual([l["container"] for l in result["gpo"]["links"]], ["", "OU=School"])

    def test_container_without_links(self):
        self.gpos().link({"gpo": CUSTOM, "container": "OU=Students,OU=School", "disabled": True})
        self.assertEqual(self.dc.gplink[("OU=Students,OU=School," + BASE).lower()],
                         "[LDAP://%s;1]" % gpo_dn(CUSTOM))

    def test_flags_change_and_idempotence(self):
        result = self.gpos().link({"gpo": CUSTOM, "container": "OU=School", "disabled": True})
        self.assertTrue(result["changed"])
        self.assertEqual(result["diff"]["before"]["disabled"], False)
        self.assertEqual(result["diff"]["after"], {"container": "OU=School", "enforced": True, "disabled": True,
                                                   "order": 1, "protected": False})
        self.assertFalse(self.gpos().link({"gpo": CUSTOM, "container": "OU=School"})["changed"])
        self.gpos().link({"gpo": CUSTOM, "container": "OU=School", "enforced": False, "disabled": False})
        self.assertEqual(self.dc.gplink[("OU=School," + BASE).lower()], "[LDAP://%s;0]" % gpo_dn(CUSTOM))
        self.assertEqual(len(self.dc.modified), 2)

    def test_keeps_the_dn_of_other_links_as_written(self):
        self.gpos().link({"gpo": CUSTOM, "container": "OU=Domain Controllers"})
        self.assertEqual(self.dc.gplink[("OU=Domain Controllers," + BASE).lower()],
                         "[LDAP://%s;0][LDAP://%s;0]" % (gpo_dn(CUSTOM), gpo_dn(DEFAULT_DC_POLICY, lower=True)))

    def test_places(self):
        for container in ("CN=Users", "CN=Computers"):
            with self.assertRaisesRegex(AddcError, "link it to the domain or to an OU"):
                self.gpos().link({"gpo": CUSTOM, "container": container})
        with self.assertRaisesRegex(AddcError, "not found"):
            self.gpos().link({"gpo": CUSTOM, "container": "OU=Ghost"})
        with self.assertRaisesRegex(AddcError, "Invalid DN"):
            self.gpos().link({"gpo": CUSTOM, "container": "DC=other"})

    def test_protected_links_are_not_disabled(self):
        for name, container in (("Default Domain Policy", ""), ("Cockpit - Mapped drives", ""),
                                ("Default Domain Controllers Policy", "OU=Domain Controllers")):
            with self.assertRaisesRegex(AddcError, "cannot be disabled"):
                self.gpos().link({"gpo": name, "container": container, "disabled": True})
        self.assertTrue(self.gpos().link({"gpo": "Default Domain Policy", "enforced": True})["changed"])
        # Linked elsewhere, a default GPO is like any other
        self.gpos().link({"gpo": "Default Domain Policy", "container": "OU=School", "disabled": True})

    def test_check_mode_changes_nothing(self):
        self.runner.check = True
        before = dict(self.dc.gplink)
        result = self.gpos().link({"gpo": CUSTOM, "container": ""})
        self.assertTrue(result["changed"])
        self.assertEqual(result["diff"]["after"]["order"], 3)
        self.assertEqual(self.dc.gplink, before)
        self.assertEqual(len(self.runner.commands), 1)


class TestUnlink(Base):
    def test_unlink(self):
        result = self.gpos().unlink({"gpo": CUSTOM, "container": "OU=School"})
        self.assertTrue(result["changed"])
        self.assertEqual(result["diff"], {"before": {"container": "OU=School", "enforced": True, "disabled": False,
                                                     "order": 1, "protected": False}, "after": None})
        self.assertEqual(result["gpo"]["links"], [])
        self.assertNotIn(("OU=School," + BASE).lower(), self.dc.gplink)
        self.assertEqual(self.dc.modified[-1], ("OU=School," + BASE, {"gPLink": None}))
        self.assertFalse(self.gpos().unlink({"gpo": CUSTOM, "container": "OU=School"})["changed"])

    def test_keeps_the_order_of_the_others(self):
        self.gpos().link({"gpo": CUSTOM})
        self.dc.gpos.append(gpo("{99999999-2222-3333-4444-555555555555}", "Other"))
        self.gpos().link({"gpo": "Other"})
        self.gpos().unlink({"gpo": CUSTOM})
        self.assertEqual([l["dn"] for l in parse_gplink(self.dc.gplink[BASE.lower()])],
                         [gpo_dn("{99999999-2222-3333-4444-555555555555}"), gpo_dn(DEFAULT_DOMAIN_POLICY),
                          gpo_dn(MAPS)])

    def test_protected(self):
        for name, container in (("Default Domain Policy", ""), ("Cockpit - Mapped drives", ""),
                                (DEFAULT_DC_POLICY, "OU=Domain Controllers")):
            with self.assertRaisesRegex(AddcError, "stays linked"):
                self.gpos().unlink({"gpo": name, "container": container})


class TestOperations(Base):
    def test_schema(self):
        with self.assertRaises(InvalidInput):
            execute(OPERATIONS[("gpo", "link")], {"gpo": CUSTOM, "order": 1}, False)
        with self.assertRaises(InvalidInput):
            execute(OPERATIONS[("gpo", "unlink")], {}, False)
        self.assertFalse(OPERATIONS[("gpo", "list")]["mutates"])
        self.assertTrue(OPERATIONS[("gpo", "unlink")]["mutates"])


if __name__ == "__main__":
    unittest.main()
