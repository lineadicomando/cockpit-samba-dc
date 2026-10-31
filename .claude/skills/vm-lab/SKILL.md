---
name: vm-lab
description: Test VMs of cockpit-samba-dc (a Samba AD DC and a Windows client on libvirt). Use before starting, stopping, reverting or snapshotting them, deploying the module to the DC, running commands on the DC or the client over SSH, rebuilding them, or testing a change against a real DC.
---

# Test VMs

Two libvirt VMs, both dedicated to this project, on a NAT network of their
own (`cockpit-samba`, `192.168.142.0/24`): a Debian 13 Samba AD DC (`DC_*`,
domain `DOMAIN_REALM`) and a Windows 11 client joined to it (`WIN_*`). Names,
addresses and sizes are in `test/vm/lab.conf` (tracked); the passwords and
the Windows ISO in `.env` (copy of `.env.example`, not tracked), which may
override `lab.conf`, and `.env.<host name>` overrides both on one
workstation. Everything goes through `test/vm/lab.sh`; run it from the
repository root. Both VMs are built from scratch by the scripts (see
"Building").

```
test/vm/lab.sh status                 # the network, state and snapshots of both VMs
test/vm/lab.sh reset                  # both back to lab_baseline, shut off
test/vm/lab.sh resources dc win       # would they fit on the host now?
test/vm/lab.sh start dc               # refuses when the host is short
test/vm/lab.sh wait dc                # until SSH answers
test/vm/lab.sh deploy                 # make deb, install addcctl and cockpit-samba-dc on the DC
test/vm/lab.sh root 'samba-tool user list' </dev/null
test/vm/lab.sh ssh win 'Get-ComputerInfo -Property CsDomain'
test/vm/lab.sh stop win
test/vm/lab.sh ansible PLAYBOOK [ARGS]  # the collection of this tree against the VMs
test/vm/lab.sh mcp                    # the collection's MCP server (stdio) against the VMs
```

## Snapshots

| Snapshot | VM | State |
|---|---|---|
| `baseline` | DC | Debian from the netinst installer, static address, `DC_ADMIN_USER` with sudo; no Samba |
| `baseline` | client | Windows 11 Enterprise Evaluation, `WIN_ADMIN_USER`, OpenSSH Server; not joined |
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

## The Ansible collection against the VMs

`lab.sh ansible` runs `ansible-playbook` with an inventory written from
`.env` (groups `samba_dc`, host `dc`, with the `samba_dc_build_*` variables
of the test domain; `windows`, host `win`, with `win_workman_domain_*`) and
the collection of `ansible/` in this working tree. The passwords stay in the
environment (`lookup('env')`).

```
test/vm/lab.sh revert dc baseline && test/vm/lab.sh start dc
test/vm/lab.sh ansible test/vm/samba_dc_build.yaml          # build the DC from scratch
test/vm/lab.sh ansible lineadicomando.samba_dc.samba \
    -e '{"samba_tool_object":"share","samba_tool_action":"list"}'
```

`lab.sh mcp` starts the collection's MCP server (`ansible/mcp/server.py`)
with the same inventory, for an MCP client that runs it from the repository
root (e.g. the MCP Python SDK: `StdioServerParameters(command=
"test/vm/lab.sh", args=["mcp"])`). Until v0.9.0 is released, a build needs
the local packages: `make deb`, then `"args": {"cockpit_package_files":
[…/build/*.deb]}`.

