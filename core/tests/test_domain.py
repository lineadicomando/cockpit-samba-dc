# SPDX-License-Identifier: LGPL-2.1-or-later
import os
import stat
import tempfile
import unittest

from addcctl.backups import Backups
from addcctl.cli import execute
from addcctl.errors import AddcError
from addcctl.domain import Domain, _rdn_values
from addcctl.operations import OPERATIONS
from addcctl.runner import Runner

DOMAIN = "DC=samba,DC=test"
CONFIG = "CN=Configuration," + DOMAIN
SCHEMA = "CN=Schema," + CONFIG
NTDS = "CN=NTDS Settings,CN=DC,CN=Servers,CN=Default-First-Site-Name,CN=Sites," + CONFIG


class FakeRunner(Runner):
    """Records commands; diagnose answers from a table, change runs a hook."""

    def __init__(self, check=False, answers=None, on_change=None):
        super().__init__(check)
        self.answers = answers or {}
        self.on_change = on_change
        self.diagnosed = []

    def diagnose(self, args):
        self.diagnosed.append(" ".join(args))
        return self.answers.get(" ".join(args), (0, "ok\n"))

    def change(self, args, input=None):
        self.commands.append(" ".join(args))
        if not self.check and self.on_change:
            self.on_change(args)
        return ""


class FakeDc:
    workgroup = "SAMBATEST"
    netbios_name = "DC"
    realm = "SAMBA.TEST"
    domain_dn = DOMAIN
    config_dn = CONFIG
    schema_dn = SCHEMA
    samba_version = "4.22.11-Debian"

    def __init__(self):
        self.entries = {
            DOMAIN: {"msDS-Behavior-Version": ["4"], "fSMORoleOwner": [NTDS]},
            "CN=Partitions," + CONFIG: {"msDS-Behavior-Version": ["4"], "fSMORoleOwner": [NTDS]},
            SCHEMA: {"fSMORoleOwner": [NTDS]},
            "CN=RID Manager$,CN=System," + DOMAIN: {"fSMORoleOwner": [NTDS]},
            "CN=Infrastructure," + DOMAIN: {"fSMORoleOwner": [NTDS]},
            # No ForestDnsZones partition: its role is left out
            "CN=Infrastructure,DC=DomainDnsZones," + DOMAIN: {"fSMORoleOwner": [NTDS]},
        }
        self.servers = [
            {"dn": ["CN=DC2,CN=Servers,CN=Branch\\, North,CN=Sites," + CONFIG], "cn": ["DC2"],
             "dNSHostName": ["dc2.samba.test"]},
            {"dn": ["CN=DC,CN=Servers,CN=Default-First-Site-Name,CN=Sites," + CONFIG], "cn": ["DC"],
             "dNSHostName": ["dc.samba.test"]},
        ]

    def domain_attrs(self, attrs):
        return self.entry(DOMAIN, attrs)

    def entry(self, dn, attrs):
        found = self.entries.get(dn)
        return None if found is None else {"dn": [dn], **{a: found[a] for a in attrs if a in found}}

    def search(self, expression, attrs, base=None, scope="sub"):
        assert expression == "(objectClass=server)" and base == "CN=Sites," + CONFIG
        return self.servers


class TestInfo(unittest.TestCase):
    def test_overview(self):
        runner = FakeRunner(answers={"samba-tool processes": (0, "Service: PID\nldap_server 42\n")})
        info = Domain(FakeDc(), runner).info()
        self.assertEqual(info["realm"], "SAMBA.TEST")
        self.assertEqual(info["dns_domain"], "samba.test")
        self.assertEqual(info["netbios_domain"], "SAMBATEST")
        self.assertEqual(info["domain_level"], "2008 R2")
        self.assertEqual(info["forest_level"], "2008 R2")
        self.assertEqual(info["domain_controllers"], [
            {"name": "DC", "dns_name": "dc.samba.test", "site": "Default-First-Site-Name"},
            {"name": "DC2", "dns_name": "dc2.samba.test", "site": "Branch, North"},
        ])
        self.assertEqual([f["role"] for f in info["fsmo"]],
                         ["schema", "naming", "pdc", "rid", "infrastructure", "domaindns"])
        self.assertTrue(all(f["owner"] == "DC" for f in info["fsmo"]))
        self.assertIn("ldap_server", info["processes"])
        self.assertEqual(runner.commands, [])

    def test_processes_unavailable(self):
        runner = FakeRunner(answers={"samba-tool processes": (1, "no samba\n")})
        self.assertIsNone(Domain(FakeDc(), runner).info()["processes"])

    def test_dn_values(self):
        self.assertEqual(_rdn_values("CN=a\\,b,CN=c"), ["a,b", "c"])


