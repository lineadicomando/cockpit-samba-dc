# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_password_policy import build_request

UNSET = dict(complexity=None, min_length=None, history_length=None, min_age_days=None, max_age_days=None,
             lockout_threshold=None, lockout_duration_minutes=None, lockout_window_minutes=None)


def test_unset_settings_keep_their_value():
    assert build_request(UNSET) == {}


def test_zero_means_never_for_ages_and_intervals():
    params = dict(UNSET, complexity=False, min_length=0, min_age_days=0, max_age_days=0, lockout_threshold=0,
                  lockout_duration_minutes=0, lockout_window_minutes=0)
    assert build_request(params) == {
        "complexity": False, "min_length": 0, "min_age_days": 0, "max_age_days": None, "lockout_threshold": 0,
        "lockout_duration_minutes": None, "lockout_window_minutes": None,
    }


def test_values_pass_through():
    assert build_request(dict(UNSET, max_age_days=90, lockout_window_minutes=10)) == {
        "max_age_days": 90, "lockout_window_minutes": 10}
