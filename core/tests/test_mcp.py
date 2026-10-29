# SPDX-License-Identifier: LGPL-2.1-or-later
import io
import json
import unittest

from addcctl.errors import AddcError
from addcctl.mcp import Server, masked, serve, tools
from addcctl.operations import OPERATIONS


class FakeExecute:
    """Stands for cli.execute: records the calls, answers like an operation."""

    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail

    def __call__(self, op, request, check):
        self.calls.append((op["description"], request, check))
        if self.fail:
            raise self.fail
        if op["mutates"]:
            return {"changed": True, "commands": ["something"], "check": check}
        return {"users": [{"name": "mrossi"}]}


class TestMcp(unittest.TestCase):
    def setUp(self):
        self.execute = FakeExecute()
        self.logged = []
        self.server = Server(execute=self.execute, log=self.logged.append)

    def rpc(self, method, params=None, server=None):
        answer = (server or self.server).handle({"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}})
        self.assertEqual(answer["id"], 7)
        return answer

    def call(self, name, arguments):
        return self.rpc("tools/call", {"name": name, "arguments": arguments})["result"]

    def test_initialize(self):
        result = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                         "clientInfo": {"name": "t", "version": "1"}})["result"]
        self.assertEqual(result["protocolVersion"], "2025-03-26")
        self.assertEqual(result["serverInfo"]["name"], "addcctl")
        self.assertEqual(result["capabilities"], {"tools": {"listChanged": False}})
        # An unknown version gets the newest one
        result = self.rpc("initialize", {"protocolVersion": "1999-01-01"})["result"]
        self.assertEqual(result["protocolVersion"], "2025-06-18")

    def test_one_tool_per_operation(self):
        listed = {t["name"]: t for t in self.rpc("tools/list")["result"]["tools"]}
        # Every operation but those marked "mcp": False (domain provision)
        self.assertEqual(len(listed), len([op for op in OPERATIONS.values() if op.get("mcp") is not False]))
        self.assertNotIn("domain_provision", listed)
        self.assertIn("share_rename_principal", listed)
        self.assertIn("domain_password_policy", listed)
        user_list, user_delete = listed["user_list"], listed["user_delete"]
        self.assertTrue(user_list["annotations"]["readOnlyHint"])
        self.assertNotIn("check", user_list["inputSchema"]["properties"])
        self.assertTrue(user_delete["annotations"]["destructiveHint"])
        self.assertEqual(user_delete["inputSchema"]["properties"]["check"]["type"], "boolean")
        # The operations' own schemas are not touched
        self.assertNotIn("check", OPERATIONS[("user", "delete")]["input"]["properties"])

    def test_read_only_offers_no_mutation(self):
        server = Server(read_only=True, execute=self.execute, log=self.logged.append)
        names = [t["name"] for t in self.rpc("tools/list", server=server)["result"]["tools"]]
        self.assertIn("share_list", names)
        self.assertNotIn("share_set", names)
        answer = self.rpc("tools/call", {"name": "user_delete", "arguments": {"name": "x"}}, server=server)
        self.assertEqual(answer["error"]["code"], -32602)
        self.assertEqual(self.execute.calls, [])

    def test_call_read(self):
        result = self.call("user_list", {})
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"], {"users": [{"name": "mrossi"}]})
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        self.assertEqual(self.logged, [])

    def test_check_is_the_preview(self):
        self.call("share_delete", {"name": "Projects", "check": True})
        self.call("share_delete", {"name": "Projects"})
        self.assertEqual([(r, c) for _, r, c in self.execute.calls],
                         [({"name": "Projects"}, True), ({"name": "Projects"}, False)])
        self.assertTrue(self.logged[0].endswith('share_delete {"check": true, "name": "Projects"} (check)'))
        self.assertTrue(self.logged[1].endswith('share_delete {"name": "Projects"} changed'))
        self.assertTrue(self.call("share_delete", {"name": "P", "check": "yes"})["isError"])

    def test_secrets_never_logged(self):
        self.call("user_create", {"name": "mrossi", "password": "S3cret!pw", "groups": ["Staff"]})
        self.execute.fail = AddcError("no")
        self.call("user_password", {"name": "mrossi", "password": "S3cret!pw"})
        self.assertEqual(len(self.logged), 2)
        for line in self.logged:
            self.assertNotIn("S3cret", line)
            self.assertIn('"password": "***"', line)
        self.assertEqual(masked({"type": "array", "items": {"writeOnly": True}}, ["a", "b"]), ["***", "***"])

    def test_errors_are_tool_errors(self):
        self.execute.fail = AddcError("No such user: nobody")
        result = self.call("user_get", {"name": "nobody"})
        self.assertTrue(result["isError"])
        self.assertEqual(result["content"][0]["text"], "No such user: nobody")
        self.execute.fail = KeyError("x")
        import contextlib
        with contextlib.redirect_stderr(io.StringIO()):
            result = self.call("user_get", {"name": "x"})
        self.assertTrue(result["isError"])
        self.assertIn("Internal error (KeyError)", result["content"][0]["text"])

    def test_protocol_errors(self):
        self.assertEqual(self.rpc("resources/list")["error"]["code"], -32601)
        self.assertEqual(self.rpc("tools/call", {"name": "fly"})["error"]["code"], -32602)
        self.assertEqual(self.server.handle({"id": 1, "method": "ping"})["error"]["code"], -32600)
        self.assertIsNone(self.server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        self.assertEqual(self.rpc("ping")["result"], {})

    def test_serve_reads_lines(self):
        lines = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "user_list"}},
        ]
        data = "".join(json.dumps(m) + "\n" for m in lines).encode() + b"\n{not json\n"
        out = io.StringIO()
        self.assertEqual(serve(io.BytesIO(data), out, server=self.server), 0)
        answers = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertEqual([a.get("id") for a in answers], [1, 2, None])
        self.assertEqual(answers[1]["result"]["structuredContent"]["users"][0]["name"], "mrossi")
        self.assertEqual(answers[2]["error"]["code"], -32700)

    def test_tool_names_are_valid(self):
        import re
        for name in tools(OPERATIONS):
            self.assertRegex(name, re.compile(r"^[a-z_]{1,64}$"))


if __name__ == "__main__":
    unittest.main()
