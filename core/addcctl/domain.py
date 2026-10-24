# SPDX-License-Identifier: LGPL-2.1-or-later
"""The domain's own settings, read from its root object in sam.ldb."""
from . import ad
from .accounts import first
from .errors import AddcError

_DOMAIN_PASSWORD_COMPLEX = 0x1
# An interval that never ends, as samba-tool domain passwordsettings writes it
_NEVER_INTERVAL = -0x8000000000000000
_DAY = 86400 * 10_000_000
_MINUTE = 60 * 10_000_000
# Each setting of the policy and its attribute on the domain object; the
# schema of domain set-password-policy holds their ranges
POLICY_FIELDS = {
    "complexity": "pwdProperties",
    "min_length": "minPwdLength",
    "history_length": "pwdHistoryLength",
    "min_age_days": "minPwdAge",
    "max_age_days": "maxPwdAge",
    "lockout_threshold": "lockoutThreshold",
    "lockout_duration_minutes": "lockoutDuration",
    "lockout_window_minutes": "lockOutObservationWindow",
}


class Domain:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner

    def password_policy(self):
        """The domain password and lockout settings (what samba-tool domain
        passwordsettings show prints)."""
        r = self.dc.domain_attrs(["pwdProperties", "minPwdLength", "pwdHistoryLength", "minPwdAge",
                                  "maxPwdAge", "lockoutThreshold", "lockoutDuration",
                                  "lockOutObservationWindow"])

        def number(attr):
            try:
                return int(first(r, attr, "0"))
            except ValueError:
                return 0

        def days(attr):
            minutes = ad.interval_minutes(first(r, attr))
            return None if minutes is None else minutes // 1440

        return {
            "complexity": bool(number("pwdProperties") & _DOMAIN_PASSWORD_COMPLEX),
            "min_length": number("minPwdLength"),
            "history_length": number("pwdHistoryLength"),
            # None: never (no maximum age), as the domain stores it
            "min_age_days": days("minPwdAge") or 0,
            "max_age_days": days("maxPwdAge") or None,
            "lockout_threshold": number("lockoutThreshold"),
            "lockout_duration_minutes": ad.interval_minutes(first(r, "lockoutDuration")),
            "lockout_window_minutes": ad.interval_minutes(first(r, "lockOutObservationWindow")),
        }

    def set_password_policy(self, request):
        """Bring the domain policy to the given settings; settings left out
        keep their value. The ranges (in the schema) and checks of samba-tool
        domain passwordsettings set, plus the lockout window within the
        lockout duration. None for an interval: never."""
        before = self.password_policy()
        after = dict(before, **{k: request[k] for k in POLICY_FIELDS if k in request})
        if after["max_age_days"] is not None and after["min_age_days"] >= after["max_age_days"]:
            raise AddcError("The maximum password age (%d days) must be greater than the minimum (%d days)"
                            % (after["max_age_days"], after["min_age_days"]))
        window, duration = after["lockout_window_minutes"], after["lockout_duration_minutes"]
        if duration is not None and window is None:
            raise AddcError("The count of failed logons must start again within the lockout duration (%d minutes)"
                            % duration)
        if duration is not None and window > duration:
            raise AddcError("The lockout window (%d minutes) cannot be longer than the lockout duration (%d minutes)"
                            % (window, duration))

        changes = {}
        for key, attr in POLICY_FIELDS.items():
            if after[key] == before[key]:
                continue
            value = after[key]
            if key == "complexity":
                props = int(first(self.dc.domain_attrs(["pwdProperties"]), "pwdProperties", "0") or 0)
                changes[attr] = props | _DOMAIN_PASSWORD_COMPLEX if value else props & ~_DOMAIN_PASSWORD_COMPLEX
            elif key.endswith("_days"):
                changes[attr] = _NEVER_INTERVAL if value is None else -value * _DAY
            elif key.endswith("_minutes"):
                changes[attr] = _NEVER_INTERVAL if value is None else -value * _MINUTE
            else:
                changes[attr] = value
        if changes:
            self.dc.modify(self.dc.domain_dn, changes)
            if not self.runner.check:
                after = self.password_policy()
        return {"changed": bool(changes), "policy": after, "diff": {"before": before, "after": after}}

    # -- overview, read locally: rootDSE-like facts from sam.ldb and loadparm,
    # not samba-tool domain info (a CLDAP query that fails when Samba does
    # not listen on loopback)

    def info(self):
        dc = self.dc
        domain_dn, config_dn = dc.domain_dn, dc.config_dn
        domain = dc.domain_attrs(["msDS-Behavior-Version"])
        forest = dc.entry("CN=Partitions,%s" % config_dn, ["msDS-Behavior-Version"]) or {}
        controllers = [
            {"name": first(r, "cn"), "dns_name": first(r, "dNSHostName"), "site": _site(r["dn"][0])}
            for r in dc.search("(objectClass=server)", ["cn", "dNSHostName"], base="CN=Sites,%s" % config_dn)
        ]
        controllers.sort(key=lambda c: c["name"].lower())
        fsmo = []
        for role, dn in _fsmo_objects(domain_dn, config_dn, dc.schema_dn):
            record = dc.entry(dn, ["fSMORoleOwner"])
            if record is not None:
                owner = first(record, "fSMORoleOwner")
                fsmo.append({"role": role, "owner": _server(owner) if owner else None})
        code, processes = self.runner.diagnose(["samba-tool", "processes"])
        realm = dc.realm
        return {
            "realm": realm.upper(),
            "dns_domain": realm.lower(),
            "netbios_domain": dc.workgroup,
            "domain_dn": domain_dn,
            "server": dc.netbios_name,
            "samba_version": dc.samba_version,
            "domain_level": _level(first(domain, "msDS-Behavior-Version")),
            "forest_level": _level(first(forest, "msDS-Behavior-Version")),
            "domain_controllers": controllers,
            "fsmo": fsmo,
            "processes": processes if code == 0 else None,
        }

    # -- health checks: run on demand, report only

    def check(self, names=None):
        results = []
        for name in names or list(CHECKS):
            code, output = self.runner.diagnose(CHECKS[name])
            results.append({"name": name, "command": " ".join(CHECKS[name]), "ok": code == 0,
                            "exit_code": code, "output": _truncate(output)})
        return {"checks": results}

    def sysvol_reset(self):
        self.runner.change(["samba-tool", "ntacl", "sysvolreset"])
        return {"changed": True}


