# Copyright: (c) 2026, Alessandro Gagliano <alessandro.gagliano@lineadicomando.it>
# SPDX-License-Identifier: GPL-3.0-or-later
from __future__ import annotations

from ansible_collections.lineadicomando.samba_dc.plugins.modules.samba_share import build_request, present

PARAMS = dict(name="Projects", state="present", access=None, access_mode="replace", comment=None,
              browseable=None, drive_letter=None, drive_label=None, delete_data=False)


def test_unset_parameters_keep_the_current_values():
    assert build_request(PARAMS) == {"name": "Projects", "access_mode": "replace"}


def test_access_comment_and_drive():
    params = dict(PARAMS, access=[{"name": "Staff", "kind": None, "level": "write"}], comment="",
                  browseable=False, drive_letter="p:", drive_label="Projects")
    assert build_request(params) == {
        "name": "Projects", "access_mode": "replace",
        "access": [{"name": "Staff", "level": "write"}],
        "comment": "", "browseable": False,
        "drive": {"letter": "p:", "label": "Projects"},
    }


def test_empty_letter_removes_the_mapping():
    assert build_request(dict(PARAMS, drive_letter=""))["drive"] is None


def test_label_alone_relabels_the_current_mapping():
    current = {"letter": "P", "label": "Old"}
    assert build_request(dict(PARAMS, drive_label="New"), current)["drive"] == {"letter": "P", "label": "New"}
    assert "drive" not in build_request(dict(PARAMS, drive_label="New"), None)


def test_diff_states():
    assert present(None) == {"state": "absent"}
    assert present({"name": "x"}) == {"name": "x", "state": "present"}
