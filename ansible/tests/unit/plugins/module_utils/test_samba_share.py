# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.samba_share import (
    access_key,
    build_drive_xml,
    build_drives_xml,
    build_filters_xml,
    escape_ldap_filter,
    expected_acl,
    filter_targets,
    format_user_list,
    is_managed_path,
    named_acl_ids,
    normalize_drive_letter,
    parse_drives_xml,
    parse_getfacl,
    parse_ldif_records,
    parse_net_conf,
    parse_smb_bool,
    parse_smb_user_list,
    setfacl_args,
    share_access,
    validate_share_name,
)
from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_share import merge_access

# The fixture of cockpit-samba-dc test/shares.test.ts: both sides must read
# the same registry the same way.
NET_CONF = "\n".join([
    "[home]",
    "\tpath = /srv/samba/home",
    "\tread only = no",
    "",
    "[docs]",
    "\tpath = /srv/samba/shares/docs",
    "\tread only = no",
    '\tvalid users = @"SCHOOL\\Teachers" @"SCHOOL\\Students" "SCHOOL\\mrossi"',
    '\tread list = @"SCHOOL\\Students"',
    "\tcomment = Documents",
    "\tbrowseable = no",
    "",
    "[manual]",
    "\tpath = /data/manual",
    "",
])


def test_parse_net_conf_reads_sections_and_lowercases_params():
    conf = parse_net_conf(NET_CONF)
    assert list(conf) == ["home", "docs", "manual"]
    assert conf["docs"]["path"] == "/srv/samba/shares/docs"
    assert conf["docs"]["comment"] == "Documents"
    assert parse_net_conf("[x]\n\tRead Only = no\n")["x"] == {"read only": "no"}


def test_share_access_reads_levels_like_cockpit():
    assert share_access(parse_net_conf(NET_CONF)["docs"]) == [
        {"name": "Teachers", "kind": "group", "level": "write"},
        {"name": "Students", "kind": "group", "level": "read"},
        {"name": "mrossi", "kind": "user", "level": "write"},
    ]


def test_share_access_on_a_read_only_share_needs_the_write_list():
    params = {"read only": "yes", "valid users": "alice bob", "write list": "bob"}
    assert [e["level"] for e in share_access(params)] == ["read", "write"]


def test_parse_smb_user_list_handles_quotes_commas_and_group_prefixes():
    assert parse_smb_user_list('@"SCHOOL\\Domain Users", +staff &x "SCHOOL\\m rossi" bob') == [
        ("Domain Users", "group"), ("staff", "group"), ("x", "group"), ("m rossi", "user"), ("bob", "user"),
    ]
    assert parse_smb_user_list("") == []


def test_format_user_list_round_trips():
    entries = [{"name": "Teachers", "kind": "group"}, {"name": "mrossi", "kind": "user"}]
    formatted = format_user_list(entries, "SCHOOL")
    assert formatted == '@"SCHOOL\\Teachers" "SCHOOL\\mrossi"'
    assert parse_smb_user_list(formatted) == [("Teachers", "group"), ("mrossi", "user")]


def test_access_key_ignores_order_and_case():
    a = [{"name": "Teachers", "kind": "group", "level": "write"}, {"name": "bob", "kind": "user", "level": "read"}]
    b = [{"name": "BOB", "kind": "user", "level": "read"}, {"name": "teachers", "kind": "group", "level": "write"}]
    assert access_key(a) == access_key(b)
    assert access_key(a) != access_key([dict(a[0], level="read"), a[1]])


def test_parse_smb_bool():
    assert parse_smb_bool("Yes", False) is True
    assert parse_smb_bool("0", True) is False
    assert parse_smb_bool(None, True) is True
    assert parse_smb_bool("maybe", False) is False


def test_is_managed_path():
    assert is_managed_path("/srv/samba/shares/docs")
    assert is_managed_path("/data/x/y", "/data/x/")
    assert not is_managed_path("/srv/samba/shares")
    assert not is_managed_path("/srv/samba/home")
    assert not is_managed_path("/srv/samba/shares/../home")
    assert not is_managed_path("/srv/samba/sharesX/docs")


def test_validate_share_name():
    assert validate_share_name("Progetti 3A") is None
    for bad in ["", "a" * 81, "a/b", "50%", "tab\there", " x", "-x", "sysvol", "HOME", "..", "a:b"]:
        assert validate_share_name(bad), bad


def test_merge_access_modes():
    current = [{"name": "Teachers", "kind": "group", "level": "write"},
               {"name": "bob", "kind": "user", "level": "read"}]
    assert merge_access(current, [{"name": "alice", "kind": None, "level": "read"}], "replace") == [
        {"name": "alice", "kind": None, "level": "read"}]
    appended = merge_access(current, [{"name": "BOB", "kind": None, "level": "write"},
                                      {"name": "alice", "kind": None, "level": "read"}], "append")
    assert [(e["name"], e["level"]) for e in appended] == [("Teachers", "write"), ("bob", "write"), ("alice", "read")]
    assert current[1]["level"] == "read"  # not mutated
    assert merge_access(current, [{"name": "teachers", "kind": None, "level": "read"}], "remove") == [current[1]]
    # the last duplicate wins
    assert merge_access([], [{"name": "a", "level": "read"}, {"name": "A", "level": "write"}], "replace") == [
        {"name": "A", "level": "write"}]


# --- LDIF ----------------------------------------------------------------------