`addcctl mcp` on the DC is reached as in the README ("MCP server on the
DC"): a `t-` user with the sudoers rule and a key bound to the command.

A DC built this way has a new domain: the client's machine account is not
in it. Revert both VMs (`reset`) when done.

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
5. The integration suite: `test/vm/run-lib.sh test/vm/integration.ts`
   (optionally `core`, `page`, `ansible`, `mcp`), a few minutes (the domain
   steps run `dbcheck` and an offline backup); it removes its `t-x-`,
   `t-p-`, `t-a-`, `t-m-` data. Before a release, and after a change to
   `core/`. It drives `addcctl mcp` over SSH with `sudo -S` as
   `DC_ADMIN_USER`, and expects the domain of `lab.conf`, the test accounts
   of the baseline and `smbclient` on the DC: a DC made by the page or by
   `samba_dc_build` needs them added first, as `provision-dc.sh` does.
   The snapshot `baseline` has no Samba and no Cockpit web server: after
   `deploy`, `apt-get install --no-install-recommends cockpit-ws
   cockpit-system` gives the setup page on a minimal Cockpit.
6. Check what the module wrote: `net conf list`, `getfacl -R`, `ldbsearch -H
   /var/lib/samba/private/sam.ldb …`, `samba-tool ntacl sysvolcheck`.
7. Stop the VMs (or `reset`), and report what was tested and what was not.

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

Then open a page that sets no cookie, such as
`http://127.0.0.1:9091/cockpit/static/none.txt`, in a new isolated context
(the login page sets an HttpOnly `cockpit` cookie that a script cannot
overwrite), run `evaluate_script` with `sourcePath: /tmp/cockpit-cookie.js`
(the script must end in `void 0`, or its value, the cookie, is echoed back),
and navigate to `http://127.0.0.1:9091/samba-dc`. Do it within a few seconds
of the `curl` login: Cockpit closes a session that no page has connected to
after about 15 seconds. Adding `location.href = "/samba-dc";` before `void 0`
saves a step.

A session opened this way has no stored password, so Cockpit cannot switch
to administrative access by itself. For the test only, drop in
`/etc/sudoers.d/t-cockpit-test` with `DC_ADMIN_USER ALL=(ALL) NOPASSWD: ALL`
(mode 440, `visudo -cf`), click "Accesso limitato", and remove the file
afterwards (`reset` removes it too). The page reads again by itself when
the access changes. At the end: log out ("Sessione" → "Esci"), close the
page, delete `/tmp/cockpit-cookie.js`.

- The module's page is the iframe's `contentDocument`
  (`[...document.querySelectorAll("iframe")].find(f =>
  f.src.includes("samba-dc"))`). The hidden tabs' tables are in the DOM
  too: pick the visible one by its `aria-label`, or keep elements with an
  `offsetParent`. Lists show 10 rows a page: filter by name before looking
  for a test row.
- A password goes into a field through a script written to a private file
  from `.env`, run with `evaluate_script`'s `sourcePath`, then deleted.
  `PasswordField`'s id is on its `<input>` (`#setup-password`).
- When the chrome-devtools MCP is held by another session ("browser is
  already running"): a headless `google-chrome --remote-debugging-port`
  with a profile of its own, driven through CDP by a short Node script,
  the cookie set with `Network.setCookie`.

## Notes

- `pgrep -f` / `pkill -f` match the shell that runs them when the pattern is
  in its own command line: write the pattern as `[s]amba-tool …`.

- `root` runs the command with `sh -c` under `sudo`, and gives sudo the
  password itself: what you pipe into `lab.sh root` reaches the command
  as it is (`tar -cf - … | lab.sh root 'tar -xf - …'`). Never put a
  password in front of it: the command would read it as data. With nothing
  to pass, give it `</dev/null`.
- SSH skips host key checks: the VMs are rebuilt and reverted, their keys
  change.
- On the client, SSH lands in PowerShell as the local administrator. A
  command that changes its address drops the session: run it as a SYSTEM
  task. Its address comes from the network's DHCP, reserved for its MAC; its
  DNS server is the DC, set at the join.
- `qga.py VM [--stdin] CMD…` runs a command in the DC through the guest
  agent, with no network (the Windows client has no agent).
- `deploy` builds the Debian packages (`make deb`, a podman container) and
  installs both, `addcctl` and `cockpit-samba-dc`, with apt, which also replaces a copy made by hand; it removes
  copies in users' `~/.local/share/cockpit` and under the pre-rename name
  `samba-ad-dc`, which would shadow the installed one.
  Compare the two checksums it prints; then reload the Cockpit page (F5).
- Wait for a condition, not a fixed time: `until lab.sh ssh win '…' | grep
  -q …; do sleep 5; done`.

## Building

Only with the user's agreement (it creates VMs). From nothing but the
Windows ISO in `.env`, about an hour in all:

```
test/vm/lab.sh build dc       # ~15 min: Debian, then Samba (baseline, samba_baseline)
test/vm/lab.sh build win      # 30-60 min, in the background: Windows, then the join (baseline, lab_baseline of both)
test/vm/lab.sh rebuild dc     # destroy, then build; also win
test/vm/lab.sh destroy win    # the VM with its disk, NVRAM, TPM and snapshots (never the ISO)
```

- `build dc` (`build-dc.sh`): the lab's network (`lab.sh net`), then
  `virt-install --location` on the Debian installer of the mirror (or
  `DEBIAN_ISO`), driven by `preseed.cfg` (rendered by `render.py` into a
  private directory: it holds the password's hash); `dc-base.sh` lays out
  the network as `samba_dc_build` writes it; then `provision-dc.sh`
  (Samba, Cockpit, the domain, the test accounts).
- `build win` (`build-win.sh`): Windows Setup from `WIN_ISO` with
  `win/autounattend.xml` (rendered with the password into a private
  directory, uploaded to the pool, deleted at the end), Secure Boot, TPM 2.0,
  SATA disk and e1000e NIC; `win/setup.ps1` at the first logon installs
  OpenSSH Server. Then the DC at `samba_baseline`, the client's DNS pointed
  at it, `Add-Computer`. Needs the DC built, and memory for both VMs at the
  join.
- When an unattended Windows build stops, look at its screen (`virt-viewer`,
  or skill `win-gui`); `setup.ps1` logs to
  `C:\Windows\Temp\cockpit-samba-setup.log`.

The Windows client runs an Enterprise Evaluation of 90 days (`build win`
prints the end date, also in the snapshot's description). Rebuild it then,
from a freshly downloaded ISO; do not rearm or work around it.
