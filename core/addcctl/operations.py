# SPDX-License-Identifier: LGPL-2.1-or-later
"""The operations of addcctl, each with the JSON Schema of its input.

The schemas are the contract: the command validates every input against
them, and they generate the TypeScript types, the Ansible argument specs and
the MCP tools (docs/architecture.md, "The core").
"""
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
        "level": {"type": "string", "enum": ["read", "write"], "description": "Default: read"},
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


def _shares(ctx):
    return Shares(ctx.dc, ctx.runner)


OPERATIONS = {
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
                "access_mode": {"type": "string", "enum": ["replace", "append", "remove"],
                                "description": ("replace: access is the whole list (default); append: add or "
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
                "delete_data": {"type": "boolean",
                                "description": "Also delete the folder and everything in it; default false"},
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
