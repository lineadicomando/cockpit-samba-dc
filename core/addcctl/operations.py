# SPDX-License-Identifier: LGPL-2.1-or-later
"""The operations of addcctl, each with the JSON Schema of its input.

The schemas are the contract: the command validates every input against
them, and they generate the TypeScript types, the Ansible argument specs and
the MCP tools (docs/architecture.md, "The core"). A `default` is what the
operation does when the setting is left out; the validator ignores it.
"""
from .accounts import Computers, Groups, Users
from .backups import BACKUP_DIR, Backups
from .dns import EDITABLE as _DNS_EDITABLE, Dns
from .domain import CHECKS, Domain
from .gpos import Gpos
from .homes import Homes
from .ous import Ous
from .psos import Psos
from .setup import Setup
from .shares import Shares

_NAME = {"type": "string", "minLength": 1, "maxLength": 256}
_SHARE_NAME = {"type": "string", "minLength": 1, "maxLength": 80,
               "description": "Share name; also the folder under /srv/samba/shares"}
_ACCESS_ENTRY = {
    "type": "object",
    "properties": {
        "name": dict(_NAME, description="sAMAccountName of the user or group"),
        "kind": {"type": "string", "enum": ["user", "group"],
                 "description": "Read from the directory when left out; when given, it must match"},
        "level": {"type": "string", "enum": ["read", "write"], "default": "read",
                  "description": "read for read-only access, write for read-write"},
    },
    "required": ["name"],
    "additionalProperties": False,
}
_DRIVE = {
    "type": ["object", "null"],
    "properties": {
        "letter": {"type": "string", "minLength": 1, "maxLength": 2,
                   "description": "E-Z except H; a trailing colon is accepted"},
        "label": {"type": "string", "maxLength": 256, "description": "Default: the current label, or the share name"},
    },
    "required": ["letter"],
    "additionalProperties": False,
    "description": "Network drive mapped at logon for the share's users and groups; null removes the mapping",
}


_ACCOUNT = {"type": "string", "minLength": 1, "maxLength": 20,
            "description": "sAMAccountName of the user"}
_GROUP = {"type": "string", "minLength": 1, "maxLength": 256, "description": "sAMAccountName of the group"}
_PASSWORD = {"type": "string", "minLength": 1, "maxLength": 512, "writeOnly": True,
             "description": "The password; a secret, never returned"}
_TEXT = {"type": "string", "maxLength": 1024}
_EXPIRES = {"type": ["string", "null"], "maxLength": 64,
            "description": ("When the account stops working, ISO 8601 with a time zone "
                            "(e.g. 2027-07-01T00:00:00+02:00); null: never")}
_USER_FIELDS = {
    "given_name": dict(_TEXT, description="Given name"),
    "surname": dict(_TEXT, description="Surname"),
    "email": dict(_TEXT, description="E-mail address; empty removes it"),
    "description": dict(_TEXT, description="Description; empty removes it"),
    "title": dict(_TEXT, description="Job title; empty removes it"),
    "department": dict(_TEXT, description="Department; empty removes it"),
    "company": dict(_TEXT, description="Company; empty removes it"),
}
_OU = {"type": "string", "minLength": 1, "maxLength": 1024,
       "description": "DN of an OU or a default container, relative to the domain (e.g. OU=Students,OU=School)"}
_MOVE_TO = dict(_OU, description=("Container to move it to: an OU or a default container (CN=Users, "
                                  "CN=Computers), relative to the domain"))
_NAME_ONLY = lambda d, desc: {"type": "object", "properties": {"name": dict(d, description=desc)},
                              "required": ["name"], "additionalProperties": False}
_NONE = {"type": "object", "properties": {}, "additionalProperties": False}
_DNS_ZONE = {"type": "string", "minLength": 1, "maxLength": 253, "description": "DNS zone, e.g. example.internal"}
_DNS_NAME = {"type": "string", "minLength": 1, "maxLength": 253,
             "description": ("Name relative to the zone (www, @ for the zone itself, *.dev for a wildcard), "
                             "or in full")}
_DNS_TYPE = {"type": "string", "enum": list(_DNS_EDITABLE), "description": "Record type"}
_DNS_VALUE = {"type": "string", "minLength": 1, "maxLength": 4096,
              "description": ("A record value: an address (A, AAAA), a host name (CNAME, PTR), "
                              "\"host preference\" (MX), \"target port priority weight\" (SRV), text (TXT)")}


