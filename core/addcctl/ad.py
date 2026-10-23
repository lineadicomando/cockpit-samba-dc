# SPDX-License-Identifier: LGPL-2.1-or-later
"""Active Directory values: FILETIME dates, intervals, flags, group types."""
import datetime

from .errors import AddcError

# accountExpires and the like: 100 ns ticks since 1601-01-01 UTC
_EPOCH = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
NEVER = 0x7FFFFFFFFFFFFFFF

UF_ACCOUNTDISABLE = 0x2
UF_LOCKOUT = 0x10  # in msDS-User-Account-Control-Computed

# Built-in accounts: not deleted, not disabled or given an expiry by addcctl
PROTECTED_USERS = frozenset(["administrator", "krbtgt", "guest"])
# Administrator and krbtgt: their status is never changed (RIDs 500, 502)
STATUS_LOCKED_RIDS = frozenset(["500", "502"])
PROTECTED_GROUPS = frozenset([
    "administrators", "domain admins", "enterprise admins", "schema admins",
    "domain controllers", "users", "guests", "domain users",
    "domain guests", "domain computers", "dnsadmins", "dnsupdateproxy",
])

GROUP_SCOPES = {"domain": 0x4, "global": 0x2, "universal": 0x8}
_SECURITY = 0x80000000


def filetime_to_iso(raw):
    """A FILETIME as an ISO 8601 UTC instant, or None for 0, "never" or junk."""
    try:
        ticks = int(raw)
    except (TypeError, ValueError):
        return None
    if ticks <= 0 or ticks >= NEVER:
        return None
    try:
        instant = _EPOCH + datetime.timedelta(microseconds=ticks // 10)
    except OverflowError:
        return None
    if instant.year < 1970:
        return None
    return instant.strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_to_filetime(value):
    """An ISO 8601 instant (with a time zone) as a FILETIME."""
    try:
        instant = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        raise AddcError("Invalid date %r: use ISO 8601 with a time zone, e.g. 2027-07-01T00:00:00+02:00"
                        % value) from None
    if instant.tzinfo is None:
        raise AddcError("Invalid date %r: give its time zone, e.g. 2027-07-01T00:00:00+02:00" % value)
    if not 1970 <= instant.year <= 9999:
        raise AddcError("Invalid date %r: the year must be between 1970 and 9999" % value)
    delta = instant - _EPOCH
    return (delta.days * 86400 + delta.seconds) * 10_000_000 + delta.microseconds * 10


def interval_minutes(raw):
    """A domain interval (negative 100 ns ticks) in whole minutes; None for
    "never" (the most negative value) or a missing one."""
    try:
        ticks = int(raw)
    except (TypeError, ValueError):
        return None
    if ticks == -0x8000000000000000:
        return None
    return abs(ticks) // 600_000_000


def group_type(raw):
    """(scope, category) of a groupType value."""
    try:
        value = int(raw) & 0xFFFFFFFF
    except (TypeError, ValueError):
        return "global", "security"
    category = "security" if value & _SECURITY else "distribution"
    if value & 0x1:
        return "builtin", category
    for scope, bit in GROUP_SCOPES.items():
        if value & bit:
            return scope, category
    return "global", category


def group_type_value(scope, category):
    """groupType for newgroup(), as the dsdb.GTYPE_* constants (unsigned)."""
    return GROUP_SCOPES[scope] | (_SECURITY if category == "security" else 0)


def rid(sid):
    return sid.rsplit("-", 1)[-1] if sid else ""