LDBSEARCH = """\
# record 1
dn: CN=student-alice,CN=Users,DC=school,DC=internal
objectClass: top
objectClass: user
objectSid: S-1-5-21-1-2-3-1104
sAMAccountName: student-alice

# record 2
dn: DC=school,DC=internal
gPLink: [LDAP://CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=Syste
 m,DC=school,DC=internal;0]
description:: UsOhZmZhZWxsbw==

# Referral
ref: ldap://school.internal/CN=Configuration,DC=school,DC=internal

# returned 3 records
"""


def test_parse_ldif_records_unfolds_decodes_and_drops_referrals():
    records = parse_ldif_records(LDBSEARCH)
    assert len(records) == 2
    assert records[0]["objectClass"] == ["top", "user"]
    assert records[0]["sAMAccountName"] == ["student-alice"]
    assert records[1]["gPLink"] == [
        "[LDAP://CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=school,DC=internal;0]"]
    assert records[1]["description"] == ["Ráffaello"]


def test_parse_ldif_records_keeps_an_empty_dn():
    assert parse_ldif_records("dn: \ndefaultNamingContext: DC=x\n")[0]["defaultNamingContext"] == ["DC=x"]


def test_escape_ldap_filter():
    assert escape_ldap_filter("a(b)*\\") == "a\\28b\\29\\2a\\5c"


# --- POSIX ACL -------------------------------------------------------------------

# `getfacl -n -p -c -E` of a share root as written by cockpit-samba-dc.
GETFACL = """\
user::rwx
user:3000025:r-x
group::---
group:3000023:rwx
mask::rwx
other::---
default:user::rwx
default:user:3000025:r-x
default:group::---
default:group:3000023:rwx
default:mask::rwx
default:other::---
"""


def test_expected_acl_matches_what_cockpit_writes():
    grants = [("g", "3000023", "write"), ("u", "3000025", "read")]
    assert parse_getfacl(GETFACL) == expected_acl(grants)


def test_expected_acl_notices_a_level_change_and_extra_entries():
    grants = [("g", "3000023", "write"), ("u", "3000025", "read")]
    assert parse_getfacl(GETFACL.replace("group:3000023:rwx", "group:3000023:r-x")) != expected_acl(grants)
    assert parse_getfacl(GETFACL + "group:3000025:rwx\n") != expected_acl(grants)


def test_named_acl_ids():
    assert named_acl_ids(parse_getfacl(GETFACL)) == {("u", "3000025"), ("g", "3000023")}


def test_setfacl_args_clears_stale_ids_then_adds_grants():
    args = setfacl_args("/srv/samba/shares/docs", [("g", "3000023", "read")], {("u", "3000023"), ("g", "100")})
    assert args[:2] == ["setfacl", "-R"]
    assert args[args.index("-x") + 1].split(",") == ["g:100", "d:g:100", "u:3000023", "d:u:3000023"]
    assert args[args.index("-m") + 1].split(",") == [
        "g::---", "d:u::rwx", "d:g::---", "d:o::---", "g:3000023:r-X", "d:g:3000023:r-X"]
    assert args[-1] == "/srv/samba/shares/docs"
    assert "-x" not in setfacl_args("/p", [("u", "1", "write")], set())


# --- Drives.xml --------------------------------------------------------------------

PRINCIPALS = [
    {"name": "Teachers", "kind": "group", "sid": "S-1-5-21-1-2-3-1108"},
    {"name": "mrossi", "kind": "user", "sid": "S-1-5-21-1-2-3-1200"},
]


def test_build_filters_xml_matches_cockpit():
    assert build_filters_xml(PRINCIPALS, "SCHOOL") == (
        '<Filters><FilterGroup bool="OR" not="0" name="SCHOOL\\Teachers" sid="S-1-5-21-1-2-3-1108" '
        'userContext="1" primaryGroup="0" localGroup="0"/>'
        '<FilterUser bool="OR" not="0" name="SCHOOL\\mrossi" sid="S-1-5-21-1-2-3-1200"/></Filters>'
    )


def test_drives_xml_round_trip():
    filters = build_filters_xml(PRINCIPALS, "SCHOOL")
    drive = build_drive_xml("{U}", "2026-09-18 10:00:00", "\\\\DC\\A&B", "m", 'Say "hi"', filters)
    raw = build_drives_xml([drive])
    assert raw.startswith('<?xml version="1.0" encoding="utf-8"?>\r\n<Drives clsid=')
    [parsed] = parse_drives_xml(raw)
    assert parsed == {
        "uid": "{U}", "path": "\\\\DC\\A&B", "letter": "M", "label": 'Say "hi"', "filters": filters, "xml": drive,
    }


def test_filter_targets_ignores_order():
    reversed_filters = build_filters_xml(list(reversed(PRINCIPALS)), "SCHOOL")
    assert filter_targets(reversed_filters) == filter_targets(build_filters_xml(PRINCIPALS, "SCHOOL"))
    assert filter_targets(reversed_filters) == {("group", "S-1-5-21-1-2-3-1108"), ("user", "S-1-5-21-1-2-3-1200")}
    assert filter_targets("") == set()


def test_parse_drives_xml_of_an_empty_file():
    assert parse_drives_xml(build_drives_xml([])) == []
    assert parse_drives_xml("") == []


def test_normalize_drive_letter():
    assert normalize_drive_letter(" m: ") == "M"
    assert normalize_drive_letter(None) == ""