DAY = -864000000000
MINUTE = -600000000


class PolicyDc(FakeDc):
    """A domain with Samba's default policy; modify() changes it as Dc does."""

    def __init__(self, runner):
        super().__init__()
        self.runner = runner
        self.entries[DOMAIN].update({
            "pwdProperties": ["17"], "minPwdLength": ["7"], "pwdHistoryLength": ["24"],
            "minPwdAge": [str(DAY)], "maxPwdAge": [str(43 * DAY)], "lockoutThreshold": ["0"],
            "lockoutDuration": [str(30 * MINUTE)], "lockOutObservationWindow": [str(30 * MINUTE)],
        })

    def modify(self, dn, changes):
        for attr, value in changes.items():
            self.runner.record("sam.ldb: %s %s = %s" % (dn, attr, value))
        if not self.runner.check:
            self.entries[dn].update({a: [str(v)] for a, v in changes.items()})


class TestPasswordPolicy(unittest.TestCase):
    def setUp(self):
        self.runner = FakeRunner()
        self.dc = PolicyDc(self.runner)
        self.domain = Domain(self.dc, self.runner)

    def test_read(self):
        self.assertEqual(self.domain.password_policy(), {
            "complexity": True, "min_length": 7, "history_length": 24, "min_age_days": 1,
            "max_age_days": 43, "lockout_threshold": 0, "lockout_duration_minutes": 30,
            "lockout_window_minutes": 30})

    def test_set_only_what_changes(self):
        result = self.domain.set_password_policy({"complexity": False, "min_length": 7, "max_age_days": None,
                                                  "lockout_threshold": 5, "lockout_duration_minutes": 15,
                                                  "lockout_window_minutes": 10})
        self.assertTrue(result["changed"])
        entry = self.dc.entries[DOMAIN]
        # The other bits of pwdProperties stay (0x10: store plaintext passwords)
        self.assertEqual(entry["pwdProperties"], ["16"])
        self.assertEqual(entry["maxPwdAge"], [str(-0x8000000000000000)])
        self.assertEqual(entry["lockoutDuration"], [str(15 * MINUTE)])
        self.assertEqual(entry["lockOutObservationWindow"], [str(10 * MINUTE)])
        self.assertEqual(len(self.runner.commands), 5)
        self.assertEqual(result["policy"]["max_age_days"], None)
        self.assertEqual(result["diff"]["before"]["lockout_threshold"], 0)
        self.assertEqual(result["diff"]["after"]["lockout_threshold"], 5)

    def test_unchanged(self):
        result = self.domain.set_password_policy({"min_length": 7, "complexity": True})
        self.assertFalse(result["changed"])
        self.assertEqual(self.runner.commands, [])

    def test_check_mode_previews(self):
        runner = FakeRunner(check=True)
        dc = PolicyDc(runner)
        result = Domain(dc, runner).set_password_policy({"min_length": 10})
        self.assertTrue(result["changed"])
        self.assertEqual(result["policy"]["min_length"], 10)
        self.assertEqual(dc.entries[DOMAIN]["minPwdLength"], ["7"])
        self.assertEqual(runner.commands, ["sam.ldb: %s minPwdLength = 10" % DOMAIN])

    def test_ages_are_checked_together(self):
        with self.assertRaisesRegex(AddcError, "greater than the minimum"):
            self.domain.set_password_policy({"min_age_days": 43})
        self.domain.set_password_policy({"max_age_days": None, "min_age_days": 100})
        self.assertEqual(self.domain.password_policy()["min_age_days"], 100)

    def test_lockout_window_within_duration(self):
        with self.assertRaisesRegex(AddcError, "cannot be longer"):
            self.domain.set_password_policy({"lockout_window_minutes": 31})
        with self.assertRaisesRegex(AddcError, "within the lockout duration"):
            self.domain.set_password_policy({"lockout_window_minutes": None})
        # Locked until an administrator unlocks it: any window
        self.domain.set_password_policy({"lockout_duration_minutes": None, "lockout_window_minutes": 600})
        self.assertIsNone(self.domain.password_policy()["lockout_duration_minutes"])

    def test_ranges_in_the_schema(self):
        op = OPERATIONS[("domain", "set-password-policy")]
        for request, message in (({"min_length": 15}, "at most 14"), ({"history_length": -1}, "at least 0"),
                                 ({"max_age_days": 0}, "at least 1"), ({"complexity": 1}, "boolean")):
            with self.assertRaisesRegex(Exception, message):
                execute(op, request, check=True)


