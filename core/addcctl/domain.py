# SPDX-License-Identifier: LGPL-2.1-or-later
"""The domain's own settings, read from its root object in sam.ldb."""
from . import ad
from .accounts import first

_DOMAIN_PASSWORD_COMPLEX = 0x1


class Domain:
    def __init__(self, dc, runner):
        self.dc = dc
        self.runner = runner

    def password_policy(self):
        """The domain password and lockout settings (what samba-tool domain
        passwordsettings show prints)."""
        r = self.dc.domain_attrs(["pwdProperties", "minPwdLength", "pwdHistoryLength", "minPwdAge",
                                  "maxPwdAge", "lockoutThreshold", "lockoutDuration",
                                  "lockOutObservationWindow"])

        def number(attr):
            try:
                return int(first(r, attr, "0"))
            except ValueError:
                return 0

        def days(attr):
            minutes = ad.interval_minutes(first(r, attr))
            return None if minutes is None else minutes // 1440

        return {
            "complexity": bool(number("pwdProperties") & _DOMAIN_PASSWORD_COMPLEX),
            "min_length": number("minPwdLength"),
            "history_length": number("pwdHistoryLength"),
            # None: never (no maximum age), as the domain stores it
            "min_age_days": days("minPwdAge") or 0,
            "max_age_days": days("maxPwdAge") or None,
            "lockout_threshold": number("lockoutThreshold"),
            "lockout_duration_minutes": ad.interval_minutes(first(r, "lockoutDuration")),
            "lockout_window_minutes": ad.interval_minutes(first(r, "lockOutObservationWindow")),
        }
