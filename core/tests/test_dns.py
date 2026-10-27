# SPDX-License-Identifier: LGPL-2.1-or-later
import unittest

from addcctl.cli import InvalidInput, execute
from addcctl.dns import Dns, canonical_value, check_record_name
from addcctl.errors import AddcError
from addcctl.operations import OPERATIONS

from test_shares import FakeRunner

ZONE_DN = "DC=school.internal,CN=MicrosoftDNS,DC=DomainDnsZones,DC=school,DC=internal"


def rec(rtype, value, ttl=900, timestamp=0):
    return {"type": rtype, "value": value, "ttl": ttl, "timestamp": timestamp}


class FakeDnsDc:
    dns_domain = "school.internal"

    def __init__(self, runner):
        self.runner = runner
        self.zones = [
            {"name": "school.internal", "partition": "domain", "dn": ZONE_DN},
            {"name": "_msdcs.school.internal", "partition": "forest", "dn": "DC=_msdcs..."},
            {"name": "RootDNSServers", "partition": "domain", "dn": "DC=RootDNSServers..."},
        ]
        self.nodes = {
            "school.internal": {
                "@": [rec("SOA", "dc.school.internal hostmaster 5 900 600 86400 3600", 3600),
                      rec("NS", "dc.school.internal"), rec("A", "10.0.0.1"), rec("MX", "mail.school.internal 10")],
                "dc": [rec("A", "10.0.0.1")],
                "_ldap._tcp": [rec("SRV", "dc.school.internal 389 0 100")],
                "DomainDnsZones": [rec("A", "10.0.0.1")],
                "pc01": [rec("A", "10.0.0.50", 1200, timestamp=3600000)],
                "www": [rec("A", "10.0.0.80"), rec("TXT", "hello")],
                "old": [],
            },
        }
        self.tombstoned = {("school.internal", "old")}
        self.writes = []

    def dns_dc_hosts(self):
        return ["dc.school.internal"]

    def dns_zones(self):
        return [dict(z) for z in self.zones]

    def dns_nodes(self, zone, name=None):
        out = []
        for node, records in self.nodes.get(zone["name"], {}).items():
            if name is None or node.lower() == name.lower():
                out.append({"name": node, "dn": "DC=%s,%s" % (node, zone["dn"]),
                            "tombstoned": (zone["name"], node) in self.tombstoned,
                            "records": [dict(r) for r in records]})
        return out

    def dns_write(self, zone, name, node, records):
        self.runner.record("dns %s %s" % (name, records))
        self.writes.append((name, node is None, [dict(r) for r in records]))
        if self.runner.check:
            return
        key = node["name"] if node else name
        self.nodes[zone["name"]][key] = [dict(r) for r in records]
        if records:
            self.tombstoned.discard((zone["name"], key))
        else:
            self.tombstoned.add((zone["name"], key))


