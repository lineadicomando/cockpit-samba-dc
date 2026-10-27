# SPDX-License-Identifier: LGPL-2.1-or-later
"""DNS zones and records of the domain, read and written in sam.ldb.

The records live in the dnsNode entries of the DNS partitions; the DC's
DNS server reads them from there, so a change is served at once. They are
written locally, as the DNS server's own RPC interface does (Dc.dns_*), so
no domain credentials and no network query (rule 5).

A record here is {name, type, value, ttl, dynamic, protected}: name relative
to the zone ("@" for the zone itself), value in samba-tool's notation
("mail.example.com 10" for MX, "target port priority weight" for SRV).
What the domain depends on is never changed: the _msdcs zone, the SOA and NS
records, the records of the AD services (_ldap, _kerberos, _gc, _kpasswd,
_sites...), the DomainDnsZones and ForestDnsZones names, the domain
controllers' own names and the addresses of the domain's name.
"""
import ipaddress
import re

from .errors import AddcError

EDITABLE = ("A", "AAAA", "CNAME", "MX", "PTR", "SRV", "TXT")
DEFAULT_TTL = 900
MAX_TTL = 2147483647
_HIDDEN_ZONES = ("rootdnsservers", "..trustanchors")
_SERVICE_LABELS = frozenset(["_ldap", "_kerberos", "_kpasswd", "_gc", "_msdcs", "_sites",
                             "domaindnszones", "forestdnszones"])
_LABEL = re.compile(r"^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$")
_MAX_NAME = 253
_MAX_TXT = 4096


def _check_host(value, what):
    """A host name: labels of letters, digits, - and _, at most 253 characters."""
    labels = value.split(".")
    if not value or len(value) > _MAX_NAME or not all(_LABEL.match(label) for label in labels):
        raise AddcError('Invalid %s: "%s"' % (what, value))


def check_record_name(name):
    """A name relative to its zone: "@", or labels, the first of which may be "*"."""
    if name == "@":
        return
    labels = name.split(".")
    if labels[0] == "*":
        labels = labels[1:]
        if not labels:
            return
    if len(name) > _MAX_NAME or not all(_LABEL.match(label) for label in labels):
        raise AddcError('Invalid DNS name: "%s"' % name)


def _number(text, what, maximum=65535):
    if not re.match(r"^[0-9]{1,10}$", text) or int(text) > maximum:
        raise AddcError("Invalid %s: %s" % (what, text))
    return int(text)


def canonical_value(rtype, value):
    """The value of a record in samba-tool's notation, checked and normalized."""
    if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise AddcError("Invalid %s value: %r" % (rtype, value))
    text = value.strip()
    if rtype == "A":
        try:
            return str(ipaddress.IPv4Address(text))
        except ValueError:
            raise AddcError("Invalid IPv4 address: %s" % text) from None
    if rtype == "AAAA":
        try:
            return str(ipaddress.IPv6Address(text))
        except ValueError:
            raise AddcError("Invalid IPv6 address: %s" % text) from None
    if rtype in ("CNAME", "PTR"):
        host = text.rstrip(".")
        _check_host(host, "host name")
        return host
    if rtype == "MX":
        parts = text.split()
        if len(parts) != 2:
            raise AddcError('Invalid MX value "%s": give "host preference", e.g. "mail.example.com 10"' % text)
        host = parts[0].rstrip(".")
        _check_host(host, "host name")
        return "%s %d" % (host, _number(parts[1], "MX preference"))
    if rtype == "SRV":
        parts = text.split()
        if len(parts) != 4:
            raise AddcError('Invalid SRV value "%s": give "target port priority weight", '
                            'e.g. "sip.example.com 5060 0 100"' % text)
        host = parts[0].rstrip(".")
        _check_host(host, "host name")
        return "%s %d %d %d" % (host, _number(parts[1], "SRV port"), _number(parts[2], "SRV priority"),
                                _number(parts[3], "SRV weight"))
    if rtype == "TXT":
        if not text or len(value.encode("utf-8")) > _MAX_TXT:
            raise AddcError("Invalid TXT value: from 1 to %d bytes" % _MAX_TXT)
        return value
    raise AddcError("Record type %s cannot be changed here: use one of %s" % (rtype, ", ".join(EDITABLE)))


def _same_value(rtype, a, b):
    if rtype == "TXT":
        return a == b
    return a.lower() == b.lower()


