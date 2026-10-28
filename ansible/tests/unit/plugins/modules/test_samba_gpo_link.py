# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_gpo_link import request

BASE = dict(gpo="Students lockdown", container="OU=Students", enforced=None, disabled=None, state="present")


def test_present_sends_only_the_flags_given():
    assert request(BASE) == {"gpo": "Students lockdown", "container": "OU=Students"}
    assert request(dict(BASE, enforced=True, disabled=False)) == {
        "gpo": "Students lockdown", "container": "OU=Students", "enforced": True, "disabled": False}


def test_absent_leaves_the_flags_out():
    assert request(dict(BASE, state="absent", enforced=True, disabled=True)) == {
        "gpo": "Students lockdown", "container": "OU=Students"}


def test_no_container_is_the_domain():
    assert request(dict(BASE, container=None))["container"] == ""