_GPO = {"type": "string", "minLength": 1, "maxLength": 256,
        "description": "The GPO: its GUID ({31B2F340-...}) or its display name"}
_GPO_CONTAINER = {"type": "string", "maxLength": 1024, "default": "",
                  "description": ("Where the link is: an OU, relative to the domain (e.g. OU=Students,OU=School), "
                                  "or empty for the domain itself")}


def _gpos(ctx):
    return Gpos(ctx.dc, ctx.runner, Ous(ctx.dc, ctx.runner))


def _policy_settings(max_length, max_history):
    """The settings of a password policy: the domain's (samba-tool's ranges) or a PSO's."""
    return {
        "complexity": {"type": "boolean",
                       "description": "Passwords must mix character classes and avoid the account name"},
        "min_length": {"type": "integer", "minimum": 0, "maximum": max_length,
                       "description": "Minimum password length, from 0 to %d" % max_length},
        "history_length": {"type": "integer", "minimum": 0, "maximum": max_history,
                           "description": "Earlier passwords that cannot be used again, from 0 to %d" % max_history},
        "min_age_days": {"type": "integer", "minimum": 0, "maximum": 998,
                         "description": "Days before a password can be changed again, from 0 to 998"},
        "max_age_days": {"type": ["integer", "null"], "minimum": 1, "maximum": 999,
                         "description": "Days after which a password expires, from 1 to 999; null: never"},
        "lockout_threshold": {"type": "integer", "minimum": 0, "maximum": 999,
                              "description": "Failed logons that lock the account, from 0 to 999; 0: never locked"},
        "lockout_duration_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 99999,
                                     "description": ("Minutes an account stays locked, from 1 to 99999; "
                                                     "null: until an administrator unlocks it")},
        "lockout_window_minutes": {"type": ["integer", "null"], "minimum": 1, "maximum": 99999,
                                   "description": ("Minutes after which the count of failed logons "
                                                   "starts again, from 1 to 99999 and at most the lockout "
                                                   "duration; null: never")},
    }


_PSO_NAME = {"type": "string", "minLength": 1, "maxLength": 64, "description": "Name of the PSO"}
_PRECEDENCE = {"type": "integer", "minimum": 1, "maximum": 2147483647,
               "description": "Among the PSOs that apply to a user, the lowest precedence wins"}
_APPLIES_TO = {"type": "array", "items": dict(_NAME, description="sAMAccountName of a user or group"),
               "description": ("Users and groups it applies to (a group: its members); "
                               "one that names a user directly wins over its groups'")}


def _shares(ctx):
    return Shares(ctx.dc, ctx.runner)


def _users(ctx):
    return Users(ctx.dc, ctx.runner)


def _groups(ctx):
    return Groups(ctx.dc, ctx.runner)


def _computers(ctx):
    return Computers(ctx.dc, ctx.runner)


