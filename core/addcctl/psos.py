# SPDX-License-Identifier: LGPL-2.1-or-later
"""Fine-grained password policies: Password Settings Objects (PSOs), the
msDS-PasswordSettings objects that samba-tool domain passwordsettings pso
manages, in CN=Password Settings Container,CN=System.

A PSO applies to the users and groups listed in msDS-PSOAppliesTo; a user
gets the one of lowest precedence among those that list it or its groups
(one that lists it directly wins), which Samba computes as
msDS-ResultantPSO. Without one, the domain policy applies.
"""
from .accounts import Directory, _escape, first
from .domain import Domain, check_policy, encode_setting, read_policy
from .errors import AddcError
from .shares import check_principal_names

PSO_FIELDS = {
    "complexity": "msDS-PasswordComplexityEnabled",
    "min_length": "msDS-MinimumPasswordLength",
    "history_length": "msDS-PasswordHistoryLength",
    "min_age_days": "msDS-MinimumPasswordAge",
    "max_age_days": "msDS-MaximumPasswordAge",
    "lockout_threshold": "msDS-LockoutThreshold",
    "lockout_duration_minutes": "msDS-LockoutDuration",
    "lockout_window_minutes": "msDS-LockoutObservationWindow",
}
_PRECEDENCE = "msDS-PasswordSettingsPrecedence"
_APPLIES_TO = "msDS-PSOAppliesTo"
_ATTRS = ["cn", _PRECEDENCE, _APPLIES_TO] + list(PSO_FIELDS.values())
_PSOS = "(objectClass=msDS-PasswordSettings)"
# Users and groups, not computers
_TARGETS = "(|(objectClass=group)(&(objectClass=user)(!(objectClass=computer))))"
# Windows Server 2008: the first level that applies PSOs
_LEVEL_2008 = 3


def _check_name(name):
    if name != name.strip() or any(ord(c) < 32 for c in name):
        raise AddcError('Invalid PSO name: "%s"' % name)


def _bool(value):
    return "TRUE" if value else "FALSE"


