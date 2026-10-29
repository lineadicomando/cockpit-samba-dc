# SPDX-License-Identifier: LGPL-2.1-or-later
"""A new domain on a host with none: the check of its prerequisites
(domain setup-check) and the provisioning (domain provision).

Scope: a new forest with one DC, never over an existing domain. The network
is verified, not changed: a static address is set by the administrator.
The provisioning runs Samba's own code (samba.provision, what samba-tool
domain provision runs) in this process, so the administrator's password
goes from addcctl's stdin to Samba and never into an argv (rule 2).
"""
import contextlib
import ipaddress
import json
import logging
import os
import random
import re
import socket
import struct
import sys
import time

from .dc import SAM_LDB
from .errors import AddcError

SMB_CONF = "/etc/samba/smb.conf"
SAMBA_KRB5 = "/var/lib/samba/private/krb5.conf"
NTP_SIGND = "/var/lib/samba/ntp_signd"
CHRONY_CONF = "/etc/chrony/conf.d/samba-dc.conf"
PROVISION_LOG = "/var/log/samba/addcctl-provision.log"

# What a DC serves; another program on one of them makes Samba fail to start
PORTS = {53: "DNS", 88: "Kerberos", 135: "RPC", 137: "NetBIOS", 138: "NetBIOS", 139: "NetBIOS", 389: "LDAP", 445: "SMB", 464: "Kerberos password",
         636: "LDAPS", 3268: "Global catalog", 3269: "Global catalog (TLS)"}
# Programs on those ports that the provisioning stops itself
STOPPED = {"smbd": "smbd", "nmbd": "nmbd", "winbindd": "winbind", "systemd-resolve": "systemd-resolved"}
# Debian's smb.conf: the sections of a standalone server nobody has set up
DEBIAN_SECTIONS = {"global", "homes", "printers", "print$"}

MIN_FREE = 256 * 1024 * 1024
LOW_FREE = 1024 * 1024 * 1024
MIN_PASSWORD = 7  # samba.provision.DEFAULT_MIN_PWD_LENGTH
DNS_WAIT_SECONDS = 90

_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
_NETBIOS = re.compile(r"^[A-Z0-9]([A-Z0-9-]{0,13}[A-Z0-9])?$")


class Host:
    """What the setup reads of the host. root prefixes every path (tests)."""

    def __init__(self, runner, root="/"):
        self.runner = runner
        self.root = root

    def path(self, p):
        return os.path.join(self.root, p.lstrip("/"))

    def exists(self, p):
        return os.path.lexists(self.path(p))

    def read(self, p):
        try:
            with open(self.path(p), encoding="utf-8", errors="replace") as f:
                return f.read()
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            return None

    def listdir(self, p):
        try:
            return os.listdir(self.path(p))
        except (FileNotFoundError, NotADirectoryError):
            return []

    def hostname(self):
        return socket.gethostname()

    def fqdn(self):
        return socket.getfqdn()

    def default_interface(self):
        """The interface of the IPv4 default route (/proc/net/route), or None."""
        for line in (self.read("/proc/net/route") or "").splitlines()[1:]:
            fields = line.split()
            if len(fields) > 2 and fields[1] == "00000000":
                return fields[0]
        return None

    def ipv4_addresses(self, interface):
        """[{local, prefixlen, dynamic, valid_life_time}] of the global IPv4
        addresses of interface (ip -j)."""
        out = self.runner.query(["ip", "-j", "-4", "addr", "show", "dev", interface])
        try:
            links = json.loads(out or "[]")
        except ValueError:
            return []
        return [a for link in links for a in link.get("addr_info", [])
                if a.get("family") == "inet" and a.get("scope") == "global"]

    def listeners(self):
        """[(port, [program])] of the listening TCP and UDP sockets (ss)."""
        out = self.runner.query(["ss", "-H", "-l", "-n", "-t", "-u", "-p"])
        found = []
        for line in out.splitlines():
            fields = line.split()
            if len(fields) < 5:
                continue
            port = fields[4].rsplit(":", 1)[-1]
            if port.isdigit():
                found.append((int(port), re.findall(r'\("([^"]+)"', line)))
        return found

    def active(self, unit):
        code, _ = self.runner.diagnose(["systemctl", "is-active", "--quiet", unit])
        return code == 0

    def time_synchronized(self):
        code, out = self.runner.diagnose(["timedatectl", "show", "-p", "NTPSynchronized", "--value"])
        return code == 0 and out.strip() == "yes"

    def free_bytes(self, p):
        """Free space of the file system that holds p, or of its nearest parent."""
        p = self.path(p)
        while not os.path.exists(p) and os.path.dirname(p) != p:
            p = os.path.dirname(p)
        st = os.statvfs(p)
        return st.f_bavail * st.f_frsize

    def dns_answers(self, name, server="127.0.0.1"):
        """Whether the DNS server at server resolves name (an A record)."""
        return dns_query(name, server)

    def private_dir(self, p, group, mode):
        """A directory of root and group (when it exists), with mode."""
        import grp
        path = self.path(p)
        os.makedirs(path, exist_ok=True)
        try:
            os.chown(path, 0, grp.getgrnam(group).gr_gid)
        except KeyError:
            pass
        os.chmod(path, mode)