class TestCheck(unittest.TestCase):
    def test_all_checks_report_failures_as_results(self):
        runner = FakeRunner(answers={"samba-tool ntacl sysvolcheck": (255, "ProvisioningError: mismatch\n")})
        checks = Domain(FakeDc(), runner).check()["checks"]
        self.assertEqual([c["name"] for c in checks], ["dbcheck", "sysvolcheck", "testparm"])
        self.assertEqual([c["ok"] for c in checks], [True, False, True])
        self.assertEqual(checks[1]["exit_code"], 255)
        self.assertIn("--cross-ncs", checks[0]["command"])
        self.assertNotIn("--fix", " ".join(runner.diagnosed))
        self.assertEqual(runner.commands, [])

    def test_one_check(self):
        runner = FakeRunner()
        checks = Domain(FakeDc(), runner).check(["testparm"])["checks"]
        self.assertEqual(runner.diagnosed, ["testparm -s"])
        self.assertEqual(len(checks), 1)

    def test_long_output_is_cut(self):
        runner = FakeRunner(answers={"testparm -s": (0, "x" * 100000)})
        output = Domain(FakeDc(), runner).check(["testparm"])["checks"][0]["output"]
        self.assertLess(len(output), 70000)
        self.assertIn("more characters", output)

    def test_unknown_check_is_refused(self):
        with self.assertRaisesRegex(Exception, "must be one of"):
            execute(OPERATIONS[("domain", "check")], {"checks": ["rm"]}, check=False)

    def test_sysvol_reset(self):
        runner = FakeRunner(check=True)
        self.assertEqual(Domain(FakeDc(), runner).sysvol_reset(), {"changed": True})
        self.assertEqual(runner.commands, ["samba-tool ntacl sysvolreset"])


def _found(name):
    return "/usr/bin/" + name


class TestBackups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "backups")

    def write_archive(self, args):
        """What samba-tool domain backup offline leaves: one archive, mode 0644."""
        target = args[-1].split("=", 1)[1]
        path = os.path.join(target, "samba-backup-samba.test-2026-10-24T10-00-00.000000.tar.bz2")
        with open(path, "wb") as f:
            f.write(b"archive")
        os.chmod(path, 0o644)

    def test_create_keeps_it_for_root(self):
        runner = FakeRunner(on_change=self.write_archive)
        result = Backups(runner, self.dir, which=_found).create()
        self.assertEqual(runner.commands, ["mkdir -m 0700 %s" % self.dir,
                                           "samba-tool domain backup offline --targetdir=%s" % self.dir])
        backup = result["backup"]
        self.assertTrue(backup["name"].startswith("samba-backup-"))
        self.assertEqual(backup["size"], 7)
        self.assertEqual(stat.S_IMODE(os.stat(self.dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(backup["path"]).st_mode), 0o600)
        self.assertEqual([b["name"] for b in Backups(runner, self.dir).list()], [backup["name"]])

    def test_check_mode_changes_nothing(self):
        runner = FakeRunner(check=True, on_change=self.write_archive)
        self.assertEqual(Backups(runner, self.dir, which=_found).create(), {"changed": True, "backup": None})
        self.assertFalse(os.path.exists(self.dir))

    def test_create_without_tdbbackup(self):
        runner = FakeRunner(check=True)
        with self.assertRaisesRegex(AddcError, "tdb-tools"):
            Backups(runner, self.dir, which=lambda name: None).create()
        self.assertEqual(runner.commands, [])

    def test_list_only_archives(self):
        os.makedirs(self.dir)
        for name in ("samba-backup-a.tar.bz2", "notes.txt", "samba-backup-b.tar.bz2"):
            with open(os.path.join(self.dir, name), "w") as f:
                f.write("x")
        os.utime(os.path.join(self.dir, "samba-backup-a.tar.bz2"), (1, 1))
        self.assertEqual([b["name"] for b in Backups(FakeRunner(), self.dir).list()],
                         ["samba-backup-b.tar.bz2", "samba-backup-a.tar.bz2"])
        self.assertEqual(Backups(FakeRunner(), os.path.join(self.tmp.name, "none")).list(), [])


if __name__ == "__main__":
    unittest.main()
