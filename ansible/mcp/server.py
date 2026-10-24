# SPDX-License-Identifier: GPL-3.0-or-later
"""MCP server exposing the lineadicomando.samba_dc playbooks as tools.

It orchestrates from the control node: building a DC and backing it up.
Users, groups, computers, home directories and shared folders are managed by
`addcctl mcp`, the MCP server on the DC itself (README of the repository).
"""
import asyncio

from mcp.server import Server
from mcp.server.context import ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool, CallToolResult, ListToolsResult, PaginatedRequestParams, CallToolRequestParams

from runner import (
    build_backup_command,
    build_build_command,
    format_command,
    run_command,
    secret_values,
)

app = Server("samba-dc")

_LIMIT_SCHEMA = {
    "type": "string",
    "description": (
        "Ansible host pattern: a single host name or a group. "
        "Passed to the playbook as target_hosts. Left at 'all', the playbook "
        "applies its own default group, samba_dc."
    ),
    "default": "all",
}

_INVENTORY_SCHEMA = {
    "type": "string",
    "description": (
        "Inventory name under inventories/. Optional when the server sets "
        "ANSIBLE_MCP_DEFAULT_INVENTORY (the name used when omitted), ignored "
        "when ANSIBLE_MCP_INVENTORY points at an explicit inventory file."
    ),
}

_PREVIEW_SCHEMA = {
    "type": "boolean",
    "description": (
        "If true, return the ansible-playbook command without "
        "executing it. Use before destructive actions."
    ),
    "default": False,
}


def _get_tools() -> list[Tool]:
    return [
        Tool(
            name="samba_dc_build",
            description=(
                "Build a Samba AD Domain Controller on Debian 13, through the "
                "lineadicomando.samba_dc.samba_dc_build playbook: packages, network, "
                "Kerberos, DNS, NTP, firewall, domain provisioning, addcctl and the "
                "Cockpit page. The samba_dc_build_* variables normally come from the "
                "inventory; args overrides them. Run again on a built DC, it brings the "
                "configuration back and leaves the domain as it is. It changes the "
                "system and may reboot it: always run with preview first and ask the "
                "user to confirm. force_provision=true destroys the existing domain "
                "and also needs force_provision_confirm=true. "
                "Day-two management (users, groups, computers, home directories, "
                "shared folders) is not here: it is the addcctl MCP server on the DC."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "args": {
                        "type": "object",
                        "description": (
                            "Role variables without the samba_dc_build_ prefix, overriding "
                            "the inventory, e.g. {\"realm\": \"EXAMPLE.COM\", "
                            "\"domain\": \"EXAMPLE\", \"cockpit_install\": \"package\"}. "
                            "administrator_passwd is kept off the command line and masked "
                            "in the run log and in previews. force_provision (bool, "
                            "destructive) needs force_provision_confirm=true."
                        ),
                        "default": {},
                    },
                    "l": _LIMIT_SCHEMA,
                    "inventory": _INVENTORY_SCHEMA,
                    "preview": _PREVIEW_SCHEMA,
                },
            },
        ),
        Tool(
            name="samba_dc_backup",
            description=(
                "Backup and restore the Samba AD Domain Controller, through the "
                "lineadicomando.samba_dc.samba_dc_backup playbook. "
                "Actions: backup (domain + user files), restore (domain, DESTRUCTIVE). "
                "Backup always produces new archives and reports changed. "
                "Restore rebuilds a DC from a backup archive — always run with "
                "preview first and require explicit confirmation (restore_confirm=true)."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["backup", "restore"],
                        "description": "Operation to perform.",
                    },
                    "args": {
                        "type": "object",
                        "description": (
                            "Action-specific arguments (keys without the samba_dc_backup_ prefix). "
                            "backup: targetdir (required), domain (bool, default true), "
                            "domain_type (online|offline, default offline), domain_server, "
                            "domain_username, domain_password (required with domain_username; kept "
                            "off the command line and masked in the run log), "
                            "files (bool, default true), files_paths (list, default [/home, /srv/samba]). "
                            "restore: restore_backup_file (required), restore_targetdir (required), "
                            "restore_newservername (required), restore_confirm=true (required)."
                        ),
                        "default": {},
                    },
                    "l": _LIMIT_SCHEMA,
                    "inventory": _INVENTORY_SCHEMA,
                    "preview": _PREVIEW_SCHEMA,
                },
                "required": ["action"],
            },
        ),
    ]


def _command_for(name: str, arguments: dict) -> list[str] | None:
    """Translate an MCP tool call into an ansible-playbook command line."""
    limit = arguments.get("l", "all")
    inventory = arguments.get("inventory")
    args = arguments.get("args") or {}

    if name == "samba_dc_build":
        return build_build_command(args or None, limit, inventory)
    if name == "samba_dc_backup":
        return build_backup_command(arguments["action"], args or None, limit, inventory)
    return None


async def handle_list_tools(ctx: ServerRequestContext, params: PaginatedRequestParams) -> ListToolsResult:
    return ListToolsResult(tools=_get_tools())


async def handle_call_tool(ctx: ServerRequestContext, params: CallToolRequestParams) -> CallToolResult:
    name = params.name
    arguments = params.arguments or {}

    try:
        cmd = _command_for(name, arguments)
    except ValueError as e:
        return CallToolResult(content=[TextContent(type="text", text=str(e))], isError=True)
    if cmd is None:
        return CallToolResult(content=[TextContent(type="text", text=f"Unknown tool: {name}")], isError=True)

    redact = secret_values(name, arguments.get("args"))

    if arguments.get("preview", False):
        return CallToolResult(content=[
            TextContent(
                type="text",
                text=f"Command to run:\n\n  {format_command(cmd, redact)}\n\nNo command executed.",
            )
        ])

    label = "-".join(str(part) for part in (name, arguments.get("action"), arguments.get("l", "all")) if part)
    output = await asyncio.to_thread(run_command, cmd, name, label, redact)
    return CallToolResult(content=[TextContent(type="text", text=output)])


app.add_request_handler("tools/list", PaginatedRequestParams, handle_list_tools)
app.add_request_handler("tools/call", CallToolRequestParams, handle_call_tool)


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


def cli():
    asyncio.run(main())


if __name__ == "__main__":
    cli()