# -- the check

def _check(name, state, message, fix=None):
    found = {"name": name, "state": state, "message": message}
    if fix:
        found["fix"] = fix
    return found


def smb_conf_sections(text):
    """({section: {lowercased parameter: value}}) of an smb.conf."""
    sections, current = {}, None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1].strip().lower()
            sections.setdefault(current, {})
        elif "=" in line and current is not None:
            key, value = line.split("=", 1)
            sections[current][" ".join(key.lower().split())] = value.strip()
    return sections


def nameservers(text):
    return [line.split()[1] for line in (text or "").splitlines()
            if line.split()[:1] == ["nameserver"] and len(line.split()) > 1]


def _is_loopback(address):
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return True


class Setup:
    def __init__(self, runner, host=None, provision_fn=None, sleep=time.sleep, clock=time.monotonic):
        self.runner = runner
        self.host = host or Host(runner)
        self.provision_fn = provision_fn or samba_provision
        self.sleep = sleep
        self.clock = clock

    def provisioned(self):
        return self.host.exists(SAM_LDB)

    def check(self):
        """{provisioned, ready, checks, host, defaults}: whether the host is
        a DC already, then each prerequisite of a new domain with its state
        (ok, warning, error) and what to do, and the values the form proposes."""
        if self.provisioned():
            return {"provisioned": True, "ready": False, "checks": [], "host": None, "defaults": None}
        host = {"name": self.host.hostname().split(".")[0], "address": None, "prefix_length": None,
                "interface": None}
        checks = [self._smb_conf(), self._address(host), self._host_name(host["name"]), self._ports(),
                  self._time(), self._disk()]
        return {
            "provisioned": False,
            "ready": not any(c["state"] == "error" for c in checks),
            "checks": checks,
            "host": host,
            "defaults": self._defaults(host),
        }

    def _smb_conf(self):
        if self.host.listdir("/var/lib/samba/sysvol") or any(
                n.endswith(".ldb") for n in self.host.listdir("/var/lib/samba/private")):
            return _check("smb_conf", "error",
                          "A provisioning left files behind (/var/lib/samba/private/*.ldb, sysvol) with no sam.ldb",
                          "Remove them by hand if they are not needed, then check again")
        text = self.host.read(SMB_CONF)
        if text is None:
            return _check("smb_conf", "ok", "No smb.conf: the provisioning writes it")
        sections = smb_conf_sections(text)
        role = sections.get("global", {}).get("server role", "standalone server").lower()
        if role not in ("standalone", "standalone server", "auto"):
            return _check("smb_conf", "error",
                          'smb.conf sets "server role = %s": Samba is set up for something else on this host' % role,
                          "Move /etc/samba/smb.conf aside by hand if it is not needed, then check again")
        own = sorted(set(sections) - DEBIAN_SECTIONS)
        if own:
            return _check("smb_conf", "error",
                          "smb.conf has shares of its own (%s): they would stop being served" % ", ".join(own),
                          "Move /etc/samba/smb.conf aside by hand if they are not needed, then check again")
        return _check("smb_conf", "ok",
                      "Debian's smb.conf of a standalone server: kept as smb.conf.dist, smbd and nmbd stopped")

    def _address(self, host):
        interface = self.host.default_interface()
        if interface is None:
            return _check("address", "error", "No default route: the host has no network",
                          "Set a static address and a gateway in Cockpit's Networking page")
        host["interface"] = interface
        addresses = self.host.ipv4_addresses(interface)
        if not addresses:
            return _check("address", "error", "No IPv4 address on %s, the interface of the default route" % interface,
                          "Set a static address in Cockpit's Networking page")
        a = addresses[0]
        host["address"], host["prefix_length"] = a.get("local"), a.get("prefixlen")
        if a.get("dynamic") or a.get("valid_life_time", 0xFFFFFFFF) != 0xFFFFFFFF:
            return _check("address", "error",
                          "%s/%s on %s comes from DHCP: a domain controller needs a static address"
                          % (host["address"], host["prefix_length"], interface),
                          "Set a static address in Cockpit's Networking page (or /etc/network/interfaces), "
                          "then check again")
        return _check("address", "ok", "Static address %s/%s on %s" % (host["address"], host["prefix_length"],
                                                                        interface))

    def _host_name(self, name):
        problem = host_name_violation(name)
        if problem:
            return _check("host_name", "error", problem,
                          "Change it (hostnamectl set-hostname NAME, or Cockpit's Overview page), then check again")
        return _check("host_name", "ok", 'Host name "%s"' % name)

    def _ports(self):
        busy, stopped = {}, set()
        for port, programs in self.host.listeners():
            if port not in PORTS:
                continue
            for program in programs or ["?"]:
                if program in STOPPED:
                    stopped.add(STOPPED[program])
                else:
                    busy.setdefault(program, set()).add(port)
        if busy:
            listed = "; ".join("%s on %s" % (p, ", ".join("%d (%s)" % (n, PORTS[n]) for n in sorted(ports)))
                               for p, ports in sorted(busy.items()))
            return _check("ports", "error", "Ports a domain controller needs are in use: %s" % listed,
                          "Stop and disable those services (for example: systemctl disable --now dnsmasq), "
                          "then check again")
        if stopped:
            return _check("ports", "ok", "The ports a domain controller needs are free once %s are stopped, "
                          "which the provisioning does" % ", ".join(sorted(stopped)))
        return _check("ports", "ok", "The ports a domain controller needs are free")

    def _time(self):
        synchronized = self.host.time_synchronized()
        chrony = self.host.exists("/usr/sbin/chronyd")
        if not synchronized:
            return _check("time", "warning", "The clock is not synchronized: Kerberos refuses clients whose clock "
                          "differs by more than 5 minutes", "Install chrony, or enable systemd-timesyncd")
        if not chrony:
            return _check("time", "warning", "The clock is synchronized, but without chrony the domain controller "
                          "gives no time to the domain's Windows computers",
                          "Install chrony (apt install chrony) before the provisioning, which sets it up")
        return _check("time", "ok", "The clock is synchronized by chrony, which the provisioning sets up to serve "
                      "the domain's computers")

    def _disk(self):
        free = self.host.free_bytes("/var/lib/samba")
        shown = "%.1f GiB free under /var/lib/samba" % (free / 1024 ** 3)
        if free < MIN_FREE:
            return _check("disk", "error", shown, "Free some space, then check again")
        if free < LOW_FREE:
            return _check("disk", "warning", shown + ": the directory and the shared folders will need more")
        return _check("disk", "ok", shown)

    def _defaults(self, host):
        fqdn = self.host.fqdn()
        domain = fqdn.split(".", 1)[1].lower() if "." in fqdn else ""
        if domain and realm_violation(domain, host["name"]):
            domain = ""
        netbios = domain.split(".")[0].upper()[:15] if domain else ""
        if netbios and netbios_violation(netbios, host["name"]):
            netbios = ""
        forwarders = [n for n in nameservers(self.host.read("/etc/resolv.conf")) if not _is_loopback(n)]
        if not forwarders:
            forwarders = [n for n in nameservers(self.host.read("/run/systemd/resolve/resolv.conf"))
                          if not _is_loopback(n)]
        return {"realm": domain.upper() or None, "netbios_domain": netbios or None,
                "dns_forwarder": forwarders[0] if forwarders else None}

    # -- the provisioning

    def provision(self, request):
        report = self.check()
        if report["provisioned"]:
            raise AddcError("This host is a domain controller already (%s exists): it is never provisioned again"
                            % SAM_LDB)
        failed = [c["message"] for c in report["checks"] if c["state"] == "error"]
        if failed:
            raise AddcError("The host is not ready for a new domain: %s" % "; ".join(failed))
        host = report["host"]
        realm = request["realm"].strip().rstrip(".").lower()
        netbios = request["netbios_domain"].strip().upper()
        forwarder = request["dns_forwarder"].strip()
        for problem in (realm_violation(realm, host["name"]), netbios_violation(netbios, host["name"]),
                        forwarder_violation(forwarder, host["address"]),
                        password_violation(request["admin_password"])):
            if problem:
                raise AddcError(problem)
        fqdn = "%s.%s" % (host["name"].lower(), realm)

        # Until sam.ldb exists, a failure puts the host back as it was
        self.runner.change(["systemctl", "stop", "smbd", "nmbd", "winbind"])
        self.runner.change(["systemctl", "mask", "smbd", "nmbd", "winbind"])
        kept = None
        if self.host.exists(SMB_CONF):
            kept = self._free_name(SMB_CONF + ".dist")
            self._rename(SMB_CONF, kept)
        self.runner.record("provision: realm %s, domain %s, DC %s at %s, DNS forwarder %s (samba.provision)"
                           % (realm.upper(), netbios, fqdn, host["address"], forwarder))
        if not self.runner.check:
            try:
                self.provision_fn(realm=realm.upper(), domain=netbios, hostname=host["name"].lower(),
                                  hostip=host["address"], dns_forwarder=forwarder,
                                  adminpass=request["admin_password"])
            except Exception as e:
                message = _message(e)
                if self.host.exists(SAM_LDB):
                    raise AddcError(
                        "The provisioning failed after writing the directory: %s. Left on the host, to remove by "
                        "hand before trying again: /etc/samba/smb.conf, /var/lib/samba/private/*.ldb and "
                        "sam.ldb.d, /var/lib/samba/sysvol%s (details in %s)" % (
                            message, "; Debian's smb.conf is %s" % kept if kept else "", PROVISION_LOG)) from None
                self._undo(kept)
                raise AddcError("The provisioning failed, the host is as it was: %s (details in %s)"
                                % (message, PROVISION_LOG)) from None

        steps = [
            ("/etc/hosts", lambda: self._hosts(host["address"], fqdn, host["name"].lower())),
            ("/etc/krb5.conf", self._krb5),
            ("winbind in /etc/nsswitch.conf", self._nsswitch),
            ("chrony", lambda: self._chrony(host)),
            ("the start of samba-ad-dc", self._start),
            ("the DNS of the domain", lambda: self._wait_dns(fqdn)),
            ("/etc/resolv.conf", lambda: self._resolv(realm)),
        ]
        for i, (what, step) in enumerate(steps):
            try:
                step()
            except AddcError as e:
                left = ", ".join(w for w, _ in steps[i:])
                raise AddcError("The domain is provisioned, but %s failed: %s. Left to do by hand: %s"
                                % (what, e, left)) from None
        return {"changed": True, "domain": {"realm": realm.upper(), "dns_domain": realm, "netbios_domain": netbios,
                                            "server": fqdn, "address": host["address"],
                                            "dns_forwarder": forwarder},
                "smb_conf_dist": kept}

    def _free_name(self, path):
        if not self.host.exists(path):
            return path
        n = 1
        while self.host.exists("%s.%d" % (path, n)):
            n += 1
        return "%s.%d" % (path, n)

    def _rename(self, old, new):
        self.runner.record("move %s to %s" % (old, new))
        if not self.runner.check:
            os.rename(self.host.path(old), self.host.path(new))

    def _undo(self, kept):
        if kept:
            self._rename(kept, SMB_CONF)
        self.runner.change(["systemctl", "unmask", "smbd", "nmbd", "winbind"])
        self.runner.change(["systemctl", "start", "smbd", "nmbd", "winbind"])

    def _hosts(self, address, fqdn, short):
        """The FQDN on the static address, Debian's 127.0.1.1 line dropped."""
        text = self.host.read("/etc/hosts") or ""
        lines = [line for line in text.splitlines() if line.split()[:1] not in (["127.0.1.1"], [address])]
        while lines and not lines[-1].strip():
            lines.pop()
        content = "".join(line + "\n" for line in lines) + "%s\t%s %s\n" % (address, fqdn, short)
        if content != text:
            self.runner.write_file(self.host.path("/etc/hosts"), content)

    def _krb5(self):
        path = self.host.path("/etc/krb5.conf")
        if os.path.islink(path) and os.readlink(path) == SAMBA_KRB5:
            return
        if self.host.exists("/etc/krb5.conf"):
            self._rename("/etc/krb5.conf", self._free_name("/etc/krb5.conf.dist"))
        self.runner.record("link /etc/krb5.conf to %s" % SAMBA_KRB5)
        if not self.runner.check:
            os.symlink(SAMBA_KRB5, path)

    def _nsswitch(self):
        text = self.host.read("/etc/nsswitch.conf")
        if text is None:
            return
        out = []
        for line in text.splitlines():
            key = line.split(":", 1)[0].strip()
            if key in ("passwd", "group") and ":" in line and "winbind" not in line.split(":", 1)[1].split():
                line = line.rstrip() + " winbind"
            out.append(line)
        content = "\n".join(out) + "\n"
        if content != text:
            self.runner.write_file(self.host.path("/etc/nsswitch.conf"), content)

    def _chrony(self, host):
        """Signed time for the domain's computers: chrony asks Samba to sign
        its answers through ntp_signd, and serves the DC's subnet."""
        if not self.host.exists("/usr/sbin/chronyd"):
            return
        subnet = ipaddress.ip_network("%s/%s" % (host["address"], host["prefix_length"]), strict=False)
        content = ("# Written by addcctl domain provision: signed time for the domain's computers\n"
                   "ntpsigndsocket %s\nallow %s\n" % (NTP_SIGND, subnet))
        if self.host.read(CHRONY_CONF) != content:
            if not self.runner.check:
                os.makedirs(os.path.dirname(self.host.path(CHRONY_CONF)), exist_ok=True)
            self.runner.write_file(self.host.path(CHRONY_CONF), content)
        self.runner.record("mkdir -m 0750 %s, group _chrony" % NTP_SIGND)
        if not self.runner.check:
            self.host.private_dir(NTP_SIGND, "_chrony", 0o750)
        self.runner.change(["systemctl", "restart", "chrony"])

    def _start(self):
        # systemd-resolved's stub holds port 53, which Samba's DNS needs
        if self.host.active("systemd-resolved"):
            self.runner.change(["systemctl", "disable", "--now", "systemd-resolved"])
        self.runner.change(["systemctl", "unmask", "samba-ad-dc"])
        self.runner.change(["systemctl", "enable", "--now", "samba-ad-dc"])

    def _wait_dns(self, fqdn):
        self.runner.record("wait until the DNS of the domain answers for %s" % fqdn)
        if self.runner.check:
            return
        deadline = self.clock() + DNS_WAIT_SECONDS
        while not self.host.dns_answers(fqdn):
            if self.clock() > deadline:
                raise AddcError("no answer for %s from 127.0.0.1 after %d s (journalctl -u samba-ad-dc)"
                                % (fqdn, DNS_WAIT_SECONDS))
            self.sleep(2)

    def _resolv(self, realm):
        content = "search %s\nnameserver 127.0.0.1\n" % realm
        path = self.host.path("/etc/resolv.conf")
        if os.path.islink(path):
            self.runner.record("remove the link /etc/resolv.conf -> %s" % os.readlink(path))
            if not self.runner.check:
                os.unlink(path)
        elif self.host.read("/etc/resolv.conf") == content:
            return
        self.runner.write_file(path, content)