OPERATIONS = {
    # -- users
    ("user", "list"): {
        "description": "List the domain users, with their groups, status, lockout, expiry and container",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"users": _users(ctx).list()},
    },
    ("user", "get"): {
        "description": "One domain user, with the password policy that applies to it (a PSO's, or the domain's)",
        "mutates": False, "input": _NAME_ONLY(_ACCOUNT, "sAMAccountName of the user"),
        "run": lambda ctx, req: {"user": _users(ctx).get(req["name"]),
                                 "password_policy": Psos(ctx.dc, ctx.runner).effective(req["name"])},
    },
    ("user", "create"): {
        "description": "Create a domain user",
        "mutates": True,
        "input": {
            "type": "object",
            "properties": dict(_USER_FIELDS, **{
                "name": _ACCOUNT,
                "password": _PASSWORD,
                "must_change_password": {"type": "boolean", "default": False,
                                         "description": "Change it at the next logon"},
                "ou": dict(_OU, description="Container to create it in, relative to the domain (e.g. OU=Students); default CN=Users"),
                "groups": {"type": "array", "items": _GROUP, "description": "Groups to add it to"},
            }),
            "required": ["name", "password"], "additionalProperties": False,
        },
        "run": lambda ctx, req: _users(ctx).create(req),
    },
    ("user", "set"): {
        "description": ("Bring a user to the given settings; settings left out keep their value. "
                        "A new name also renames it in the shared folders"),
        "mutates": True,
        "input": {
            "type": "object",
            "properties": dict(_USER_FIELDS, **{
                "name": _ACCOUNT,
                "new_name": dict(_ACCOUNT, description="New sAMAccountName"),
                "enabled": {"type": "boolean", "description": "Whether the account can log on"},
                "expires": _EXPIRES,
                "groups": {"type": "array", "items": _GROUP,
                           "description": "Groups it belongs to, the primary group aside"},
                "groups_mode": {"type": "string", "enum": ["replace", "append", "remove"], "default": "replace",
                                "description": "replace makes groups the whole list, append adds them, remove drops them"},
                "primary_group": dict(_GROUP, description="Primary group, one the user belongs to"),
                "ou": _MOVE_TO,
            }),
            "required": ["name"], "additionalProperties": False,
        },
        "run": lambda ctx, req: _users(ctx).set(req),
    },
    ("user", "password"): {
        "description": "Set a user's password",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": _ACCOUNT, "password": _PASSWORD,
            "must_change": {"type": "boolean", "default": False, "description": "Change it at the next logon"},
        }, "required": ["name", "password"], "additionalProperties": False},
        "run": lambda ctx, req: _users(ctx).password(req),
    },
    ("user", "unlock"): {
        "description": "Unlock a user locked out after failed logons",
        "mutates": True, "input": _NAME_ONLY(_ACCOUNT, "sAMAccountName of the user"),
        "run": lambda ctx, req: _users(ctx).unlock(req),
    },
    ("user", "delete"): {
        "description": ("Delete a domain user (not the built-in ones); shared folders keep listing it: "
                        "shares names the ones that do"),
        "mutates": True, "input": _NAME_ONLY(_ACCOUNT, "sAMAccountName of the user"),
        "run": lambda ctx, req: _users(ctx).delete(req),
    },
    # -- groups
    ("group", "list"): {
        "description": "List the groups, with their members and container",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"groups": _groups(ctx).list()},
    },
    ("group", "get"): {
        "description": "One group",
        "mutates": False, "input": _NAME_ONLY(_GROUP, "sAMAccountName of the group"),
        "run": lambda ctx, req: {"group": _groups(ctx).get(req["name"])},
    },
    ("group", "create"): {
        "description": "Create a group",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": _GROUP,
            "description": dict(_TEXT, description="Description"),
            "email": dict(_TEXT, description="E-mail address"),
            "scope": {"type": "string", "enum": ["domain", "global", "universal"], "description": "Default: global"},
            "category": {"type": "string", "enum": ["security", "distribution"], "description": "Default: security"},
            "members": {"type": "array", "items": _GROUP, "description": "Users, computers (name$) or groups"},
            "ou": dict(_OU, description="Container to create it in, relative to the domain; default CN=Users"),
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: _groups(ctx).create(req),
    },
    ("group", "set"): {
        "description": ("Bring a group to the given settings; settings left out keep their value. "
                        "A new name also renames it in the shared folders"),
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": _GROUP,
            "new_name": dict(_GROUP, description="New sAMAccountName"),
            "description": dict(_TEXT, description="Description; empty removes it"),
            "email": dict(_TEXT, description="E-mail address; empty removes it"),
            "members": {"type": "array", "items": _GROUP, "description": "Users, computers (name$) or groups"},
            "members_mode": {"type": "string", "enum": ["replace", "append", "remove"], "default": "replace",
                             "description": "replace makes members the whole list, append adds them, remove drops them"},
            "ou": _MOVE_TO,
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: _groups(ctx).set(req),
    },
    ("group", "delete"): {
        "description": ("Delete a group (not the built-in ones); shared folders keep listing it: "
                        "shares names the ones that do"),
        "mutates": True, "input": _NAME_ONLY(_GROUP, "sAMAccountName of the group"),
        "run": lambda ctx, req: _groups(ctx).delete(req),
    },
    # -- computers
    ("computer", "list"): {
        "description": "List the computer accounts, with their container",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"computers": _computers(ctx).list()},
    },
    ("computer", "get"): {
        "description": "One computer account",
        "mutates": False, "input": _NAME_ONLY(_ACCOUNT, "Computer name, with or without the trailing $"),
        "run": lambda ctx, req: {"computer": _computers(ctx).get(req["name"])},
    },
    ("computer", "create"): {
        "description": "Create a computer account before the computer joins",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": dict(_ACCOUNT, maxLength=15,
                         description=("Computer name, without the trailing $: up to 15 letters, digits and "
                                      "hyphens, not only digits")),
            "ou": dict(_OU, description="Container, relative to the domain; default CN=Computers"),
            "description": dict(_TEXT, description="Description"),
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: _computers(ctx).create(req),
    },
    ("computer", "set"): {
        "description": "Bring a computer account to the given settings; settings left out keep their value",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": dict(_ACCOUNT, description="Computer name, with or without the trailing $"),
            "description": dict(_TEXT, description="Description; empty removes it"),
            "ou": _MOVE_TO,
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: _computers(ctx).set(req),
    },
    ("computer", "delete"): {
        "description": "Delete a computer account and its DNS records (not a domain controller)",
        "mutates": True, "input": _NAME_ONLY(_ACCOUNT, "Computer name, with or without the trailing $"),
        "run": lambda ctx, req: _computers(ctx).delete(req),
    },
    # -- organizational units
    ("ou", "list"): {
        "description": ("List the organizational units and the default containers (CN=Users, CN=Computers), "
                        "parents first"),
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"ous": Ous(ctx.dc, ctx.runner).list()},
    },
    ("ou", "get"): {
        "description": "One organizational unit or default container",
        "mutates": False, "input": {"type": "object", "properties": {"dn": _OU}, "required": ["dn"],
                                    "additionalProperties": False},
        "run": lambda ctx, req: {"ou": Ous(ctx.dc, ctx.runner).get(req["dn"])},
    },
    ("ou", "create"): {
        "description": "Create an organizational unit",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": {"type": "string", "minLength": 1, "maxLength": 64, "description": "Name of the OU"},
            "parent": {"type": "string", "maxLength": 1024, "default": "",
                       "description": "OU to create it in, relative to the domain; empty: the domain itself"},
            "description": dict(_TEXT, description="Description"),
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: Ous(ctx.dc, ctx.runner).create(req),
    },
    ("ou", "set"): {
        "description": ("Rename, move or describe an organizational unit, with everything in it; "
                        "settings left out keep their value. The default containers are never renamed or moved"),
        "mutates": True,
        "input": {"type": "object", "properties": {
            "dn": _OU,
            "new_name": {"type": "string", "minLength": 1, "maxLength": 64, "description": "New name"},
            "parent": {"type": "string", "maxLength": 1024,
                       "description": "OU to move it to, relative to the domain; empty: the domain itself"},
            "description": dict(_TEXT, description="Description; empty removes it"),
        }, "required": ["dn"], "additionalProperties": False},
        "run": lambda ctx, req: Ous(ctx.dc, ctx.runner).set(req),
    },
    ("ou", "delete"): {
        "description": ("Delete an organizational unit (not a default container). One with objects in it only "
                        "with recursive, which deletes them too: their home directories and their entries "
                        "in shared folders stay"),
        "mutates": True,
        "input": {"type": "object", "properties": {
            "dn": _OU,
            "recursive": {"type": "boolean", "default": False,
                          "description": "Also delete everything in it (never built-in objects or domain controllers)"},
        }, "required": ["dn"], "additionalProperties": False},
        "run": lambda ctx, req: Ous(ctx.dc, ctx.runner).delete(req),
    },
    # -- DNS
    ("dns", "zones"): {
        "description": "List the DNS zones of the domain (_msdcs is read-only)",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"zones": Dns(ctx.dc, ctx.runner).zones()},
    },
    ("dns", "list"): {
        "description": ("List the DNS records of a zone, or of one name in it; protected records are those "
                        "the domain depends on, never changed"),
        "mutates": False,
        "input": {"type": "object", "properties": {
            "zone": _DNS_ZONE,
            "name": dict(_DNS_NAME, description="Only the records of this name, relative to the zone or in full"),
        }, "required": ["zone"], "additionalProperties": False},
        "run": lambda ctx, req: {"records": Dns(ctx.dc, ctx.runner).records(req["zone"], req.get("name"))},
    },
    ("dns", "set"): {
        "description": ("Make the records of one type at one name exactly the values given (static records); "
                        "the other types at that name are left alone"),
        "mutates": True,
        "input": {"type": "object", "properties": {
            "zone": _DNS_ZONE, "name": _DNS_NAME, "type": _DNS_TYPE,
            "values": {"type": "array", "minItems": 1, "maxItems": 64, "items": _DNS_VALUE,
                       "description": "The values, in samba-tool's notation (see value)"},
            "ttl": {"type": "integer", "minimum": 0, "maximum": 2147483647,
                    "description": "Time to live in seconds; default the current one, or 900"},
        }, "required": ["zone", "name", "type", "values"], "additionalProperties": False},
        "run": lambda ctx, req: Dns(ctx.dc, ctx.runner).set(req),
    },
    ("dns", "delete"): {
        "description": "Delete the records of one type at one name: those with the values given, or all of them",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "zone": _DNS_ZONE, "name": _DNS_NAME, "type": _DNS_TYPE,
            "values": {"type": "array", "maxItems": 64, "items": _DNS_VALUE,
                       "description": "Only the records with these values; default all of that type"},
        }, "required": ["zone", "name", "type"], "additionalProperties": False},
        "run": lambda ctx, req: Dns(ctx.dc, ctx.runner).delete(req),
    },
    # -- Group Policy
    ("gpo", "list"): {
        "description": "List the Group Policy objects, with where each is linked",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"gpos": _gpos(ctx).list()},
    },
    ("gpo", "get"): {
        "description": "One Group Policy object, with where it is linked",
        "mutates": False, "input": {"type": "object", "properties": {"gpo": _GPO}, "required": ["gpo"],
                                    "additionalProperties": False},
        "run": lambda ctx, req: {"gpo": _gpos(ctx).get(req["gpo"])},
    },
    ("gpo", "link"): {
        "description": ("Link a GPO to the domain or an OU, or change the flags of its link there; flags left out "
                        "keep their value (false for a new link). A new link has the lowest precedence"),
        "mutates": True,
        "input": {"type": "object", "properties": {
            "gpo": _GPO, "container": _GPO_CONTAINER,
            "enforced": {"type": "boolean", "description": "Enforced: applies even where inheritance is blocked"},
            "disabled": {"type": "boolean", "description": "Disabled: the link stays but does not apply"},
        }, "required": ["gpo"], "additionalProperties": False},
        "run": lambda ctx, req: _gpos(ctx).link(req),
    },
    ("gpo", "unlink"): {
        "description": ("Remove the link of a GPO from the domain or an OU; the default GPOs and the drive-mapping "
                        "GPO stay linked where they are"),
        "mutates": True,
        "input": {"type": "object", "properties": {"gpo": _GPO, "container": _GPO_CONTAINER},
                  "required": ["gpo"], "additionalProperties": False},
        "run": lambda ctx, req: _gpos(ctx).unlink(req),
    },
    # -- home directories
    ("home", "provision"): {
        "description": ("Create a user's home directory under /srv/samba/home, map it at logon "
                        "(homeDrive, homeDirectory) and make sure the home share serves it"),
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": _ACCOUNT,
            "drive": {"type": "string", "minLength": 2, "maxLength": 2, "default": "H:",
                      "description": "Drive letter of the home directory, with its colon"},
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: Homes(ctx.dc, ctx.runner).provision(req),
    },
    ("home", "delete"): {
        "description": "Clear a user's home drive; with delete_data, also remove its folder",
        "mutates": True,
        "input": {"type": "object", "properties": {
            "name": _ACCOUNT,
            "delete_data": {"type": "boolean", "default": False,
                            "description": "Remove /srv/samba/home/<name> and its contents"},
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: Homes(ctx.dc, ctx.runner).delete(req),
    },
    # -- domain
    ("domain", "password-policy"): {
        "description": "The domain password and lockout settings",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"policy": Domain(ctx.dc, ctx.runner).password_policy()},
    },
    ("domain", "set-password-policy"): {
        "description": ("Bring the domain password and lockout settings to the given values; "
                        "settings left out keep their value"),
        "mutates": True,
        "input": {"type": "object", "properties": _policy_settings(14, 24), "additionalProperties": False},
        "run": lambda ctx, req: Domain(ctx.dc, ctx.runner).set_password_policy(req),
    },
    # -- fine-grained password policies
    ("pso", "list"): {
        "description": "List the fine-grained password policies (PSOs), lowest precedence first",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"psos": Psos(ctx.dc, ctx.runner).list()},
    },
    ("pso", "get"): {
        "description": "One fine-grained password policy (PSO)",
        "mutates": False, "input": _NAME_ONLY(_PSO_NAME, "Name of the PSO"),
        "run": lambda ctx, req: {"pso": Psos(ctx.dc, ctx.runner).get(req["name"])},
    },
    ("pso", "create"): {
        "description": ("Create a fine-grained password policy (PSO); settings left out take the "
                        "domain's. Needs the domain functional level 2008 or higher"),
        "mutates": True,
        "input": {"type": "object", "properties": dict(_policy_settings(255, 1024), **{
            "name": _PSO_NAME, "precedence": _PRECEDENCE, "applies_to": _APPLIES_TO,
        }), "required": ["name", "precedence"], "additionalProperties": False},
        "run": lambda ctx, req: Psos(ctx.dc, ctx.runner).create(req),
    },
    ("pso", "set"): {
        "description": "Bring a PSO to the given settings; settings left out keep their value",
        "mutates": True,
        "input": {"type": "object", "properties": dict(_policy_settings(255, 1024), **{
            "name": _PSO_NAME, "precedence": _PRECEDENCE, "applies_to": _APPLIES_TO,
            "applies_to_mode": {"type": "string", "enum": ["replace", "append", "remove"], "default": "replace",
                                "description": ("replace: applies_to is the whole list; append: add these; "
                                                "remove: drop these")},
        }), "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: Psos(ctx.dc, ctx.runner).set(req),
    },
    ("pso", "delete"): {
        "description": "Delete a PSO: its users get the next one, or the domain policy",
        "mutates": True, "input": _NAME_ONLY(_PSO_NAME, "Name of the PSO"),
        "run": lambda ctx, req: Psos(ctx.dc, ctx.runner).delete(req),
    },
    ("domain", "info"): {
        "description": ("The domain and its controllers: names, Samba version, functional levels, "
                        "FSMO role owners, the processes of this DC; read locally"),
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"domain": Domain(ctx.dc, ctx.runner).info()},
    },
    ("domain", "check"): {
        "description": ("Run health checks on demand and report their output: samba-tool dbcheck "
                        "(report only, nothing fixed), samba-tool ntacl sysvolcheck, testparm -s"),
        "mutates": False,
        "input": {"type": "object", "properties": {
            "checks": {"type": "array", "items": {"type": "string", "enum": list(CHECKS)},
                       "description": "The checks to run; default all"},
        }, "additionalProperties": False},
        "run": lambda ctx, req: Domain(ctx.dc, ctx.runner).check(req.get("checks")),
    },
    ("domain", "sysvol-reset"): {
        "description": "Reset the ACLs of sysvol (samba-tool ntacl sysvolreset), when sysvolcheck reports a mismatch",
        "mutates": True, "input": _NONE,
        "run": lambda ctx, req: Domain(ctx.dc, ctx.runner).sysvol_reset(),
    },
    ("domain", "setup-check"): {
        "description": ("Whether this host is a domain controller already and, when it is not, the prerequisites "
                        "of a new domain (static address, host name, free ports, time, disk), each with its "
                        "state (ok, warning, error), a code with its params, a message and what to do, and the "
                        "values proposed for it"),
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: Setup(ctx.runner).check(),
    },
    ("domain", "provision"): {
        "description": ("Provision a new domain (a new forest with this host as its only domain controller), "
                        "refused when a domain exists or a prerequisite of domain setup-check fails: smbd, nmbd "
                        "and winbind stopped and masked, Debian's smb.conf kept as smb.conf.dist, the domain "
                        "provisioned with registry shares, /etc/hosts, /etc/krb5.conf, nsswitch.conf and chrony "
                        "set up, samba-ad-dc started, the host resolving through it. Not served by addcctl mcp"),
        "mutates": True,
        # Once only, and destructive if misused: not an MCP tool
        "mcp": False,
        "input": {"type": "object", "properties": {
            "realm": {"type": "string", "minLength": 1, "maxLength": 253,
                      "description": "DNS name of the domain, e.g. school.example.org; also the Kerberos realm"},
            "netbios_domain": {"type": "string", "minLength": 1, "maxLength": 15,
                               "description": "NetBIOS name of the domain (pre-Windows 2000), e.g. SCHOOL"},
            "admin_password": dict(_PASSWORD, description=("Password of the domain's Administrator: at least 7 "
                                                           "characters, three of lower-case, upper-case, digits "
                                                           "and other characters; a secret, never returned")),
            "dns_forwarder": {"type": "string", "minLength": 1, "maxLength": 64,
                              "description": ("IP address of the DNS server that answers for the names outside "
                                              "the domain (the router's, the provider's)")},
        }, "required": ["realm", "netbios_domain", "admin_password", "dns_forwarder"],
            "additionalProperties": False},
        "run": lambda ctx, req: Setup(ctx.runner).provision(req),
    },
    # -- backups
    ("backup", "list"): {
        "description": "List the offline backups of the domain in %s, newest first" % BACKUP_DIR,
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"backups": Backups(ctx.runner).list()},
    },
    ("backup", "create"): {
        "description": ("Make an offline backup of the domain (samba-tool domain backup offline) in %s, "
                        "readable by root only: it holds every password hash. Restoring one is a manual "
                        "procedure (samba-tool domain backup restore)" % BACKUP_DIR),
        "mutates": True, "input": _NONE,
        "run": lambda ctx, req: Backups(ctx.runner).create(),
    },
    ("share", "list"): {
        "description": ("List the shared folders under /srv/samba/shares, with access and drive mapping; "
                        "entries left by deleted accounts are marked unknown; registry_shares false: "
                        "smbd serves none of them (smb.conf lacks \"registry shares = yes\")"),
        "mutates": False,
        "input": {"type": "object", "properties": {}, "additionalProperties": False},
        "run": lambda ctx, req: {"shares": _shares(ctx).list(), "registry_shares": ctx.dc.registry_shares},
    },
    ("share", "get"): {
        "description": "One shared folder; entries left by deleted accounts are marked unknown",
        "mutates": False,
        "input": {"type": "object", "properties": {"name": _SHARE_NAME}, "required": ["name"],
                  "additionalProperties": False},
        "run": lambda ctx, req: {"share": _shares(ctx).get(req["name"])},
    },
    ("share", "set"): {
        "description": ("Create a shared folder, or bring an existing one to the given settings; "
                        "settings left out keep their current value"),
        "mutates": True,
        "input": {
            "type": "object",
            "properties": {
                "name": _SHARE_NAME,
                "access": {"type": "array", "items": _ACCESS_ENTRY,
                           "description": "Users and groups allowed; required to create a share"},
                "access_mode": {"type": "string", "enum": ["replace", "append", "remove"], "default": "replace",
                                "description": ("replace: access is the whole list; append: add or "
                                                "change these entries; remove: drop these principals")},
                "comment": {"type": "string", "maxLength": 1024,
                            "description": "Description shown to clients; empty removes it"},
                "browseable": {"type": "boolean", "description": "Listed when browsing the server; default true"},
                "drive": _DRIVE,
            },
            "required": ["name"],
            "additionalProperties": False,
        },
        "run": lambda ctx, req: _shares(ctx).set(req),
    },
    ("share", "delete"): {
        "description": "Remove a shared folder and its drive mapping",
        "mutates": True,
        "input": {
            "type": "object",
            "properties": {
                "name": _SHARE_NAME,
                "delete_data": {"type": "boolean", "default": False,
                                "description": "Also delete the folder and everything in it"},
            },
            "required": ["name"],
            "additionalProperties": False,
        },
        "run": lambda ctx, req: _shares(ctx).delete(req),
    },
    ("share", "rename-principal"): {
        "description": "Follow the rename of a user or group in every shared folder that lists it",
        "mutates": True,
        "input": {
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["user", "group"]},
                "old": _NAME,
                "new": _NAME,
            },
            "required": ["kind", "old", "new"],
            "additionalProperties": False,
        },
        "run": lambda ctx, req: _shares(ctx).rename_principal(req),
    },
}


def schemas():
    """{"share set": {description, mutates, input}} of every operation."""
    return {"%s %s" % key: {k: v for k, v in op.items() if k != "run"} for key, op in sorted(OPERATIONS.items())}
