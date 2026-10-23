# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_tool_user import (
    _UAC_ACCOUNTDISABLE,
    SambaUser,
    _parse_ldif,
)

# Trimmed but otherwise verbatim `samba-tool user show alice` output.
USER_SHOW = """\
dn: CN=alice,CN=Users,DC=example,DC=com
objectClass: top
objectClass: person
sAMAccountName: alice
userAccountControl: 512
primaryGroupID: 513
objectSid: S-1-5-21-1234567890-1234567890-1234567890-1104
"""


def test_parse_ldif_reads_single_valued_attributes():
    attrs = _parse_ldif(USER_SHOW)
    assert attrs["dn"] == "CN=alice,CN=Users,DC=example,DC=com"
    assert attrs["sAMAccountName"] == "alice"
    assert attrs["userAccountControl"] == "512"
    assert attrs["primaryGroupID"] == "513"


def test_parse_ldif_keeps_the_last_value_of_a_repeated_attribute():
    assert _parse_ldif(USER_SHOW)["objectClass"] == "person"


def test_parse_ldif_unfolds_continuation_lines():
    folded = "dn: CN=a very long name,CN=Users,DC=example,\n DC=com\n"
    assert _parse_ldif(folded)["dn"] == "CN=a very long name,CN=Users,DC=example,DC=com"


def test_parse_ldif_decodes_base64_values():
    # `description:: UsOhZmZhZWxsbw==` is how samba-tool emits "Ráffaello".
    attrs = _parse_ldif("dn: CN=alice\ndescription:: UsOhZmZhZWxsbw==\n")
    assert attrs["description"] == "Ráffaello"


def test_parse_ldif_leaves_undecodable_base64_untouched():
    attrs = _parse_ldif("dn: CN=alice\ndescription:: not-base64!\n")
    assert attrs["description"] == "not-base64!"


def test_parse_ldif_does_not_fold_across_a_blank_line():
    attrs = _parse_ldif("dn: CN=alice\n\n leftover\nsAMAccountName: alice\n")
    assert attrs["dn"] == "CN=alice"
    assert attrs["sAMAccountName"] == "alice"


def test_parse_ldif_ignores_lines_without_a_separator():
    assert _parse_ldif("no separator here\n") == {}


def test_is_disabled_reads_the_accountdisable_flag():
    assert SambaUser.is_disabled({"userAccountControl": str(512 | _UAC_ACCOUNTDISABLE)})
    assert not SambaUser.is_disabled({"userAccountControl": "512"})


def test_is_disabled_defaults_to_enabled_on_unusable_input():
    assert not SambaUser.is_disabled({})
    assert not SambaUser.is_disabled({"userAccountControl": "not-a-number"})
    assert not SambaUser.is_disabled({"userAccountControl": None})
