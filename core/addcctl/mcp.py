# SPDX-License-Identifier: LGPL-2.1-or-later
"""addcctl mcp: the operations as the tools of an MCP server on stdio.

Reached through SSH (`ssh -T dc sudo -n addcctl mcp`), it reads JSON-RPC
messages, one per line, and answers on stdout. One tool per operation, named
"<object>_<action>" ("share_set", "share_rename_principal"), with the
operation's JSON Schema as input; a mutation takes "check": true to preview
what it would change, as `addcctl --check` does.

The subset of MCP a tools-only server needs (initialize, ping, tools/list,
tools/call) is written here, so that addcctl keeps no dependency beyond
Samba's. Every call goes to syslog with the secrets ("writeOnly" inputs)
masked; they are never in a result either.
"""
import copy
import json
import os
import sys
import syslog
import traceback

from .errors import AddcError
from .operations import OPERATIONS

try:
    from .version import VERSION  # written by the Debian package
except ImportError:
    VERSION = "unknown"

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

INSTRUCTIONS = (
    "Tools of a Samba Active Directory domain controller, run on the DC itself as root: "
    "users, groups, computers, home directories, shared folders under /srv/samba/shares "
    "with network drives mapped at logon, and the password policy. Names are sAMAccountNames. "
    "Every tool that changes something takes \"check\": true, which reports in \"commands\" "
    "what it would do and changes nothing: use it, and show the result, before a delete or "
    "any change the user has not confirmed. Passwords are never returned. A shared folder "
    "always keeps at least one user or group in its access list, and deleting an account "
    "leaves it listed in the shares that name it."
)

_CHECK = {"type": "boolean",
          "description": "Preview: report in \"commands\" what would change, and change nothing"}

# JSON-RPC error codes
PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = (
    -32700, -32600, -32601, -32602, -32603)


class RpcError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def tool_name(key):
    return "_".join(key).replace("-", "_")


def tools(operations, read_only=False):
    """{tool name: (operation, MCP tool definition)}."""
    found = {}
    for key, op in sorted(operations.items()):
        if op.get("mcp") is False or read_only and op["mutates"]:
            continue
        schema = copy.deepcopy(op["input"])
        description = op["description"]
        if op["mutates"]:
            schema.setdefault("properties", {})["check"] = _CHECK
            description += ". Takes \"check\": true to preview the change"
        found[tool_name(key)] = (op, {
            "name": tool_name(key),
            "title": "%s %s" % key,
            "description": description,
            "inputSchema": schema,
            "annotations": {
                "readOnlyHint": not op["mutates"],
                "destructiveHint": op["mutates"] and key[1] == "delete",
                "openWorldHint": False,
            },
        })
    return found


def masked(schema, value):
    """value with the secrets of schema ("writeOnly") replaced by ***."""
    if schema.get("writeOnly"):
        return "***"
    if isinstance(value, dict):
        props = schema.get("properties", {})
        return {k: masked(props.get(k, {}), v) for k, v in value.items()}
    if isinstance(value, list):
        return [masked(schema.get("items", {}), v) for v in value]
    return value


def _log(message):
    syslog.syslog(syslog.LOG_INFO, message)


class Server:
    def __init__(self, operations=OPERATIONS, read_only=False, execute=None, log=_log):
        if execute is None:
            from .cli import execute
        self.tools = tools(operations, read_only)
        self.read_only = read_only
        self.execute = execute
        self.log = log
        # Who started the server, for the log: sudo's caller, or the SSH user
        self.caller = os.environ.get("SUDO_USER") or os.environ.get("USER") or "?"

    def handle(self, message):
        """The answer to one JSON-RPC message, or None for a notification."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" \
                or not isinstance(message.get("method"), str):
            return _error(message.get("id") if isinstance(message, dict) else None,
                          INVALID_REQUEST, "Not a JSON-RPC 2.0 request")
        if "id" not in message:
            return None  # notifications/initialized, notifications/cancelled
        params = message.get("params") or {}
        try:
            if not isinstance(params, dict):
                raise RpcError(INVALID_PARAMS, "params must be an object")
            method = getattr(self, "rpc_" + message["method"].replace("/", "_"), None)
            if method is None:
                raise RpcError(METHOD_NOT_FOUND, "Unknown method %s" % message["method"])
            result = method(params)
        except RpcError as e:
            return _error(message["id"], e.code, str(e))
        return {"jsonrpc": "2.0", "id": message["id"], "result": result}

    def rpc_initialize(self, params):
        asked = params.get("protocolVersion")
        return {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "addcctl", "version": VERSION},
            "instructions": INSTRUCTIONS + (" This server is read-only." if self.read_only else ""),
        }

    def rpc_ping(self, params):
        return {}

    def rpc_tools_list(self, params):
        return {"tools": [tool for _, tool in self.tools.values()]}

    def rpc_tools_call(self, params):
        name = params.get("name")
        if name not in self.tools:
            raise RpcError(INVALID_PARAMS, "Unknown tool %s" % name)
        op, tool = self.tools[name]
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise RpcError(INVALID_PARAMS, "arguments must be an object")
        request = dict(arguments)
        check = request.pop("check", False) if op["mutates"] else False
        shown = json.dumps(masked(tool["inputSchema"], arguments), ensure_ascii=False, sort_keys=True)
        if not isinstance(check, bool):
            return _tool_error("check must be true or false")
        try:
            result = self.execute(op, request, check)
        except AddcError as e:
            if op["mutates"]:
                self.log("%s: %s %s failed: %s" % (self.caller, name, shown, e))
            return _tool_error(str(e))
        except Exception as e:  # keep serving: one failed call is not the end of the session
            traceback.print_exc(file=sys.stderr)
            self.log("%s: %s %s failed: %s" % (self.caller, name, shown, e.__class__.__name__))
            return _tool_error("Internal error (%s): %s" % (e.__class__.__name__, e))
        if op["mutates"]:
            self.log("%s: %s %s%s" % (self.caller, name, shown,
                                      " (check)" if check else (" changed" if result.get("changed") else " unchanged")))
        return {
            "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, sort_keys=True)}],
            "structuredContent": result,
            "isError": False,
        }


def _error(id_, code, message):
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _tool_error(message):
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _answer(server, line):
    try:
        message = json.loads(line)
    except ValueError as e:
        return _error(None, PARSE_ERROR, "Not JSON: %s" % e)
    if isinstance(message, list):  # a batch (protocol 2025-03-26)
        answers = [a for a in (server.handle(m) for m in message) if a is not None]
        return answers or None
    return server.handle(message)


def serve(instream, outstream, read_only=False, server=None):
    """Answer the messages of instream (bytes, one per line) on outstream
    until it closes. Anything else written to fd 1 (a library's warning)
    goes to stderr, so it cannot break the protocol."""
    if outstream is sys.stdout:
        outstream = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8")
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        sys.stdout = sys.stderr
    if server is None:
        syslog.openlog("addcctl-mcp", syslog.LOG_PID, syslog.LOG_AUTHPRIV)
        server = Server(read_only=read_only)
        server.log("%s: started%s" % (server.caller, " (read-only)" if read_only else ""))
    for raw in iter(instream.readline, b""):
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        answer = _answer(server, line)
        if answer is not None:
            outstream.write(json.dumps(answer, ensure_ascii=False) + "\n")
            outstream.flush()
    return 0
