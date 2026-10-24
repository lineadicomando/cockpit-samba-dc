#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
"""The options of the collection's modules, generated from the JSON Schemas
of addcctl's operations (`addcctl schema`, core/addcctl/operations.py).

  python3 scripts/ansible-specs.py           write the two files below
  python3 scripts/ansible-specs.py --check   fail when they are not up to date (CI)

An option that passes a setting to addcctl takes from its schema the type,
the choices, the elements and suboptions, the default, no_log (writeOnly)
and the description; it is required when every operation of the module
requires it. MODULES below adds what only the module knows: its own options
(state, create, update_password, ...), aliases, and the descriptions of
settings the module treats differently from addcctl.
"""
import json
import re
import subprocess
import sys
import textwrap

DOC_FRAGMENT = "ansible/plugins/doc_fragments/options.py"
ARG_SPECS = "ansible/plugins/module_utils/argument_specs.py"


def field(op, path=None, **override):
    """An option from setting `path` (dotted, default: the option's name) of operation `op`."""
    return {"op": op, "path": path, "override": override}


def own(**spec):
    """An option of the module alone."""
    return {"own": spec}


STATE = own(type="str", choices=["present", "absent"], default="present")
SHARES_DIR = own(type="path", default="/srv/samba/shares", description=[
    "Directory holding the shared folders. Kept for compatibility; only the default is accepted, "
    "the directory addcctl manages."])
SAM_LDB_PATH = own(type="path", default="/var/lib/samba/private/sam.ldb", description=[
    "Samba directory database. Kept for compatibility; only the default is accepted."])

MODULES = {
    "samba_user": {
        "ops": ["user create", "user set", "user delete"],
        "options": {
            "name": field("user set"),
            "state": dict(STATE, own=dict(STATE["own"], description=[
                "C(present) creates the user when it is missing (then O(password) is required) and "
                "brings it to the given settings; C(absent) deletes it.",
                "Shared folders keep listing a deleted user, so that none is left open to every domain user."])),
            "password": field("user create", description=[
                "Password, set when the user is created, or on every run with O(update_password=always)."]),
            "update_password": own(type="str", choices=["on_create", "always"], default="on_create", description=[
                "C(on_create) sets O(password) only when the user is created; C(always) sets it on every run, "
                "which then always reports a change."]),
            "must_change_password": field("user create", description=[
                "Ask for a new password at the next logon, when the password is set."]),
            "given_name": field("user set"),
            "surname": field("user set"),
            "email": field("user set", aliases=["mail"]),
            "description": field("user set"),
            "title": field("user set", aliases=["job_title"]),
            "department": field("user set"),
            "company": field("user set"),
            "ou": field("user create", description=[
                "Container the user is created in, relative to the domain (e.g. C(OU=Students)). "
                "Only used when the user is created."]),
            "enabled": field("user set"),
            "expires": field("user set", description=[
                "When the account stops working, ISO 8601 with a time zone (e.g. C(2027-07-01T00:00:00+02:00)); "
                "C(never) removes the expiry."]),
            "groups": field("user set", description=[
                "Groups of the user, the primary group aside; see O(groups_mode)."]),
            "groups_mode": field("user set"),
            "primary_group": field("user set", description=[
                "Primary group; the user must belong to it, through O(groups) or already."]),
            "new_name": field("user set", description=["Rename the user; its shared folders follow the new name."]),
        },
    },
    "samba_group": {
        "ops": ["group create", "group set", "group delete"],
        "options": {
            "name": field("group set"),
            "state": dict(STATE, own=dict(STATE["own"], description=[
                "C(present) creates the group when it is missing, unless O(create) is false, and brings it "
                "to the given settings; C(absent) deletes it.",
                "Shared folders keep listing a deleted group."])),
            "create": own(type="bool", default=True, description=[
                "Create the group when it is missing; when false, a missing group is an error."]),
            "description": field("group set"),
            "scope": field("group create", description=[
                "Group scope, set when the group is created (default C(global)); an existing group keeps "
                "its own, with a warning when it differs."]),
            "category": field("group create", description=[
                "Group category, set when the group is created (default C(security)); an existing group "
                "keeps its own, with a warning when it differs."]),
            "members": field("group set", description=[
                "Users, computers (C(name$)) or groups; see O(members_mode). Accounts whose primary group "
                "this is already belong to it."]),
            "members_mode": field("group set"),
            "new_name": field("group set", description=["Rename the group; its shared folders follow the new name."]),
        },
    },
    "samba_computer": {
        "ops": ["computer create", "computer delete"],
        "options": {
            "name": field("computer delete"),
            "state": dict(STATE, own=dict(STATE["own"], description=[
                "C(present) creates the account when it is missing; C(absent) deletes it."])),
            "ou": field("computer create"),
            "description": field("computer create", description=["Description, set when the account is created."]),
        },
    },
    "samba_home": {
        "ops": ["home provision", "home delete"],
        "options": {
            "name": field("home provision"),
            "state": dict(STATE, own=dict(STATE["own"], description=[
                "C(present) creates the folder (owned by the user and its login group, mode 0700), sets the "
                "drive attributes and makes sure the C(home) share serves it; C(absent) clears the attributes."])),
            "drive": field("home provision"),
            "delete_data": field("home delete", description=[
                "With O(state=absent), also remove C(/srv/samba/home/<user>) and its contents."]),
        },
    },
    "samba_share": {
        "ops": ["share set", "share delete"],
        "options": {
            "name": field("share set", description=[
                "Share name. Also the name of the folder under O(shares_dir).",
                "Matched case-insensitively against existing shares, as Samba does."]),
            "state": dict(STATE, own=dict(STATE["own"], description=[
                "C(present) ensures the share exists with the requested settings, C(absent) ensures it does not."])),
            "access": field("share set", description=[
                "Users and groups allowed on the share, by sAMAccountName (without the C(DOMAIN\\) prefix).",
                "Required to create a share. On an existing share, leaving it unset keeps the current access list.",
                "How the list combines with the current one depends on O(access_mode)."]),
            "access_mode": field("share set", description=[
                "C(replace) makes O(access) the complete access list.",
                "C(append) adds the entries of O(access), or changes the level of those already present, "
                "and keeps the others.",
                "C(remove) drops the principals named in O(access); their level and kind are ignored.",
                "A share always needs at least one user or group, since an empty C(valid users) would open "
                "it to every domain user."]),
            "comment": field("share set", description=[
                "Share description shown to clients. An empty string removes it.",
                "Unmanaged on an existing share when unset."]),
            "browseable": field("share set", description=[
                "Whether the share is listed when browsing the server.",
                "Defaults to C(true) for a new share, unmanaged on an existing one when unset."]),
            "drive_letter": field("share set", "drive.letter", description=[
                "Map the share as this network drive at logon, for the same users and groups that can access "
                "it. One of E-Z except H, which is reserved for home directories. A trailing colon is accepted.",
                "An empty string removes the mapping. When unset, an existing mapping is kept and follows "
                "access list changes."]),
            "drive_label": field("share set", "drive.label", description=[
                "Label of the mapped drive. When unset, the current label is kept, or the share name is used "
                "for a new mapping."]),
            "delete_data": field("share delete", description=[
                "With O(state=absent), also delete the folder and all its contents. Otherwise the data is "
                "kept on disk."]),
            "shares_dir": SHARES_DIR,
            "sam_ldb_path": SAM_LDB_PATH,
        },
    },
    "samba_share_info": {
        "ops": ["share list"],
        "options": {
            "name": field("share get", description=[
                "Only return this share (matched case-insensitively). All managed shares are returned when unset."]),
            "shares_dir": SHARES_DIR,
            "sam_ldb_path": SAM_LDB_PATH,
        },
    },
}