class Dns:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner

    # -- reading

    def zones(self):
        zones = []
        for zone in self.dc.dns_zones():
            if zone["name"].lower() in _HIDDEN_ZONES:
                continue
            zones.append({"name": zone["name"], "partition": zone["partition"],
                          "read_only": zone["name"].lower().startswith("_msdcs.")})
        return sorted(zones, key=lambda z: z["name"].lower())

    def _zone(self, name):
        wanted = (name or "").rstrip(".").lower()
        for zone in self.dc.dns_zones():
            if zone["name"].lower() == wanted and wanted not in _HIDDEN_ZONES:
                return zone
        raise AddcError('DNS zone "%s" not found' % name)

    def _relative(self, zone, name):
        """name relative to the zone: given relative, or in full (with or
        without the final dot)."""
        if not isinstance(name, str):
            raise AddcError("Invalid DNS name")
        name = name.strip()
        full = name.rstrip(".").lower()
        suffix = zone["name"].lower()
        if name.endswith(".") or full == suffix or full.endswith("." + suffix):
            if full == suffix:
                name = "@"
            elif full.endswith("." + suffix):
                name = name.rstrip(".")[:-len(suffix) - 1]
            else:
                raise AddcError('"%s" is not in the zone %s' % (name, zone["name"]))
        check_record_name(name)
        return name

    def _dc_names(self):
        return {h.lower().rstrip(".") for h in self.dc.dns_dc_hosts()}

    def protected(self, zone, name, rtype, dc_names=None):
        """Whether a record is one the domain depends on: never changed."""
        if rtype not in EDITABLE or zone["name"].lower().startswith("_msdcs."):
            return True
        labels = name.lower().split(".")
        if any(label in _SERVICE_LABELS for label in labels):
            return True
        full = zone["name"].lower() if name == "@" else "%s.%s" % (name.lower(), zone["name"].lower())
        if name == "@" and rtype in ("A", "AAAA") and full == self.dc.dns_domain.lower():
            return True
        names = self._dc_names() if dc_names is None else dc_names
        return full in names

    def _describe(self, zone, name, record, dc_names):
        return {"name": name, "type": record["type"], "value": record["value"], "ttl": record["ttl"],
                "dynamic": record["timestamp"] != 0,
                "protected": self.protected(zone, name, record["type"], dc_names)}

    def _sort(self, records):
        return sorted(records, key=lambda r: (r["name"] != "@", r["name"].lower(), r["type"], r["value"].lower()))

    def records(self, zone_name, name=None):
        zone = self._zone(zone_name)
        dc_names = self._dc_names()
        wanted = self._relative(zone, name) if name else None
        out = []
        for node in self.dc.dns_nodes(zone):
            if node["tombstoned"] or (wanted is not None and node["name"].lower() != wanted.lower()):
                continue
            out.extend(self._describe(zone, node["name"], r, dc_names) for r in node["records"])
        return self._sort(out)

    def _node(self, zone, name):
        for node in self.dc.dns_nodes(zone, name):
            if node["name"].lower() == name.lower():
                return node
        return None

    # -- changes

    def _request(self, request):
        zone = self._zone(request["zone"])
        if zone["name"].lower().startswith("_msdcs."):
            raise AddcError("The zone %s belongs to the domain and cannot be changed" % zone["name"])
        name = self._relative(zone, request["name"])
        rtype = request["type"].upper()
        if rtype not in EDITABLE:
            raise AddcError("Record type %s cannot be changed here: use one of %s" % (rtype, ", ".join(EDITABLE)))
        if self.protected(zone, name, rtype):
            shown = zone["name"] if name == "@" else "%s.%s" % (name, zone["name"])
            raise AddcError("The %s records of %s belong to the domain and cannot be changed" % (rtype, shown))
        node = self._node(zone, name)
        current = [] if node is None or node["tombstoned"] else node["records"]
        return zone, name, rtype, node, current

    def _result(self, zone, name, before, after, changed):
        dc_names = self._dc_names()
        describe = lambda records: self._sort([self._describe(zone, name, r, dc_names) for r in records])
        b, a = describe(before), describe(after)
        return {"changed": changed, "records": a, "diff": {"before": b, "after": a}}

    def set(self, request):
        """The records of one type at one name become exactly the values given."""
        zone, name, rtype, node, current = self._request(request)
        values = []
        for value in request["values"]:
            value = canonical_value(rtype, value)
            if not any(_same_value(rtype, value, v) for v in values):
                values.append(value)
        if not values:
            raise AddcError("Give at least one value, or delete the records")
        others = [r for r in current if r["type"] != rtype]
        same = [r for r in current if r["type"] == rtype]
        if rtype == "CNAME" and len(values) > 1:
            raise AddcError("A name has at most one CNAME record")
        if rtype == "CNAME" and others:
            raise AddcError("%s has other records: a CNAME cannot be added next to them" % request["name"])
        if rtype != "CNAME" and any(r["type"] == "CNAME" for r in others):
            raise AddcError("%s is an alias (CNAME): it cannot have other records" % request["name"])
        ttl = request.get("ttl", same[0]["ttl"] if same else DEFAULT_TTL)
        kept, added = [], []
        for value in values:
            match = next((r for r in same if _same_value(rtype, r["value"], value)
                          and r["ttl"] == ttl and r["timestamp"] == 0), None)
            if match is not None:
                kept.append(match)
            else:
                added.append({"type": rtype, "value": value, "ttl": ttl, "timestamp": 0})
        if not added and len(kept) == len(same):
            return self._result(zone, name, current, current, False)
        after = others + kept + added
        self.dc.dns_write(zone, name, node, after)
        return self._result(zone, name, current, after, True)

    def delete(self, request):
        """Delete the records of one type at one name: those with the values
        given, or all of them."""
        zone, name, rtype, node, current = self._request(request)
        values = [canonical_value(rtype, v) for v in request.get("values") or []]
        gone = [r for r in current if r["type"] == rtype
                and (not values or any(_same_value(rtype, r["value"], v) for v in values))]
        if not gone:
            return self._result(zone, name, current, current, False)
        after = [r for r in current if r not in gone]
        self.dc.dns_write(zone, name, node, after)
        return self._result(zone, name, current, after, True)