# -- the values of the form (the page checks them too: validators.ts)

def host_name_violation(name):
    if not name or name.lower() == "localhost":
        return 'The host name is "%s": a domain controller needs a name of its own' % name
    if len(name) > 15:
        return 'The host name "%s" is longer than 15 characters, the limit of a NetBIOS name' % name
    if not _LABEL.match(name.lower()) or name.isdigit():
        return ('The host name "%s" must be letters, digits and hyphens, not only digits, '
                'and must not start or end with a hyphen' % name)
    return None


def realm_violation(realm, host_name):
    labels = realm.split(".")
    if len(realm) > 253 or len(labels) < 2 or not all(_LABEL.match(label) for label in labels):
        return ('The domain "%s" must be a DNS name of two or more parts (e.g. school.example.org): letters, '
                'digits and hyphens' % realm)
    if labels[-1].isdigit():
        return 'The domain "%s" must not end with a number' % realm
    if realm == (host_name or "").lower():
        return 'The domain "%s" must not be the host name' % realm
    return None


def netbios_violation(name, host_name):
    if not _NETBIOS.match(name) or name.isdigit():
        return ('The NetBIOS domain name "%s" must be 1 to 15 letters, digits and hyphens, not only digits, '
                'and must not start or end with a hyphen' % name)
    if name == (host_name or "").upper():
        return 'The NetBIOS domain name "%s" must not be the host name' % name
    return None