_TYPES = {"string": "str", "boolean": "bool", "integer": "int", "array": "list", "object": "dict"}


def setting(schemas, op, path):
    """The schema of a setting and whether its operation requires it."""
    schema = schemas[op]["input"]
    required = False
    for key in path.split("."):
        required = key in schema.get("required", [])
        schema = schema["properties"][key]
    return schema, required


def sentence(text):
    return text if text.endswith(".") else text + "."


def option(schema):
    """An Ansible option (argument spec keys, plus description) from a JSON Schema."""
    types = [t for t in ([schema["type"]] if isinstance(schema["type"], str) else schema["type"]) if t != "null"]
    if len(types) != 1:
        raise SystemExit("unsupported type %r" % schema["type"])
    spec = {"type": _TYPES[types[0]]}
    if schema.get("description"):
        spec["description"] = [sentence(schema["description"])]
    if "default" in schema:
        spec["default"] = schema["default"]
    if "enum" in schema:
        spec["choices"] = [v for v in schema["enum"] if v is not None]
    if schema.get("writeOnly"):
        spec["no_log"] = True
    if types[0] == "array":
        items = schema["items"]
        item = option(items)
        spec["elements"] = item["type"]
        if item["type"] == "dict":
            spec["options"] = suboptions(items)
    return spec


def suboptions(schema):
    out = {}
    for key, value in schema["properties"].items():
        out[key] = option(value)
        if key in schema.get("required", []):
            out[key]["required"] = True
    return out


def module_options(schemas, module):
    out = {}
    for name, source in module["options"].items():
        if "own" in source:
            spec = dict(source["own"])
        else:
            path = source["path"] or name
            schema, _ = setting(schemas, source["op"], path)
            spec = option(schema)
            # Required when every operation of the module requires it
            if all(setting_required(schemas, op, path) for op in module["ops"]):
                spec["required"] = True
            spec.update(source["override"])
        if "description" not in spec:
            raise SystemExit("%s: no description" % name)
        out[name] = spec
    return out


