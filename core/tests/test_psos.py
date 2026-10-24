# SPDX-License-Identifier: LGPL-2.1-or-later
import re
import unittest

from addcctl.cli import execute
from addcctl.domain import NEVER_INTERVAL
from addcctl.errors import AddcError
from addcctl.operations import OPERATIONS
from addcctl.psos import Psos

from test_shares import FakeRunner

BASE = "DC=school,DC=internal"
CONTAINER = "CN=Password Settings Container,CN=System," + BASE
DAY = -864000000000
MINUTE = -600000000


def dn(name):
    return "CN=%s,CN=Users,%s" % (name, BASE)


class FakePsoDc:
    """Users, groups and PSOs in memory; msDS-ResultantPSO given per user."""
    pso_container = CONTAINER
    domain_dn = BASE

    def __init__(self, runner, level="4"):
        self.runner = runner
        self.level = level
        self.accounts = {
            "mrossi": {"dn": [dn("Mario Rossi")], "sAMAccountName": ["mrossi"], "objectClass": ["user"]},
            "Teachers": {"dn": [dn("Teachers")], "sAMAccountName": ["Teachers"], "objectClass": ["group"]},
            "Staff": {"dn": [dn("Staff")], "sAMAccountName": ["Staff"], "objectClass": ["group"]},
            "PC01$": {"dn": ["CN=PC01,CN=Computers," + BASE], "sAMAccountName": ["PC01$"],
                      "objectClass": ["user", "computer"]},
        }
        self.psos = {}
        self.resultant = {}

    def pso_dn(self, name):
        return "CN=%s,%s" % (name, CONTAINER)

    def domain_attrs(self, attrs):
        return {"msDS-Behavior-Version": [self.level], "pwdProperties": ["1"], "minPwdLength": ["7"],
                "pwdHistoryLength": ["24"], "minPwdAge": [str(DAY)], "maxPwdAge": [str(42 * DAY)],
                "lockoutThreshold": ["0"], "lockoutDuration": [str(30 * MINUTE)],
                "lockOutObservationWindow": [str(30 * MINUTE)]}

    def search(self, expression, attrs, base=None, scope="sub"):
        if "msDS-PasswordSettings" in expression:
            name = re.search(r"\(cn=([^)]*)\)", expression)
            found = [p for p in self.psos.values() if not name or p["cn"][0].lower() == name.group(1).lower()]
            return [dict(p) for p in found]
        name = re.search(r"sAMAccountName=([^)]*)", expression)
        pool = list(self.accounts.values())
        if "!(objectClass=computer)" in expression:
            pool = [a for a in pool if "computer" not in a["objectClass"]]
        elif expression == "(objectClass=group)":
            pool = [a for a in pool if "group" in a["objectClass"]]
        elif expression == "(objectClass=user)":
            pool = [a for a in pool if "user" in a["objectClass"]]
        if name:
            pool = [a for a in pool if a["sAMAccountName"][0].lower() == name.group(1).lower()]
        out = []
        for a in pool:
            record = dict(a)
            if "msDS-ResultantPSO" in attrs and a["sAMAccountName"][0] in self.resultant:
                record["msDS-ResultantPSO"] = [self.pso_dn(self.resultant[a["sAMAccountName"][0]])]
            out.append(record)
        return out

    def entry(self, entry_dn, attrs):
        for p in self.psos.values():
            if p["dn"][0].lower() == entry_dn.lower():
                return dict(p)
        return None

    def add_entry(self, entry_dn, attributes):
        self.runner.record("sam.ldb: add %s" % entry_dn)
        if self.runner.check:
            return
        record = {"dn": [entry_dn], "cn": [entry_dn.split(",")[0][3:]]}
        record.update({k: [str(x) for x in v] if isinstance(v, list) else [str(v)] for k, v in attributes.items()})
        self.psos[record["cn"][0].lower()] = record

    def modify(self, entry_dn, changes):
        for attr, value in changes.items():
            self.runner.record("sam.ldb: %s %s = %s" % (entry_dn, attr, value))
        if self.runner.check:
            return
        record = self.entry(entry_dn, [])
        record.update({k: [str(x) for x in v] if isinstance(v, list) else [str(v)] for k, v in changes.items()})
        self.psos[record["cn"][0].lower()] = record

    def delete_entry(self, entry_dn):
        self.runner.record("sam.ldb: delete %s" % entry_dn)
        if not self.runner.check:
            self.psos = {k: p for k, p in self.psos.items() if p["dn"][0].lower() != entry_dn.lower()}


