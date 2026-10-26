# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_ou import changes, find

OUS = [
    {"dn": "CN=Users", "name": "Users", "parent": "", "kind": "container", "description": ""},
    {"dn": "OU=School", "name": "School", "parent": "", "kind": "ou", "description": ""},
    {"dn": "OU=Class 1A,OU=School", "name": "Class 1A", "parent": "OU=School", "kind": "ou", "description": "x"},
]
UNSET = dict(new_name=None, new_parent=None, description=None)


def test_find_by_name_and_parent_case_insensitively():
    assert find(OUS, "class 1a", "ou=school")["dn"] == "OU=Class 1A,OU=School"
    assert find(OUS, "Class 1A", "") is None


def test_find_skips_the_default_containers():
    assert find(OUS, "Users", "") is None


def test_changes_only_what_differs():
    ou = OUS[2]
    assert changes(ou, UNSET) == {}
    assert changes(ou, dict(UNSET, new_name="Class 1A", new_parent="OU=SCHOOL", description="x")) == {}
    assert changes(ou, dict(UNSET, new_name="Class 2A", new_parent="", description="")) == {
        "new_name": "Class 2A", "parent": "", "description": ""}
