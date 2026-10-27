# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_dns_record import request

BASE = dict(zone="school.internal", name="www", type="A", values=None, ttl=None, state="present")


def test_present_sends_the_values_and_the_ttl_when_given():
    assert request(dict(BASE, values=["10.0.0.1"])) == {
        "zone": "school.internal", "name": "www", "type": "A", "values": ["10.0.0.1"]}
    assert request(dict(BASE, values=["10.0.0.1"], ttl=300))["ttl"] == 300


def test_absent_deletes_the_values_given_or_all():
    assert request(dict(BASE, state="absent", ttl=300)) == {"zone": "school.internal", "name": "www", "type": "A"}
    assert request(dict(BASE, state="absent", values=["10.0.0.1"]))["values"] == ["10.0.0.1"]
