# SPDX-License-Identifier: LGPL-2.1-or-later
import os
import tempfile
import unittest

from addcctl.errors import AddcError
from addcctl.mcp import tools
from addcctl.operations import OPERATIONS
from addcctl.runner import Runner
from addcctl.setup import (Host, Setup, forwarder_violation, host_name_violation, netbios_violation,
                           password_violation, realm_violation, smb_conf_sections)

DEBIAN_SMB_CONF = """#
# Sample configuration file for the Samba suite for Debian GNU/Linux.
[global]
   workgroup = WORKGROUP
   server role = standalone server
   map to guest = bad user
[homes]
   comment = Home Directories
[printers]
   comment = All Printers
[print$]
   comment = Printer Drivers
"""

HOSTS = """127.0.0.1\tlocalhost
127.0.1.1\tdc.example.lan dc

# The following lines are desirable for IPv6 capable hosts
::1     localhost ip6-localhost ip6-loopback
"""

NSSWITCH = """passwd:         files systemd
group:          files systemd
shadow:         files systemd
hosts:          files dns
"""

STATIC = {"family": "inet", "local": "192.168.1.20", "prefixlen": 24, "scope": "global",
          "valid_life_time": 4294967295}
DHCP = dict(STATIC, dynamic=True, valid_life_time=3540)
REQUEST = {"realm": "School.Example.Org", "netbios_domain": "school", "admin_password": "Secret-Pass1",
           "dns_forwarder": "192.168.1.1"}


class FakeRunner(Runner):
    def __init__(self, check=False):
        super().__init__(check)

    def change(self, args, input=None):
        self.commands.append(" ".join(args))
        return ""


class FakeHost(Host):
    """A host under a temporary directory, with the answers of a clean Debian."""

    def __init__(self, runner, root):
        super().__init__(runner, root)
        self.name = "dc"
        self.addresses = [STATIC]
        self.ports = [(445, ["smbd"]), (139, ["smbd"]), (137, ["nmbd"]), (9090, ["systemd"])]
        self.units = set()
        self.synchronized = True
        self.free = 20 * 1024 ** 3
        self.dns_after = 0  # queries before the DNS answers; None: never
        self.dns_queries = 0
        self.write("/proc/net/route", "Iface\tDestination\tGateway\nenp1s0\t00000000\t0101A8C0\n")
        self.write("/etc/samba/smb.conf", DEBIAN_SMB_CONF)
        self.write("/etc/hosts", HOSTS)
        self.write("/etc/nsswitch.conf", NSSWITCH)
        self.write("/etc/resolv.conf", "search example.lan\nnameserver 192.168.1.1\n")
        os.makedirs(self.path("/var/lib/samba/private"))

    def write(self, p, content):
        os.makedirs(os.path.dirname(self.path(p)), exist_ok=True)
        with open(self.path(p), "w") as f:
            f.write(content)

    def hostname(self):
        return self.name

    def fqdn(self):
        return self.name + ".example.lan"

    def ipv4_addresses(self, interface):
        return self.addresses

    def listeners(self):
        return self.ports

    def active(self, unit):
        return unit in self.units

    def time_synchronized(self):
        return self.synchronized

    def free_bytes(self, p):
        return self.free

    def dns_answers(self, name, server="127.0.0.1"):
        self.dns_queries += 1
        return self.dns_after is not None and self.dns_queries > self.dns_after


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runner = FakeRunner()
        self.host = FakeHost(self.runner, self.tmp.name)
        self.provisioned_with = []
        self.provision_error = None
        self.clock = [0.0]

    def fake_provision(self, **kwargs):
        self.provisioned_with.append(kwargs)
        if self.provision_error == "before":
            raise RuntimeError("guess_names: something")
        self.host.write("/var/lib/samba/private/sam.ldb", "")
        self.host.write("/var/lib/samba/private/krb5.conf", "[libdefaults]\n")
        if self.provision_error == "after":
            raise RuntimeError("setup_samdb failed")

    def setup(self, runner=None):
        runner = runner or self.runner
        self.host.runner = runner

        def sleep(seconds):
            self.clock[0] += seconds

        return Setup(runner, host=self.host, provision_fn=self.fake_provision, sleep=sleep,
                     clock=lambda: self.clock[0])

    def states(self, report):
        return {c["name"]: c["state"] for c in report["checks"]}


