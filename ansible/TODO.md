# TODO

Open items, highest priority first. Each entry states the problem, why it
matters and where to start.

## 1. `enable`, `disable` and `setprimarygroup` create the account instead of failing

`roles/samba_tool/tasks/user.yaml:44` maps every non read-only action other
than `delete`/`absent` to `state: present`:

```yaml
state: "{{ 'absent' if samba_tool_action in ['delete', 'absent'] else 'present' }}"
```

`samba_tool_user` with `state: present` creates a missing user, so a typo in
`samba_tool_args.name` while disabling an account silently provisions a new one
with `--random-password` and then disables it. `enable` leaves behind an
*enabled* account with a password nobody knows. The mistake is invisible: the
task reports `changed`, which is exactly what the operator expects to see.

Acceptable for `setpassword` (a password is supplied anyway), wrong for the
other three.

Fix: only `create`/`present` should imply `state: present`. The remaining
actions need to fail when the user does not exist — either a new module
parameter (`create_missing: false`, or a dedicated state) or a preliminary
`samba-tool user show` guard in the role.

## 2. `show()` reports "user does not exist" for any samba-tool failure

`plugins/modules/samba_tool_user.py:248` treats every non-zero return code as
absence:

```python
rc, out, err = self.module.run_command(cmd)
if rc != 0:
    return None
```

If `samba-tool` fails for another reason — missing `become`, `sam.ldb` not
readable, domain not provisioned yet — the module goes on to `user create` and
the operator gets a creation error instead of the real cause. Related to item 1:
the two together turn a permission problem into an unexpected account.

Fix: distinguish "no such user" from a genuine failure. `samba-tool user show`
returns a specific message on stderr for an unknown user; anything else should
reach `fail_json` with `rc`, `stdout` and `stderr` attached.

## 3. An empty `dn` can reach `ldbmodify`

`plugins/modules/samba_tool_user.py:424`: after creating a user, the DN is read
back with a second `user.show()`. When that read returns nothing, `dn` stays
`""` and `set_primary_group()` (line 303) still builds the LDIF:

```
dn: 
changetype: modify
replace: primaryGroupID
```

`ldbmodify` then fails with a parse error that says nothing about the cause.

Fix: fail explicitly before calling `ldbmodify` when the DN could not be
resolved, naming the user.

## 4. `RETURN` documents `commands` as conditional

`plugins/modules/samba_tool_user.py:162` declares `returned: changed`, but both
`exit_json()` calls return `commands` unconditionally (it is an empty list when
nothing ran). Documentation only, but it is what users read.

## 5. Decide the fate of the sanity ignore files below the supported floor

`meta/runtime.yml` now declares `requires_ansible: ">=2.19.0"`, while
`tests/sanity/` still carries `ignore-2.16.txt`, `ignore-2.17.txt` and
`ignore-2.18.txt`. They are not dead — `ansible-test` does not enforce
`requires_ansible`, so anyone on an older core can still run sanity — but they
are never exercised by CI and will rot unnoticed.

Keep them as a courtesy, or delete them so the repository declares one
supported range only. A decision either way, not a bug.