def forwarder_violation(address, own):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return 'The DNS forwarder "%s" is not an IP address' % address
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast or address == own:
        return ('The DNS forwarder %s must be another DNS server (the router\'s, the provider\'s): the domain '
                'controller asks it the names outside the domain' % address)
    return None


def password_violation(password):
    if len(password) < MIN_PASSWORD:
        return "The administrator's password must be at least %d characters" % MIN_PASSWORD
    if "administrator" in password.lower():
        return "The administrator's password must not contain the account name"
    try:
        import samba
    except ImportError:  # tests
        return None
    if not samba.check_password_quality(password):
        return ("The administrator's password must mix three of: lower-case letters, upper-case letters, "
                "digits, other characters")
    return None


# -- Samba

def _message(e):
    args = getattr(e, "args", ())
    return str(args[1] if len(args) > 1 else e).strip() or e.__class__.__name__


@contextlib.contextmanager
def _output_to(path):
    """What Samba prints (stdout, stderr, its logger) goes to path, root's
    only: stdout carries addcctl's answer, stderr its error message."""
    sys.stdout.flush()
    sys.stderr.flush()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    saved = os.dup(1), os.dup(2)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    try:
        yield
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(saved[0], 1)
        os.dup2(saved[1], 2)
        for f in (fd,) + saved:
            os.close(f)