class TestCheck(SetupTest):
    def test_clean_debian(self):
        self.host.write("/usr/sbin/chronyd", "")
        report = self.setup().check()
        self.assertFalse(report["provisioned"])
        self.assertTrue(report["ready"])
        self.assertEqual(self.states(report), {"smb_conf": "ok", "address": "ok", "host_name": "ok", "ports": "ok",
                                               "time": "ok", "disk": "ok"})
        self.assertEqual(report["host"], {"name": "dc", "address": "192.168.1.20", "prefix_length": 24,
                                          "interface": "enp1s0"})
        self.assertEqual(report["defaults"], {"realm": "EXAMPLE.LAN", "netbios_domain": "EXAMPLE",
                                              "dns_forwarder": "192.168.1.1"})
        ports = [c for c in report["checks"] if c["name"] == "ports"][0]
        self.assertIn("nmbd, smbd", ports["message"])

    def test_provisioned(self):
        self.host.write("/var/lib/samba/private/sam.ldb", "")
        report = self.setup().check()
        self.assertTrue(report["provisioned"])
        self.assertFalse(report["ready"])
        self.assertEqual(report["checks"], [])

    def test_dhcp_address(self):
        self.host.addresses = [DHCP]
        report = self.setup().check()
        self.assertFalse(report["ready"])
        self.assertEqual(self.states(report)["address"], "error")
        self.assertIn("Networking", [c for c in report["checks"] if c["name"] == "address"][0]["fix"])

    def test_no_default_route(self):
        self.host.write("/proc/net/route", "Iface\tDestination\tGateway\n")
        self.assertEqual(self.states(self.setup().check())["address"], "error")

    def test_port_taken(self):
        self.host.ports.append((53, ["dnsmasq"]))
        self.host.ports.append((53, ["systemd-resolve"]))
        report = self.setup().check()
        ports = [c for c in report["checks"] if c["name"] == "ports"][0]
        self.assertEqual(ports["state"], "error")
        self.assertIn("dnsmasq on 53 (DNS)", ports["message"])
        self.assertNotIn("systemd-resolve", ports["message"])

    def test_smb_conf_of_its_own(self):
        self.host.write("/etc/samba/smb.conf", DEBIAN_SMB_CONF + "[data]\n   path = /srv/data\n")
        self.assertEqual(self.states(self.setup().check())["smb_conf"], "error")
        self.host.write("/etc/samba/smb.conf", "[global]\n server role = member server\n")
        self.assertEqual(self.states(self.setup().check())["smb_conf"], "error")
        os.remove(self.host.path("/etc/samba/smb.conf"))
        self.assertEqual(self.states(self.setup().check())["smb_conf"], "ok")

    def test_leftovers_of_a_provisioning(self):
        self.host.write("/var/lib/samba/private/secrets.ldb", "")
        self.assertEqual(self.states(self.setup().check())["smb_conf"], "error")

    def test_host_name(self):
        self.host.name = "localhost"
        self.assertEqual(self.states(self.setup().check())["host_name"], "error")
        self.host.name = "a-very-long-host-name"
        self.assertEqual(self.states(self.setup().check())["host_name"], "error")

    def test_time_and_disk(self):
        self.host.synchronized = False
        self.host.free = 100 * 1024 ** 2
        report = self.setup().check()
        self.assertEqual(self.states(report)["time"], "warning")
        self.assertEqual(self.states(report)["disk"], "error")
        self.host.synchronized = True
        self.host.free = 512 * 1024 ** 2
        report = self.setup().check()
        self.assertEqual(self.states(report)["time"], "warning")  # no chrony
        self.assertEqual(self.states(report)["disk"], "warning")
        self.assertTrue(report["ready"])

    def test_defaults_without_a_domain(self):
        self.host.fqdn = lambda: "dc"
        self.host.write("/etc/resolv.conf", "nameserver 127.0.0.53\n")
        self.host.write("/run/systemd/resolve/resolv.conf", "nameserver 10.0.0.1\n")
        self.assertEqual(self.setup().check()["defaults"],
                         {"realm": None, "netbios_domain": None, "dns_forwarder": "10.0.0.1"})

    def test_smb_conf_sections(self):
        sections = smb_conf_sections(DEBIAN_SMB_CONF)
        self.assertEqual(set(sections), {"global", "homes", "printers", "print$"})
        self.assertEqual(sections["global"]["server role"], "standalone server")