class TestPsos(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.dc = FakePsoDc(self.runner)
        self.psos = Psos(self.dc, self.runner)

    def create(self, **request):
        return self.psos.create(dict({"name": "Staff long", "precedence": 10}, **request))

    def test_create_takes_the_domain_settings_left_out(self):
        result = self.create(min_length=12, max_age_days=None, applies_to=["teachers", "mrossi"])
        pso = result["pso"]
        self.assertEqual(pso["min_length"], 12)
        self.assertEqual(pso["history_length"], 24)
        self.assertEqual(pso["min_age_days"], 1)
        self.assertIsNone(pso["max_age_days"])
        self.assertEqual(pso["applies_to"], ["mrossi", "Teachers"])
        record = self.dc.psos["staff long"]
        self.assertEqual(record["msDS-PasswordReversibleEncryptionEnabled"], ["FALSE"])
        self.assertEqual(record["msDS-PasswordComplexityEnabled"], ["TRUE"])
        self.assertEqual(record["msDS-MaximumPasswordAge"], [str(NEVER_INTERVAL)])
        self.assertEqual(record["msDS-PSOAppliesTo"], [dn("Teachers"), dn("Mario Rossi")])

    def test_create_refuses_what_it_should(self):
        self.create()
        with self.assertRaisesRegex(AddcError, "already exists"):
            self.create()
        with self.assertRaisesRegex(AddcError, "not found"):
            self.create(name="other", applies_to=["nobody"])
        with self.assertRaisesRegex(AddcError, "not found"):
            self.create(name="other", applies_to=["PC01$"])
        with self.assertRaisesRegex(AddcError, "greater than the minimum"):
            self.create(name="other", min_age_days=50)
        with self.assertRaisesRegex(AddcError, "Invalid PSO name"):
            self.create(name=" other")
        self.dc.level = "2"
        with self.assertRaisesRegex(AddcError, "functional level 2008"):
            self.create(name="other")

    def test_check_mode_previews_a_new_pso(self):
        runner = FakeRunner(check=True)
        dc = FakePsoDc(runner)
        result = Psos(dc, runner).create({"name": "x", "precedence": 1, "applies_to": ["Staff"]})
        self.assertEqual(result["pso"]["applies_to"], ["Staff"])
        self.assertEqual(dc.psos, {})
        self.assertEqual(runner.commands, ["sam.ldb: add CN=x,%s" % CONTAINER])

    def test_set_changes_only_what_differs(self):
        self.create(applies_to=["Teachers"])
        self.runner.commands.clear()
        result = self.psos.set({"name": "Staff long", "precedence": 10, "complexity": False,
                                "lockout_duration_minutes": None})
        self.assertTrue(result["changed"])
        self.assertEqual(len(self.runner.commands), 2)
        self.assertFalse(result["pso"]["complexity"])
        self.assertIsNone(result["pso"]["lockout_duration_minutes"])
        self.assertEqual(result["diff"]["before"]["complexity"], True)
        self.assertFalse(self.psos.set({"name": "Staff long", "complexity": False})["changed"])

    def test_applies_to_modes(self):
        self.create(applies_to=["Teachers"])
        self.psos.set({"name": "Staff long", "applies_to": ["mrossi", "Staff"], "applies_to_mode": "append"})
        self.assertEqual(self.psos.get("Staff long")["applies_to"], ["mrossi", "Staff", "Teachers"])
        self.psos.set({"name": "Staff long", "applies_to": ["teachers"], "applies_to_mode": "remove"})
        self.assertEqual(self.psos.get("Staff long")["applies_to"], ["mrossi", "Staff"])
        self.runner.commands.clear()
        self.assertFalse(self.psos.set({"name": "Staff long", "applies_to": ["Staff", "mrossi"]})["changed"])
        self.psos.set({"name": "Staff long", "applies_to": []})
        self.assertEqual(self.psos.get("Staff long")["applies_to"], [])

    def test_list_by_precedence_and_delete(self):
        self.create(name="b", precedence=5)
        self.create(name="a", precedence=20)
        self.create(name="c", precedence=5)
        self.assertEqual([p["name"] for p in self.psos.list()], ["b", "c", "a"])
        self.assertTrue(self.psos.delete({"name": "a"})["changed"])
        self.assertFalse(self.psos.delete({"name": "a"})["changed"])
        with self.assertRaisesRegex(AddcError, 'PSO "a" not found'):
            self.psos.get("a")

    def test_effective_policy(self):
        self.create(min_length=14)
        self.assertEqual(self.psos.effective("mrossi")["pso"], None)
        self.assertEqual(self.psos.effective("mrossi")["policy"]["min_length"], 7)
        self.dc.resultant["mrossi"] = "Staff long"
        effective = self.psos.effective("mrossi")
        self.assertEqual(effective["pso"], "Staff long")
        self.assertEqual(effective["policy"]["min_length"], 14)
        self.assertNotIn("applies_to", effective["policy"])
        with self.assertRaisesRegex(AddcError, "not found"):
            self.psos.effective("nobody")

    def test_zero_lockout_duration_reads_as_until_unlocked(self):
        self.create()
        self.dc.psos["staff long"]["msDS-LockoutDuration"] = ["0"]
        self.assertIsNone(self.psos.get("Staff long")["lockout_duration_minutes"])

    def test_schema_ranges(self):
        for request, message in (({"name": "x", "precedence": 0}, "at least 1"),
                                 ({"name": "x", "precedence": 1, "min_length": 256}, "at most 255"),
                                 ({"name": "x"}, "precedence is required")):
            with self.assertRaisesRegex(Exception, message):
                execute(OPERATIONS[("pso", "create")], request, check=True)


if __name__ == "__main__":
    unittest.main()
