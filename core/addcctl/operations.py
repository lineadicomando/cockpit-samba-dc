# SPDX-License-Identifier: LGPL-2.1-or-later
"""The operations of addcctl, each with the JSON Schema of its input.

The schemas are the contract: the command validates every input against
them, and they generate the TypeScript types, the Ansible argument specs and
the MCP tools (docs/architecture.md, "The core"). A `default` is what the
operation does when the setting is left out; the validator ignores it.
"""
from .accounts import Computers, Groups, Users
from .backups import BACKUP_DIR, Backups
from .domain import CHECKS, Domain
from .homes import Homes
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
_NAME_ONLY = lambda d, desc: {"type": "object", "properties": {"name": dict(d, description=desc)},
                              "required": ["name"], "additionalProperties": False}
_NONE = {"type": "object", "properties": {}, "additionalProperties": False}


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
        "description": "List the domain users, with their groups, status, lockout and expiry",
        "mutates": False, "input": _NONE,
        "run": lambda ctx, req: {"users": _users(ctx).list()},
    },
    ("user", "get"): {
        "description": "One domain user",
        "mutates": False, "input": _NAME_ONLY(_ACCOUNT, "sAMAccountName of the user"),
        "run": lambda ctx, req: {"user": _users(ctx).get(req["name"])},
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
                "ou": dict(_TEXT, description="Container to create it in, relative to the domain (e.g. OU=Students); default CN=Users"),
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
        "description": "Delete a domain user (not the built-in ones); shared folders keep listing it",
        "mutates": True, "input": _NAME_ONLY(_ACCOUNT, "sAMAccountName of the user"),
        "run": lambda ctx, req: _users(ctx).delete(req),
    },
    # -- groups
    ("group", "list"): {
        "description": "List the groups, with their members",
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
            "scope": {"type": "string", "enum": ["domain", "global", "universal"], "description": "Default: global"},
            "category": {"type": "string", "enum": ["security", "distribution"], "description": "Default: security"},
            "members": {"type": "array", "items": _GROUP, "description": "Users, computers (name$) or groups"},
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
            "members": {"type": "array", "items": _GROUP, "description": "Users, computers (name$) or groups"},
            "members_mode": {"type": "string", "enum": ["replace", "append", "remove"], "default": "replace",
                             "description": "replace makes members the whole list, append adds them, remove drops them"},
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: _groups(ctx).set(req),
    },
    ("group", "delete"): {
        "description": "Delete a group (not the built-in ones); shared folders keep listing it",
        "mutates": True, "input": _NAME_ONLY(_GROUP, "sAMAccountName of the group"),
        "run": lambda ctx, req: _groups(ctx).delete(req),
    },
    # -- computers
    ("computer", "list"): {
        "description": "List the computer accounts",
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
            "name": dict(_ACCOUNT, description="Computer name, without the trailing $"),
            "ou": dict(_TEXT, description="Container, relative to the domain; default CN=Computers"),
            "description": dict(_TEXT, description="Description"),
        }, "required": ["name"], "additionalProperties": False},
        "run": lambda ctx, req: _computers(ctx).create(req),
    },
    ("computer", "delete"): {
        "description": "Delete a computer account and its DNS records (not a domain controller)",
        "mutates": True, "input": _NAME_ONLY(_ACCOUNT, "Computer name, with or without the trailing $"),
        "run": lambda ctx, req: _computers(ctx).delete(req),
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
        "description": "List the shared folders under /srv/samba/shares, with access and drive mapping",
        "mutates": False,
        "input": {"type": "object", "properties": {}, "additionalProperties": False},
        "run": lambda ctx, req: {"shares": _shares(ctx).list()},
    },
    ("share", "get"): {
        "description": "One shared folder",
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
