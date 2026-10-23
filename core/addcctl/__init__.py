# SPDX-License-Identifier: LGPL-2.1-or-later
"""addcctl: the operations of a Samba AD DC, run locally as root.

The core shared by the Cockpit page, the Ansible collection and the MCP
server of cockpit-samba-dc (docs/architecture.md). Every operation reads a
JSON object on stdin and writes a JSON object on stdout.
"""