class Base(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.dc = FakeDnsDc(self.runner)

    def dns(self):
        return Dns(self.dc, self.runner)


class TestValues(unittest.TestCase):
    def test_canonical(self):
        self.assertEqual(canonical_value("A", " 10.0.0.1 "), "10.0.0.1")
        self.assertEqual(canonical_value("AAAA", "2001:DB8:0::1"), "2001:db8::1")
        self.assertEqual(canonical_value("CNAME", "www.example.com."), "www.example.com")
        self.assertEqual(canonical_value("MX", "mail.example.com.  010"), "mail.example.com 10")
        self.assertEqual(canonical_value("SRV", "sip.example.com 5060 0 100"), "sip.example.com 5060 0 100")
        self.assertEqual(canonical_value("TXT", "v=spf1 mx -all"), "v=spf1 mx -all")
        for rtype, value in (("A", "10.0.0.256"), ("AAAA", "10.0.0.1"), ("CNAME", "-x.example.com"),
                             ("CNAME", "a..b"), ("MX", "mail.example.com"), ("MX", "mail 70000"),
                             ("SRV", "x 1 2"), ("TXT", ""), ("TXT", "a\nb"), ("NS", "x")):
            with self.assertRaises(AddcError, msg=(rtype, value)):
                canonical_value(rtype, value)

    def test_names(self):
        for name in ("@", "www", "a.b", "*", "*.dev", "_sip._tcp", "host-1"):
            check_record_name(name)
        for name in ("", "a..b", "-x", "x-", "a b", "w*", "a.*", "x" * 64):
            with self.assertRaises(AddcError, msg=name):
                check_record_name(name)


class TestRead(Base):
    def test_zones_hide_root_hints(self):
        self.assertEqual(self.dns().zones(), [
            {"name": "_msdcs.school.internal", "partition": "forest", "read_only": True},
            {"name": "school.internal", "partition": "domain", "read_only": False}])

    def test_records_with_protection(self):
        records = self.dns().records("School.Internal.")
        by = {(r["name"], r["type"]): r for r in records}
        self.assertEqual(records[0]["name"], "@")
        self.assertNotIn(("old", "A"), by)
        for key in (("@", "SOA"), ("@", "NS"), ("@", "A"), ("dc", "A"), ("_ldap._tcp", "SRV"),
                    ("DomainDnsZones", "A")):
            self.assertTrue(by[key]["protected"], key)
        for key in (("@", "MX"), ("www", "A"), ("www", "TXT"), ("pc01", "A")):
            self.assertFalse(by[key]["protected"], key)
        self.assertTrue(by[("pc01", "A")]["dynamic"])
        self.assertEqual(by[("www", "A")], {"name": "www", "type": "A", "value": "10.0.0.80", "ttl": 900,
                                            "dynamic": False, "protected": False})

    def test_records_of_one_name(self):
        self.assertEqual([r["type"] for r in self.dns().records("school.internal", "www.school.internal")],
                         ["A", "TXT"])
        with self.assertRaisesRegex(AddcError, "not in the zone"):
            self.dns().records("school.internal", "www.other.org.")
        with self.assertRaisesRegex(AddcError, "not found"):
            self.dns().records("RootDNSServers")


class TestSet(Base):
    def test_new_name(self):
        result = self.dns().set({"zone": "school.internal", "name": "nas", "type": "A",
                                 "values": ["10.0.0.9", "10.0.0.9", "10.0.0.10"]})
        self.assertTrue(result["changed"])
        self.assertEqual(result["diff"]["before"], [])
        self.assertEqual([r["value"] for r in result["records"]], ["10.0.0.10", "10.0.0.9"])
        self.assertEqual(self.dc.writes[0][:2], ("nas", True))

    def test_replaces_one_type_only_and_is_idempotent(self):
        request = {"zone": "school.internal", "name": "WWW", "type": "A", "values": ["10.0.0.81"], "ttl": 300}
        result = self.dns().set(request)
        self.assertEqual([(r["type"], r["value"], r["ttl"]) for r in result["records"]],
                         [("A", "10.0.0.81", 300), ("TXT", "hello", 900)])
        self.assertFalse(self.dns().set(request)["changed"])
        self.assertEqual(len(self.dc.writes), 1)

    def test_dynamic_record_becomes_static(self):
        result = self.dns().set({"zone": "school.internal", "name": "pc01", "type": "A", "values": ["10.0.0.50"]})
        self.assertTrue(result["changed"])
        self.assertEqual(result["records"][0]["ttl"], 1200)
        self.assertFalse(result["records"][0]["dynamic"])

    def test_tombstoned_name_is_reused(self):
        self.dns().set({"zone": "school.internal", "name": "old", "type": "CNAME", "values": ["www.school.internal."]})
        self.assertEqual(self.dc.writes[0][:2], ("old", False))
        self.assertEqual(self.dns().records("school.internal", "old")[0]["value"], "www.school.internal")

    def test_cname_rules(self):
        with self.assertRaisesRegex(AddcError, "other records"):
            self.dns().set({"zone": "school.internal", "name": "www", "type": "CNAME", "values": ["x.org"]})
        with self.assertRaisesRegex(AddcError, "at most one CNAME"):
            self.dns().set({"zone": "school.internal", "name": "n", "type": "CNAME", "values": ["a.org", "b.org"]})
        self.dns().set({"zone": "school.internal", "name": "alias", "type": "CNAME", "values": ["www.school.internal"]})
        with self.assertRaisesRegex(AddcError, "is an alias"):
            self.dns().set({"zone": "school.internal", "name": "alias", "type": "TXT", "values": ["x"]})

    def test_protected(self):
        for name, rtype in (("@", "A"), ("dc", "A"), ("dc.school.internal.", "TXT"), ("_ldap._tcp", "SRV"),
                            ("_kerberos._udp", "SRV"), ("x.DomainDnsZones", "A")):
            with self.assertRaisesRegex(AddcError, "belong to the domain", msg=(name, rtype)):
                self.dns().set({"zone": "school.internal", "name": name, "type": rtype, "values": ["10.0.0.2"]
                                if rtype == "A" else ["x 1 2 3"] if rtype == "SRV" else ["x"]})
        with self.assertRaisesRegex(AddcError, "cannot be changed"):
            self.dns().set({"zone": "_msdcs.school.internal", "name": "x", "type": "A", "values": ["10.0.0.2"]})
        with self.assertRaisesRegex(AddcError, "cannot be changed here"):
            self.dns().set({"zone": "school.internal", "name": "x", "type": "NS", "values": ["a.org"]})
        # A service of one's own, and mail for the domain
        self.dns().set({"zone": "school.internal", "name": "_sip._tcp", "type": "SRV",
                        "values": ["sip.school.internal 5060 0 100"]})
        self.dns().set({"zone": "school.internal", "name": "@", "type": "TXT", "values": ["v=spf1 mx -all"]})
        self.assertEqual(self.dc.writes[-1][2][-1]["value"], "v=spf1 mx -all")
        self.assertEqual([r["type"] for r in self.dc.writes[-1][2]], ["SOA", "NS", "A", "MX", "TXT"])

    def test_check_mode_writes_nothing(self):
        self.runner.check = True
        result = self.dns().set({"zone": "school.internal", "name": "nas", "type": "A", "values": ["10.0.0.9"]})
        self.assertTrue(result["changed"])
        self.assertNotIn("nas", self.dc.nodes["school.internal"])


class TestDelete(Base):
    def test_values_or_all(self):
        self.dns().set({"zone": "school.internal", "name": "www", "type": "A", "values": ["10.0.0.80", "10.0.0.81"]})
        result = self.dns().delete({"zone": "school.internal", "name": "www", "type": "A", "values": ["10.0.0.81"]})
        self.assertEqual([r["value"] for r in result["records"]], ["10.0.0.80", "hello"])
        self.dns().delete({"zone": "school.internal", "name": "www", "type": "TXT"})
        result = self.dns().delete({"zone": "school.internal", "name": "www", "type": "A"})
        self.assertEqual(result["records"], [])
        self.assertIn(("school.internal", "www"), self.dc.tombstoned)
        self.assertFalse(self.dns().delete({"zone": "school.internal", "name": "www", "type": "A"})["changed"])

    def test_protected(self):
        with self.assertRaisesRegex(AddcError, "belong to the domain"):
            self.dns().delete({"zone": "school.internal", "name": "dc", "type": "A"})


class TestOperations(Base):
    def test_schema_refuses_other_types(self):
        with self.assertRaises(InvalidInput):
            execute(OPERATIONS[("dns", "set")], {"zone": "x", "name": "y", "type": "NS", "values": ["z"]}, False)
        with self.assertRaises(InvalidInput):
            execute(OPERATIONS[("dns", "set")], {"zone": "x", "name": "y", "type": "A", "values": []}, False)


if __name__ == "__main__":
    unittest.main()
