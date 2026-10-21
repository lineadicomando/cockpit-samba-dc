#!/usr/bin/env python3
"""Types text into a VM through "virsh send-key".

    type.py VM TEXT [--enter]
    type.py VM --secret VAR [--enter]

--secret types the value of VAR from the environment or from .env, and never
prints it. The guest keyboard layout comes from WIN_KEYMAP (it or us).
"""
import os
import subprocess
import sys
import time
from pathlib import Path

S, G = "KEY_LEFTSHIFT", "KEY_RIGHTALT"


def base_map() -> dict[str, list[str]]:
    m: dict[str, list[str]] = {" ": ["KEY_SPACE"]}
    for c in "abcdefghijklmnopqrstuvwxyz":
        m[c] = [f"KEY_{c.upper()}"]
        m[c.upper()] = [S, f"KEY_{c.upper()}"]
    for c in "1234567890":
        m[c] = [f"KEY_{c}"]
    return m


def layout_it() -> dict[str, list[str]]:
    m = base_map()
    for c, k in zip('!"£$%&/()=', "1234567890"):
        m[c] = [S, f"KEY_{k}"]
    m.update({
        "'": ["KEY_MINUS"], "?": [S, "KEY_MINUS"], "ì": ["KEY_EQUAL"], "^": [S, "KEY_EQUAL"],
        "è": ["KEY_LEFTBRACE"], "é": [S, "KEY_LEFTBRACE"], "[": [G, "KEY_LEFTBRACE"], "{": [G, S, "KEY_LEFTBRACE"],
        "+": ["KEY_RIGHTBRACE"], "*": [S, "KEY_RIGHTBRACE"], "]": [G, "KEY_RIGHTBRACE"], "}": [G, S, "KEY_RIGHTBRACE"],
        "ò": ["KEY_SEMICOLON"], "ç": [S, "KEY_SEMICOLON"], "@": [G, "KEY_SEMICOLON"],
        "à": ["KEY_APOSTROPHE"], "°": [S, "KEY_APOSTROPHE"], "#": [G, "KEY_APOSTROPHE"],
        "ù": ["KEY_BACKSLASH"], "§": [S, "KEY_BACKSLASH"], "\\": ["KEY_GRAVE"], "|": [S, "KEY_GRAVE"],
        ",": ["KEY_COMMA"], ";": [S, "KEY_COMMA"], ".": ["KEY_DOT"], ":": [S, "KEY_DOT"],
        "-": ["KEY_SLASH"], "_": [S, "KEY_SLASH"], "<": ["KEY_102ND"], ">": [S, "KEY_102ND"],
    })
    return m


def layout_us() -> dict[str, list[str]]:
    m = base_map()
    for c, k in zip("!@#$%^&*()", "1234567890"):
        m[c] = [S, f"KEY_{k}"]
    for plain, shifted, key in [("-", "_", "MINUS"), ("=", "+", "EQUAL"), ("[", "{", "LEFTBRACE"),
                                ("]", "}", "RIGHTBRACE"), (";", ":", "SEMICOLON"), ("'", '"', "APOSTROPHE"),
                                ("`", "~", "GRAVE"), ("\\", "|", "BACKSLASH"), (",", "<", "COMMA"),
                                (".", ">", "DOT"), ("/", "?", "SLASH")]:
        m[plain] = [f"KEY_{key}"]
        m[shifted] = [S, f"KEY_{key}"]
    return m


def dotenv(name: str) -> str | None:
    if name in os.environ:
        return os.environ[name]
    env = Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key == name:
                return value
    return None


def main() -> None:
    args = sys.argv[1:]
    enter = "--enter" in args
    args = [a for a in args if a != "--enter"]
    secret = len(args) == 3 and args[1] == "--secret"
    if len(args) != 2 and not secret:
        sys.exit(__doc__)
    vm = args[0]
    if secret:
        text = dotenv(args[2])
        if not text:
            sys.exit(f"{args[2]} is not set in the environment or in .env")
    else:
        text = args[1]
    layouts = {"it": layout_it, "us": layout_us}
    name = dotenv("WIN_KEYMAP") or "it"
    if name not in layouts:
        sys.exit(f"unknown WIN_KEYMAP {name!r} (it or us)")
    keys = layouts[name]()
    missing = sorted({c for c in text if c not in keys})
    if missing:
        # Never echo a secret's characters
        sys.exit("characters without a key in the layout" + ("" if secret else f": {''.join(missing)!r}"))
    uri = dotenv("LIBVIRT_DEFAULT_URI") or "qemu:///system"
    for c in text:
        subprocess.run(["virsh", "-c", uri, "send-key", vm, *keys[c]], stdout=subprocess.DEVNULL, check=True)
        time.sleep(0.08 if secret else 0.03)
    if enter:
        subprocess.run(["virsh", "-c", uri, "send-key", vm, "KEY_ENTER"], stdout=subprocess.DEVNULL, check=True)
    if secret:
        print("typed")


if __name__ == "__main__":
    main()