def samba_provision(realm, domain, hostname, hostip, dns_forwarder, adminpass):
    """What samba-tool domain provision --server-role=dc --use-rfc2307
    --dns-backend=SAMBA_INTERNAL --host-ip runs, with its defaults (base
    schema 2019, adprep 2016, functional level 2008 R2), plus "registry
    shares = yes" in the smb.conf it writes. smb.conf must not exist."""
    from samba import functional_level
    from samba.auth import system_session
    from samba.dsdb import DS_DOMAIN_FUNCTION_2016
    from samba.param import LoadParm
    from samba.provision import provision
    from samba.provision.common import FILL_FULL
    from samba.samdb import get_default_backend_store

    lp = LoadParm()
    lp.load_default()
    lp.set("registry shares", "yes")
    logger = logging.getLogger("addcctl.provision")
    logger.propagate = False
    logger.setLevel(logging.INFO)
    with _output_to(PROVISION_LOG):
        handler = logging.StreamHandler(os.fdopen(os.dup(2), "w"))
        logger.addHandler(handler)
        try:
            provision(logger, system_session(), smbconf=lp.configfile, targetdir=None, samdb_fill=FILL_FULL,
                      realm=realm, domain=domain, hostname=hostname, hostip=hostip, hostip6=None,
                      adminpass=adminpass, dns_backend="SAMBA_INTERNAL", dns_forwarder=dns_forwarder,
                      serverrole="dc", dom_for_fun_level=functional_level.string_to_level("2008_R2"),
                      useeadb=False, next_rid=1000, lp=lp, use_ntvfs=False, use_rfc2307=True,
                      skip_sysvolacl=False, base_schema="2019", adprep_level=DS_DOMAIN_FUNCTION_2016,
                      plaintext_secrets=False, backend_store=get_default_backend_store(), backend_store_size=None)
        finally:
            logger.removeHandler(handler)
            handler.close()


def dns_query(name, server, timeout=2.0):
    """Whether server answers an A query for name with at least one record."""
    ident = random.randrange(65536)
    question = b"".join(bytes([len(p)]) + p.encode("ascii") for p in name.rstrip(".").split(".")) + b"\0"
    packet = struct.pack(">HHHHHH", ident, 0x0100, 1, 0, 0, 0) + question + struct.pack(">HH", 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        try:
            s.sendto(packet, (server, 53))
            answer, _ = s.recvfrom(4096)
        except OSError:
            return False
    if len(answer) < 12:
        return False
    rid, flags, _, ancount = struct.unpack(">HHHH", answer[:8])
    return rid == ident and bool(flags & 0x8000) and flags & 0xF == 0 and ancount > 0
