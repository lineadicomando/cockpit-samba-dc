# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_pso import build_request

PARAMS = dict(name="Staff", state="present", precedence=None, applies_to=None, applies_to_mode="replace",
              complexity=None, min_length=None, history_length=None, min_age_days=None, max_age_days=None,
              lockout_threshold=None, lockout_duration_minutes=None, lockout_window_minutes=None)


def test_unset_settings_are_left_out():
    assert build_request(PARAMS, create=False) == {"name": "Staff"}


def test_zero_means_never_for_ages_and_intervals():
    params = dict(PARAMS, precedence=10, min_age_days=0, max_age_days=0, lockout_duration_minutes=0,
                  lockout_window_minutes=15)
    assert build_request(params, create=True) == {
        "name": "Staff", "precedence": 10, "min_age_days": 0, "max_age_days": None,
        "lockout_duration_minutes": None, "lockout_window_minutes": 15,
    }


def test_applies_to_and_its_mode():
    params = dict(PARAMS, applies_to=["Teachers"], applies_to_mode="append")
    assert build_request(params, create=False) == {"name": "Staff", "applies_to": ["Teachers"],
                                                   "applies_to_mode": "append"}
    assert build_request(params, create=True) == {"name": "Staff", "applies_to": ["Teachers"]}
    assert build_request(dict(params, applies_to_mode="remove"), create=True) == {"name": "Staff"}
