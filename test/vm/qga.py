#!/usr/bin/env python3
"""Runs a command in a VM through the QEMU guest agent, with no network.

    qga.py VM [--stdin] COMMAND [ARG...]

--stdin passes this script's stdin to the command (e.g. "user:password" for
chpasswd). virsh gets its commands on stdin, not in argv, so data sent this
way never shows in a process list of the host.
"""
import base64
import json
import os
import subprocess
import sys
import time


def qga(vm: str, uri: str, obj: dict) -> dict:
    # The JSON goes in single quotes for virsh's parser: escape the quotes
    # themselves, which JSON allows as \u0027.
    cmd = json.dumps(obj).replace("'", "\\u0027")
    out = subprocess.run(["virsh", "-c", uri], input=f"qemu-agent-command {vm} --cmd '{cmd}'\n",
                         capture_output=True, text=True)
    # Interactive virsh also prints a banner and prompts: keep the JSON line
    lines = [l for l in out.stdout.splitlines() if l.startswith("{")]
    if out.returncode or not lines:
        sys.exit(out.stderr.strip() or "no answer from the guest agent")
    return json.loads(lines[-1])["return"]


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    vm, args = args[0], args[1:]
    use_stdin = args[0] == "--stdin"
    if use_stdin:
        args = args[1:]
    uri = os.environ.get("LIBVIRT_DEFAULT_URI", "qemu:///system")
    spec = {"path": args[0], "arg": args[1:], "capture-output": True}
    if use_stdin:
        spec["input-data"] = base64.b64encode(sys.stdin.buffer.read()).decode()
    pid = qga(vm, uri, {"execute": "guest-exec", "arguments": spec})["pid"]
    while True:
        st = qga(vm, uri, {"execute": "guest-exec-status", "arguments": {"pid": pid}})
        if st["exited"]:
            break
        time.sleep(0.5)
    sys.stdout.write(base64.b64decode(st.get("out-data", "")).decode(errors="replace"))
    sys.stderr.write(base64.b64decode(st.get("err-data", "")).decode(errors="replace"))
    sys.exit(st.get("exitcode", 0))


if __name__ == "__main__":
    main()
