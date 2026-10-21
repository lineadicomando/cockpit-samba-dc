---
name: win-gui
description: Operate the graphical interface of the Windows test VM from the host through virsh (screenshots, mouse, keyboard, logon with the passwords in .env). Use when a test needs what only an interactive session shows, such as drives mapped by Group Policy, the H: home drive, or access to a share in File Explorer.
---

# Windows GUI through virsh

Nothing is installed in the guest: the screen comes from `virsh screenshot`,
the keyboard from `virsh send-key`, the mouse from the QMP command
`input-send-event` on the VM's USB tablet (absolute axes, 0 to 32767).

```bash
. test/vm/gui.sh          # VM defaults to WIN_VM from .env
shot login                # prints /tmp/vmshot/login.png (WxH); Read it
click 640 400             # pixels of the last screenshot
key KEY_LEFTMETA KEY_R    # keys pressed together
typ 'explorer.exe' --enter
secret WIN_ADMIN_PASSWORD --enter
```

Each Bash call is a new shell: source `gui.sh` in every command that uses
it, e.g. `. test/vm/gui.sh && click 640 400 && sleep 2 && shot after`.

## Rules

- **Screenshot before every click** and read it: coordinates change with the
  window position, the resolution, or a dialog that appeared. Take another
  after the action to confirm it worked.
- **Passwords only through `secret VAR`.** The user has given permanent
  permission to read the passwords in `.env` and type them into these VMs'
  logon screens and dialogs. Never print them, write them elsewhere or put
  them in a command line. The permission covers this project's VMs and the
  accounts in `.env` only.
- `typ` maps characters through the guest layout (`WIN_KEYMAP`); it refuses
  characters with no key rather than typing something else.

## Recipes

- **Logon.** The first key only lifts the lock screen: `key KEY_ENTER`, wait
  3 seconds, `shot`. The last local user (`maint`) is offered; for a domain
  account pick "Altro utente" (bottom left, about 133,743 at 1280x800), where
  the user name field has the focus and the default domain is shown
  ("Accedi a: SAMBATEST"): `typ 'SAMBATEST\student1'`, `key KEY_TAB`, `secret
  DOMAIN_TEST_PASSWORD --enter`. The first logon of a user creates the
  profile ("Quasi fatto.") and takes about a minute: wait for the user's
  Explorer over SSH rather than a fixed time:
  `until lab.sh ssh win '(Get-Process explorer -IncludeUserName -EA 0 | ? UserName -like "*student1").Count' | grep -q '^[1-9]'; do sleep 5; done`.
  The Start menu may be open on the new desktop: `key KEY_ESC`.
- **Log off** (needed to see new drive mappings): over SSH, `logoff ID` with
  the session ID listed by `quser`; or `key KEY_LEFTCTRL KEY_LEFTALT
  KEY_DELETE` and the "Disconnetti" item. Remove a test user's profile
  afterwards: `Get-CimInstance Win32_UserProfile | ? LocalPath -like
  "*student1*" | Remove-CimInstance` (or `lab.sh reset`).
- **Group Policy.** Over SSH, `gpupdate /force` refreshes policies, but
  drive maps apply at the next logon. `gpresult /r /scope user` (in the
  user's session) lists the applied GPOs.
- **Mapped drives.** File Explorer (`key KEY_LEFTMETA KEY_E`), "This PC":
  the drives show with their label and letter. In a terminal of the session,
  `net use` lists them with their UNC paths.
- **Browser.** `url ADDRESS NAME` focuses the address bar, types, presses Del
  (otherwise Edge completes from the history) and Enter, then takes a shot.