# The checks of the "Domain" tab; dbcheck never with --fix
CHECKS = {
    "dbcheck": ["samba-tool", "dbcheck", "--cross-ncs"],
    "sysvolcheck": ["samba-tool", "ntacl", "sysvolcheck"],
    "testparm": ["testparm", "-s"],
}

_MAX_OUTPUT = 64 * 1024

# msDS-Behavior-Version
_LEVELS = {0: "2000", 1: "2003 interim", 2: "2003", 3: "2008", 4: "2008 R2", 5: "2012", 6: "2012 R2", 7: "2016"}


def _level(value):
    try:
        return _LEVELS.get(int(value), value)
    except (TypeError, ValueError):
        return None


def _fsmo_objects(domain_dn, config_dn, schema_dn):
    """(role, the DN whose fSMORoleOwner holds it), as samba-tool fsmo show reads them."""
    return [
        ("schema", schema_dn),
        ("naming", "CN=Partitions,%s" % config_dn),
        ("pdc", domain_dn),
        ("rid", "CN=RID Manager$,CN=System,%s" % domain_dn),
        ("infrastructure", "CN=Infrastructure,%s" % domain_dn),
        ("domaindns", "CN=Infrastructure,DC=DomainDnsZones,%s" % domain_dn),
        ("forestdns", "CN=Infrastructure,DC=ForestDnsZones,%s" % domain_dn),
    ]


def _rdn_values(dn):
    """The values of a DN's components, unescaping only "\\,"."""
    parts, current, i = [], "", 0
    while i < len(dn):
        c = dn[i]
        if c == "\\" and i + 1 < len(dn):
            current += dn[i + 1]
            i += 2
            continue
        if c == ",":
            parts.append(current)
            current = ""
        else:
            current += c
        i += 1
    parts.append(current)
    return [p.split("=", 1)[1] if "=" in p else p for p in parts]


def _server(ntds_settings_dn):
    """CN=NTDS Settings,CN=<server>,CN=Servers,CN=<site>,... -> <server>."""
    values = _rdn_values(ntds_settings_dn)
    return values[1] if len(values) > 1 else ntds_settings_dn


def _site(server_dn):
    """CN=<server>,CN=Servers,CN=<site>,CN=Sites,... -> <site>."""
    values = _rdn_values(server_dn)
    return values[2] if len(values) > 2 else None


def _truncate(output):
    if len(output) <= _MAX_OUTPUT:
        return output
    return output[:_MAX_OUTPUT] + "\n[... %d more characters]" % (len(output) - _MAX_OUTPUT)
