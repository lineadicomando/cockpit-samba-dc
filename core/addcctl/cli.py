# SPDX-License-Identifier: LGPL-2.1-or-later
"""addcctl OBJECT ACTION [--check] < input.json

Reads a JSON object on stdin (none from a terminal: {}), writes a JSON
object on stdout. A mutation reports "changed" and "commands" (what it did,
or would do with --check). On error the output is {"error": message}, the
message also goes to stderr, and the exit code is 1.

  addcctl schema    the operations and the JSON Schema of their input
"""
import argparse
import contextlib
import fcntl
import json
import os
import sys

from .dc import Dc
from .errors import AddcError
from .operations import OPERATIONS, schemas
from .runner import Runner
from .schema import errors as schema_errors

LOCK = "/run/lock/addcctl.lock"


class Context:
    def __init__(self, check):
        self.runner = Runner(check)
        self.dc = Dc(self.runner)


@contextlib.contextmanager
def _lock(path=LOCK):
    """One mutation at a time on the DC: the drive-mapping GPO is read,
    edited and written back, and two writers would lose an update."""
    with open(path, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _emit(obj, stream=None):
    (stream or sys.stdout).write(json.dumps(obj, ensure_ascii=False, sort_keys=True) + "\n")


def _fail(message, code=1):
    _emit({"error": message})
    sys.stderr.write(message + "\n")
    return code


def run(argv, stdin):
    parser = argparse.ArgumentParser(prog="addcctl", description="Operations of a Samba AD DC, as JSON.")
    parser.add_argument("object")
    parser.add_argument("action", nargs="?")
    parser.add_argument("--check", action="store_true", help="report what would change, change nothing")
    args = parser.parse_args(argv)

    if args.object == "schema" and args.action is None:
        _emit(schemas())
        return 0
    op = OPERATIONS.get((args.object, args.action))
    if op is None:
        known = ", ".join("%s %s" % key for key in sorted(OPERATIONS))
        return _fail("Unknown operation %s %s (known: schema, %s)" % (args.object, args.action or "", known), 2)

    raw = "" if stdin.isatty() else stdin.read()
    try:
        request = json.loads(raw) if raw.strip() else {}
    except ValueError as e:
        return _fail("The input is not JSON: %s" % e, 2)
    problems = schema_errors(op["input"], request)
    if problems:
        return _fail("Invalid input: %s" % "; ".join(problems), 2)

    ctx = Context(args.check)
    try:
        if op["mutates"] and not args.check:
            with _lock():
                result = op["run"](ctx, request)
        else:
            result = op["run"](ctx, request)
    except AddcError as e:
        return _fail(str(e))
    if op["mutates"]:
        result = dict(result, commands=ctx.runner.commands, check=args.check)
    _emit(result)
    return 0


def main():
    if os.geteuid() != 0 and "schema" not in sys.argv[1:2]:
        sys.exit(_fail("addcctl runs as root: it reads sam.ldb and changes the DC"))
    sys.exit(run(sys.argv[1:], sys.stdin))