def setting_required(schemas, op, path):
    try:
        return setting(schemas, op, path)[1]
    except KeyError:
        return False


# -- argument specs

def argument_spec(options):
    out = {}
    for name, spec in options.items():
        arg = {k: v for k, v in spec.items() if k not in ("description", "options")}
        if "options" in spec:
            arg["options"] = argument_spec(spec["options"])
        out[name] = arg
    return out


HEADER = """\
# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# GNU General Public License v3.0+
# (see https://www.gnu.org/licenses/gpl-3.0.txt)
# SPDX-License-Identifier: GPL-3.0-or-later
# Generated by scripts/ansible-specs.py from addcctl's schemas: do not edit.
"""


def py(value, indent=""):
    """A Python literal: one option per line, its keys on that line, suboptions below."""
    if isinstance(value, dict):
        if any(isinstance(v, dict) for v in value.values()):
            inner = indent + "    "
            items = "".join("%s%r: %s,\n" % (inner, k, py(v, inner)) for k, v in value.items())
            return "{\n%s%s}" % (items, indent)
        return "{%s}" % ", ".join("%r: %s" % (k, py(v, indent)) for k, v in value.items())
    if isinstance(value, list):
        return "[%s]" % ", ".join(py(v, indent) for v in value)
    return repr(value)


def arg_specs_file(specs):
    return (HEADER + '"""The argument specs of the modules, from the schemas of addcctl\'s operations."""\n'
            "from __future__ import annotations\n\nimport copy\n\n"
            "_SPECS = " + py({m: argument_spec(o) for m, o in specs.items()}) + "\n\n\n"
            "def argument_spec(module):\n"
            '    """The argument_spec of AnsibleModule for one module of the collection."""\n'
            "    return copy.deepcopy(_SPECS[module])\n")


# -- documentation

_PLAIN = re.compile(r"^[A-Za-z(][^:#'\"\n]*$")


def scalar(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if _PLAIN.match(value) and not value.endswith(" ") and value.lower() not in ("yes", "no", "true", "false", "null"):
        return value
    return json.dumps(value)


def doc_yaml(options, indent):
    lines = []
    pad = " " * indent
    for name, spec in options.items():
        lines.append("%s%s:" % (pad, name))
        inner = pad + "  "
        lines.append("%sdescription:" % inner)
        for text in spec["description"]:
            # A plain or double-quoted scalar may go on over more indented lines, joined by spaces
            lines += textwrap.wrap(scalar(text), 100, initial_indent=inner + "  - ",
                                   subsequent_indent=inner + "    ", break_long_words=False,
                                   break_on_hyphens=False)
        lines.append("%stype: %s" % (inner, spec["type"]))
        if spec.get("required"):
            lines.append("%srequired: true" % inner)
        if "default" in spec:
            lines.append("%sdefault: %s" % (inner, scalar(spec["default"])))
        for key in ("choices", "aliases"):
            if key in spec:
                lines.append("%s%s: [%s]" % (inner, key, ", ".join(scalar(v) for v in spec[key])))
        if "elements" in spec:
            lines.append("%selements: %s" % (inner, spec["elements"]))
        if "options" in spec:
            lines.append("%ssuboptions:" % inner)
            lines += doc_yaml(spec["options"], indent + 4)
    return lines


def doc_fragment_file(specs):
    out = HEADER + ('"""The options of the modules, from the schemas of addcctl\'s operations: each module\n'
                    'extends lineadicomando.samba_dc.options.<module>."""\n'
                    "from __future__ import annotations\n\n\n"
                    "class ModuleDocFragment(object):\n")
    for module, options in specs.items():
        out += "\n    %s = r'''\noptions:\n%s\n'''\n" % (module.upper(), "\n".join(doc_yaml(options, 2)))
    return out


def main(args):
    schemas = json.loads(subprocess.run([sys.executable, "-m", "addcctl", "schema"], cwd="core",
                                        check=True, capture_output=True, text=True).stdout)
    specs = {name: module_options(schemas, module) for name, module in MODULES.items()}
    files = {DOC_FRAGMENT: doc_fragment_file(specs), ARG_SPECS: arg_specs_file(specs)}
    stale = []
    for path, text in files.items():
        if "--check" in args:
            try:
                with open(path) as f:
                    current = f.read()
            except FileNotFoundError:
                current = None
            if current != text:
                stale.append(path)
        else:
            with open(path, "w") as f:
                f.write(text)
    if stale:
        sys.exit("%s not up to date: run make schema" % ", ".join(stale))


if __name__ == "__main__":
    main(sys.argv[1:])