class TestValues(unittest.TestCase):
    def test_host_name(self):
        self.assertIsNone(host_name_violation("dc01"))
        for bad in ("", "localhost", "1234", "-dc", "dc_1", "sixteen-letters1"):
            self.assertIsNotNone(host_name_violation(bad), bad)

    def test_realm(self):
        self.assertIsNone(realm_violation("school.example.org", "dc"))
        for bad in ("school", "-a.org", "a..org", "a.b_c.org", "school.123", "dc.", "a.org;x"):
            self.assertIsNotNone(realm_violation(bad, "dc"), bad)

    def test_netbios(self):
        self.assertIsNone(netbios_violation("SCHOOL", "dc"))
        for bad in ("DC", "", "SIXTEEN-LETTERS1", "-SCHOOL", "123", "SCH.OOL", "SCH OOL"):
            self.assertIsNotNone(netbios_violation(bad, "dc"), bad)

    def test_forwarder(self):
        self.assertIsNone(forwarder_violation("192.168.1.1", "192.168.1.20"))
        self.assertIsNone(forwarder_violation("2001:db8::1", "192.168.1.20"))
        for bad in ("dns.example.org", "127.0.0.1", "0.0.0.0", "192.168.1.20", "1.1.1.1 8.8.8.8"):
            self.assertIsNotNone(forwarder_violation(bad, "192.168.1.20"), bad)

    def test_password(self):
        self.assertIsNotNone(password_violation("Ab1!"))
        self.assertIsNotNone(password_violation("MyAdministrator1!"))
        self.assertIsNone(password_violation("Secret-Pass1"))


