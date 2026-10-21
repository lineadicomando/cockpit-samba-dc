#!/usr/bin/env python3
"""Turns the libvirt XML of a Windows VM (stdin) into the one of a copy:
    winxml.py NAME MAC DISK NVRAM < source.xml > copy.xml
Same hardware (UEFI, TPM, devices); own name, UUID, MAC, disk and NVRAM;
2 vCPU and 4 GiB."""
import re
import sys

name, mac, disk, nvram = sys.argv[1:]
s = sys.stdin.read()
s = re.sub(r"<name>.*?</name>", f"<name>{name}</name>", s, count=1)
s = re.sub(r"\s*<uuid>.*?</uuid>", "", s, count=1)
s = re.sub(r"<(memory|currentMemory) unit='KiB'>\d+<", r"<\1 unit='KiB'>4194304<", s)
s = re.sub(r"<vcpu placement='static'>\d+<", "<vcpu placement='static'>2<", s)
s = re.sub(r"\s*<topology[^>]*/>", "", s)
s = re.sub(r"<mac address='[^']+'/>", f"<mac address='{mac}'/>", s)
s = re.sub(r"(<nvram[^>]*>)[^<]*(</nvram>)", rf"\g<1>{nvram}\g<2>", s)
# The inactive XML of a VM with external snapshots points at the overlay
s = re.sub(r"\s*<backingStore.*?</backingStore>", "", s, flags=re.S)
s = re.sub(r"(<disk type='file' device='disk'>.*?<source file=')[^']+", rf"\g<1>{disk}", s, count=1, flags=re.S)
sys.stdout.write(s)