class Psos:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner
        self.directory = Directory(dc)

    # -- reading

    def _describe(self, record):
        names = self.directory.dn_names()
        policy = read_policy(record, PSO_FIELDS, first(record, PSO_FIELDS["complexity"]).upper() == "TRUE")
        try:
            precedence = int(first(record, _PRECEDENCE, "0"))
        except ValueError:
            precedence = 0
        applies_to = sorted((self.directory.name_of(dn, names) for dn in record.get(_APPLIES_TO, [])),
                            key=str.lower)
        return dict({"name": first(record, "cn"), "precedence": precedence}, **policy, applies_to=applies_to)

    def _record(self, name):
        found = self.dc.search("(&%s(cn=%s))" % (_PSOS, _escape(name)), _ATTRS, base=self.dc.pso_container,
                               scope="one")
        return found[0] if found else None

    def _require(self, name):
        record = self._record(name)
        if record is None:
            raise AddcError('PSO "%s" not found' % name)
        return record

    def list(self):
        psos = [self._describe(r) for r in self.dc.search(_PSOS, _ATTRS, base=self.dc.pso_container, scope="one")]
        return sorted(psos, key=lambda p: (p["precedence"], p["name"].lower()))

    def get(self, name):
        return self._describe(self._require(name))

    def effective(self, user):
        """The policy that applies to a user: {pso, policy}, pso None for
        the domain's."""
        check_principal_names([user])
        found = self.dc.search("(&(objectClass=user)(!(objectClass=computer))(sAMAccountName=%s))" % _escape(user),
                               ["msDS-ResultantPSO"])
        if not found:
            raise AddcError('User "%s" not found' % user)
        dn = first(found[0], "msDS-ResultantPSO")
        record = self.dc.entry(dn, _ATTRS) if dn else None
        if record is None:
            return {"pso": None, "policy": Domain(self.dc, self.runner).password_policy()}
        pso = self._describe(record)
        return {"pso": pso["name"], "policy": {k: pso[k] for k in PSO_FIELDS}}

    # -- changes

    def _targets(self, names):
        """[(account name, DN)] of the users and groups named."""
        check_principal_names(names)
        targets = []
        for name in dict.fromkeys(names, None):
            found = self.dc.search("(&%s(sAMAccountName=%s))" % (_TARGETS, _escape(name)), ["sAMAccountName"])
            if not found:
                raise AddcError('User or group "%s" not found' % name)
            target = (first(found[0], "sAMAccountName"), first(found[0], "dn"))
            if target[1].lower() not in {dn.lower() for _, dn in targets}:
                targets.append(target)
        return targets

    def create(self, request):
        name = request["name"]
        _check_name(name)
        if self._record(name) is not None:
            raise AddcError('PSO "%s" already exists' % name)
        domain = Domain(self.dc, self.runner)
        if domain.level() < _LEVEL_2008:
            raise AddcError("Fine-grained password policies need the domain functional level 2008 or higher")
        # Settings left out: the domain's, as samba-tool does
        defaults = domain.password_policy()
        policy = {k: request[k] if k in request else defaults[k] for k in PSO_FIELDS}
        check_policy(policy)
        targets = self._targets(request.get("applies_to") or [])
        attributes = {
            "objectClass": "msDS-PasswordSettings",
            _PRECEDENCE: request["precedence"],
            # Never plaintext passwords
            "msDS-PasswordReversibleEncryptionEnabled": "FALSE",
            PSO_FIELDS["complexity"]: _bool(policy["complexity"]),
        }
        for key, attr in PSO_FIELDS.items():
            if key != "complexity":
                attributes[attr] = encode_setting(key, policy[key])
        if targets:
            attributes[_APPLIES_TO] = [dn for _, dn in targets]
        self.dc.add_entry(self.dc.pso_dn(name), attributes)
        if self.runner.check:
            pso = dict({"name": name, "precedence": request["precedence"]}, **policy,
                       applies_to=sorted((n for n, _ in targets), key=str.lower))
        else:
            pso = self.get(name)
        return {"changed": True, "pso": pso, "diff": {"before": None, "after": pso}}

    def set(self, request):
        """Bring an existing PSO to the given settings; settings left out
        keep their value."""
        record = self._require(request["name"])
        before = self._describe(record)
        after = dict(before, **{k: request[k] for k in list(PSO_FIELDS) + ["precedence"] if k in request})
        check_policy(after)
        changes = {}
        for key, attr in PSO_FIELDS.items():
            if after[key] != before[key]:
                changes[attr] = _bool(after[key]) if key == "complexity" else encode_setting(key, after[key])
        if after["precedence"] != before["precedence"]:
            changes[_PRECEDENCE] = after["precedence"]
        if "applies_to" in request:
            current = list(zip(before["applies_to"], self._sorted_dns(record)))
            wanted = self._merge(current, request["applies_to"], request.get("applies_to_mode", "replace"))
            after["applies_to"] = sorted((n for n, _ in wanted), key=str.lower)
            if {dn.lower() for _, dn in wanted} != {dn.lower() for _, dn in current}:
                changes[_APPLIES_TO] = [dn for _, dn in wanted]
        if changes:
            self.dc.modify(first(record, "dn"), changes)
            if not self.runner.check:
                after = self.get(before["name"])
        return {"changed": bool(changes), "pso": after, "diff": {"before": before, "after": after}}

    def _sorted_dns(self, record):
        """The DNs of msDS-PSOAppliesTo in the order of _describe's names."""
        names = self.directory.dn_names()
        return [dn for _, dn in sorted(((self.directory.name_of(dn, names), dn) for dn in record.get(_APPLIES_TO, [])),
                                       key=lambda pair: pair[0].lower())]

    def _merge(self, current, requested, mode):
        if mode == "remove":
            drop = {n.lower() for n in requested}
            return [(n, dn) for n, dn in current if n.lower() not in drop]
        targets = self._targets(requested)
        if mode == "append":
            known = {dn.lower() for _, dn in current}
            return current + [(n, dn) for n, dn in targets if dn.lower() not in known]
        return targets

    def delete(self, request):
        record = self._record(request["name"])
        if record is None:
            return {"changed": False, "diff": {"before": None, "after": None}}
        before = self._describe(record)
        self.dc.delete_entry(first(record, "dn"))
        return {"changed": True, "diff": {"before": before, "after": None}}