class TestProvision(SetupTest):
    def test_provision(self):
        self.host.write("/usr/sbin/chronyd", "")
        self.host.units.add("systemd-resolved")
        self.host.dns_after = 2
        result = self.setup().provision(dict(REQUEST))
        self.assertEqual(self.provisioned_with, [{
            "realm": "SCHOOL.EXAMPLE.ORG", "domain": "SCHOOL", "hostname": "dc", "hostip": "192.168.1.20",
            "dns_forwarder": "192.168.1.1", "adminpass": "Secret-Pass1"}])
        self.assertEqual(result["domain"], {"realm": "SCHOOL.EXAMPLE.ORG", "dns_domain": "school.example.org",
                                            "netbios_domain": "SCHOOL", "server": "dc.school.example.org",
                                            "address": "192.168.1.20", "dns_forwarder": "192.168.1.1"})
        self.assertEqual(result["smb_conf_dist"], "/etc/samba/smb.conf.dist")
        commands = self.runner.commands
        self.assertFalse(any("Secret-Pass1" in c for c in commands))
        order = ["systemctl stop smbd nmbd winbind", "systemctl mask smbd nmbd winbind",
                 "move /etc/samba/smb.conf to /etc/samba/smb.conf.dist", "systemctl restart chrony",
                 "systemctl disable --now systemd-resolved", "systemctl unmask samba-ad-dc",
                 "systemctl enable --now samba-ad-dc"]
        self.assertEqual([c for c in commands if c in order], order)
        self.assertFalse(self.host.exists("/etc/samba/smb.conf"))
        self.assertEqual(self.host.read("/etc/samba/smb.conf.dist"), DEBIAN_SMB_CONF)
        hosts = self.host.read("/etc/hosts")
        self.assertNotIn("127.0.1.1", hosts)
        self.assertTrue(hosts.endswith("::1     localhost ip6-localhost ip6-loopback\n"
                                       "192.168.1.20\tdc.school.example.org dc\n"))
        self.assertEqual(os.readlink(self.host.path("/etc/krb5.conf")), "/var/lib/samba/private/krb5.conf")
        self.assertIn("passwd:         files systemd winbind\ngroup:          files systemd winbind\n",
                      self.host.read("/etc/nsswitch.conf"))
        self.assertEqual(self.host.read("/etc/chrony/conf.d/samba-dc.conf").splitlines()[1:],
                         ["ntpsigndsocket /var/lib/samba/ntp_signd", "allow 192.168.1.0/24"])
        self.assertEqual(self.host.read("/etc/resolv.conf"), "search school.example.org\nnameserver 127.0.0.1\n")
        self.assertEqual(self.host.dns_queries, 3)

    def test_existing_krb5_conf_and_resolv_link(self):
        self.host.write("/etc/krb5.conf", "[libdefaults]\n")
        self.host.write("/run/systemd/resolve/stub-resolv.conf", "nameserver 127.0.0.53\n")
        os.remove(self.host.path("/etc/resolv.conf"))
        os.symlink("../run/systemd/resolve/stub-resolv.conf", self.host.path("/etc/resolv.conf"))
        self.setup().provision(dict(REQUEST))
        self.assertEqual(self.host.read("/etc/krb5.conf.dist"), "[libdefaults]\n")
        self.assertFalse(os.path.islink(self.host.path("/etc/resolv.conf")))
        self.assertEqual(self.host.read("/run/systemd/resolve/stub-resolv.conf"), "nameserver 127.0.0.53\n")

    def test_check_mode_changes_nothing(self):
        runner = FakeRunner(check=True)
        result = self.setup(runner).provision(dict(REQUEST))
        self.assertTrue(result["changed"])
        self.assertEqual(self.provisioned_with, [])
        self.assertEqual(self.host.read("/etc/samba/smb.conf"), DEBIAN_SMB_CONF)
        self.assertEqual(self.host.read("/etc/hosts"), HOSTS)
        self.assertFalse(self.host.exists("/etc/krb5.conf"))
        self.assertIn("provision: realm SCHOOL.EXAMPLE.ORG, domain SCHOOL, DC dc.school.example.org at "
                      "192.168.1.20, DNS forwarder 192.168.1.1 (samba.provision)", runner.commands)
        self.assertIn("write %s" % self.host.path("/etc/hosts"), runner.commands)

    def test_refused_on_a_domain(self):
        self.host.write("/var/lib/samba/private/sam.ldb", "")
        with self.assertRaisesRegex(AddcError, "domain controller already"):
            self.setup().provision(dict(REQUEST))
        self.assertEqual(self.runner.commands, [])

    def test_refused_when_not_ready(self):
        self.host.addresses = [DHCP]
        with self.assertRaisesRegex(AddcError, "not ready for a new domain: .*DHCP"):
            self.setup().provision(dict(REQUEST))
        self.assertEqual(self.runner.commands, [])

    def test_refused_values(self):
        for key, value, message in (("realm", "school", "two or more parts"),
                                    ("netbios_domain", "dc", "must not be the host name"),
                                    ("dns_forwarder", "127.0.0.1", "another DNS server"),
                                    ("admin_password", "short", "at least 7")):
            with self.assertRaisesRegex(AddcError, message):
                self.setup().provision(dict(REQUEST, **{key: value}))
        self.assertEqual(self.runner.commands, [])

    def test_failure_before_the_directory_undoes(self):
        self.provision_error = "before"
        with self.assertRaisesRegex(AddcError, "the host is as it was: guess_names: something"):
            self.setup().provision(dict(REQUEST))
        self.assertEqual(self.host.read("/etc/samba/smb.conf"), DEBIAN_SMB_CONF)
        self.assertFalse(self.host.exists("/etc/samba/smb.conf.dist"))
        self.assertEqual(self.runner.commands[-2:], ["systemctl unmask smbd nmbd winbind",
                                                     "systemctl start smbd nmbd winbind"])

    def test_failure_after_the_directory_is_left(self):
        self.provision_error = "after"
        with self.assertRaisesRegex(AddcError, "after writing the directory: setup_samdb failed.*remove by hand"):
            self.setup().provision(dict(REQUEST))
        self.assertFalse(any("unmask smbd" in c for c in self.runner.commands))

    def test_dns_that_never_answers(self):
        self.host.dns_after = None
        with self.assertRaisesRegex(AddcError, "provisioned, but the DNS of the domain failed: .*"
                                               "Left to do by hand: the DNS of the domain, /etc/resolv.conf"):
            self.setup().provision(dict(REQUEST))
        self.assertEqual(self.host.read("/etc/resolv.conf"), "search example.lan\nnameserver 192.168.1.1\n")

    def test_a_second_smb_conf_dist(self):
        self.host.write("/etc/samba/smb.conf.dist", "older\n")
        result = self.setup().provision(dict(REQUEST))
        self.assertEqual(result["smb_conf_dist"], "/etc/samba/smb.conf.dist.1")
        self.assertEqual(self.host.read("/etc/samba/smb.conf.dist"), "older\n")


class TestOperations(unittest.TestCase):
    def test_provision_is_not_an_mcp_tool(self):
        names = set(tools(OPERATIONS))
        self.assertIn("domain_setup_check", names)
        self.assertNotIn("domain_provision", names)
        self.assertTrue(OPERATIONS[("domain", "provision")]["input"]["properties"]["admin_password"]["writeOnly"])


if __name__ == "__main__":
    unittest.main()
