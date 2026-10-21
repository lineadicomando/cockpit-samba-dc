---
name: vm-lab
description: Test VMs of cockpit-samba-dc (a Samba AD DC and a Windows client on libvirt). Use before starting, stopping, reverting or snapshotting them, deploying the module to the DC, running commands on the DC or the client over SSH, rebuilding them, or testing a change against a real DC.
---

# Test VMs

Two libvirt VMs, both dedicated to this project, described by `.env` (copy
of `.env.example`, not tracked): a Debian 13 Samba AD DC (`DC_*`, domain
`DOMAIN_REALM`) and a Windows 11 client joined to it (`WIN_*`). Everything
goes through `test/vm/lab.sh`, which reads `.env`; run it from the
repository root.

```
test/vm/lab.sh status                 # state and snapshots of both VMs
test/vm/lab.sh reset                  # both back to lab_baseline, shut off
test/vm/lab.sh resources dc win       # would they fit on the host now?
test/vm/lab.sh start dc               # refuses when the host is short
test/vm/lab.sh wait dc                # until SSH answers
test/vm/lab.sh deploy                 # build, install in /usr/share/cockpit/samba-dc
test/vm/lab.sh root 'samba-tool user list' </dev/null
test/vm/lab.sh ssh win 'Get-ComputerInfo -Property CsDomain'
test/vm/lab.sh stop win
```

## Snapshots

| Snapshot | VM | State |
|---|---|---|
| `baseline` | DC | Debian with its own name, address, machine-id and SSH keys; no Samba |
| `samba_baseline` | DC | domain provisioned, test accounts, module not installed; no client account |
| `lab_baseline` | DC and client | as `samba_baseline`, plus the client joined to the domain; no user profiles |

Start a test from `lab.sh reset`. Revert the two VMs together: the DC holds
the client's machine account, so a DC reverted alone loses the trust (the
client's logons fail until it is joined again).

Test accounts in the baseline: groups `Teachers` (`teacher1`) and `Students`
(`student1`, `student2`), password `DOMAIN_TEST_PASSWORD`; `Administrator`
with `DOMAIN_ADMIN_PASSWORD`. Passwords do not expire.

## Rules

- **Check resources before every start.** `start` does it, but when more
  VMs are needed (the client needs the DC), run `resources dc win` first. If
  they do not fit, say so to the user instead of starting fewer silently.
  Shut down what you started when the test is over.
- **Passwords stay in `.env`.** Scripts pass them to `sshpass -e`, `sudo -S`
  and the guests through the environment and stdin; never print them, write
  them elsewhere, or put them in argv. When a command reads a password on
  stdin, feed it with `printf '%s\n' "$VAR" |` after `. test/vm/env.sh`
  (`printf` is a shell builtin, so the value is not in any argv).
- **Snapshots.** Reverting to this project's snapshots and taking new ones
  is part of the normal workflow. Deleting a snapshot, or creating, cloning
  or deleting a VM, needs the user's agreement.
- **Test data** (users, groups, shares) gets a recognisable prefix such as
  `t-`, and is removed afterwards, or the VMs are reset. Never touch the
  built-in objects.

## Workflow for a change in `src/lib/`

1. `make check` and `npx tsc --noEmit` pass locally.
2. `lab.sh reset`, `start dc`, `wait dc`, `deploy`.
3. Exercise the change on the DC: through the commands the module runs
   (`lab.sh root …`), and in the interface through the tunnel
   (`lab.sh tunnel` in the background, then `http://127.0.0.1:9091`, login
   with `DC_ADMIN_USER`). The page is the iframe `cockpit1:localhost/samba-dc`.
4. Anything a Windows client sees (share access, mapped drives, the H:
   drive): `resources win`, `start win`, `wait win`, then a domain logon in
   the GUI (skill `win-gui`). Mapped drives and `homeDrive` apply only at an
   interactive logon, not over SSH.
5. Check what the module wrote: `net conf list`, `getfacl -R`, `ldbsearch -H
   /var/lib/samba/private/sam.ldb …`, `samba-tool ntacl sysvolcheck`.
6. Stop the VMs (or `reset`), and report what was tested and what was not.

## The interface in the browser tools

No password may go into a browser tool call (it would end up in the
conversation). Log in with `curl` and hand the browser only the session
cookie, through a file:

```bash
. test/vm/env.sh && umask 077
printf 'user = "%s:%s"\n' "$DC_ADMIN_USER" "$DC_ADMIN_PASSWORD" |
    curl -s -K - -c /tmp/cockpit-jar -o /dev/null http://127.0.0.1:9091/cockpit/login
awk '$6=="cockpit" {printf "document.cookie = \"cockpit=%s; path=/\"; void 0;\n", $7}' /tmp/cockpit-jar > /tmp/cockpit-cookie.js
rm /tmp/cockpit-jar
```

Then open `http://127.0.0.1:9091/cockpit/login` in an isolated context, run
`evaluate_script` with `sourcePath: /tmp/cockpit-cookie.js` (the script must
end in `void 0`, or its value, the cookie, is echoed back), and navigate to
`http://127.0.0.1:9091/samba-dc`.

A session opened this way has no stored password, so Cockpit cannot switch
to administrative access by itself. For the test only, drop in
`/etc/sudoers.d/t-cockpit-test` with `DC_ADMIN_USER ALL=(ALL) NOPASSWD: ALL`
(mode 440, `visudo -cf`), click "Accesso limitato", and remove the file
afterwards (`reset` removes it too). At the end: log out ("Sessione" →
"Esci"), close the page, delete `/tmp/cockpit-cookie.js`.

## Notes

- `pgrep -f` / `pkill -f` match the shell that runs them when the pattern is
  in its own command line: write the pattern as `[s]amba-tool …`.

- `root` runs the command with `sh -c` under `sudo`; the password is the
  first line of its stdin, the rest of stdin reaches the command (`tar -cf -
  … | lab.sh root 'tar -xf - …'`). With nothing to pass, give it `</dev/null`.
- SSH skips host key checks: the VMs are rebuilt and reverted, their keys
  change.
- On the client, SSH lands in PowerShell as the local administrator. A
  command that changes the network drops the session: run it as a SYSTEM
  task (see `build-win.sh`).
- `qga.py VM [--stdin] CMD…` runs a command in the DC through the guest
  agent, with no network (the Windows client has no agent).
- `deploy` also removes copies in users' `~/.local/share/cockpit` and under
  the pre-rename name `samba-ad-dc`, which would shadow the installed one.
  Compare the two checksums it prints; then reload the Cockpit page (F5).
- Wait for a condition, not a fixed time: `until lab.sh ssh win '…' | grep
  -q …; do sleep 5; done`.

## Rebuilding

Only with the user's agreement (it creates VMs). The scripts record how the
current VMs were made:

- `test/vm/build-dc.sh BASE_VM`: clone of a shut-off Debian 13 VM with the
  guest agent; identity and address through `dc-base.sh` (guest agent), then
  `provision-dc.sh` (Samba, Cockpit, domain, test accounts). Snapshots
  `baseline` and `samba_baseline`.
- `test/vm/build-win.sh SOURCE_VM SOURCE_DISK SOURCE_IP`: copy of a clean
  Windows 11 disk with the admin account and OpenSSH, hardware from
  `SOURCE_VM` (`winxml.py`); new address and DNS, joined with the new name.
  Snapshot `lab_baseline` of both VMs.

The Windows client runs an Enterprise Evaluation: when it expires
(`slmgr /dlv`), it is rebuilt from a fresh image.
