# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.module_utils.argument_specs import argument_spec
from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_directory_info import LISTS


def test_every_kind_has_its_list():
    assert set(argument_spec("samba_directory_info")["kind"]["choices"]) == set(LISTS)


def test_kind_is_required_and_name_optional():
    spec = argument_spec("samba_directory_info")
    assert spec["kind"].get("required") is True
    assert not spec["name"].get("required")
