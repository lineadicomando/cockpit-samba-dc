# History

The sections of `TODO.md` that are done, moved here once released: what each
one did, the decisions taken with their dates, the measures, and what was
found while trying it on the test DC. A record, not needed to resume work
(`TODO.md` is): paths and names are as they were then, and the code is the
reference. The version at the end of a heading is the release that carried
it; `[?]` items left there are listed again, open, in `TODO.md` ("Left out").

Order of the work: A1–A6 (one project around a shared core,
`docs/architecture.md`), then sections 8, 4, 5, 6, 7 (v0.10.0–v0.14.0), 0
(v0.15.0), 9 (v0.16.0), 10 (v0.17.0); sections 1–3 predate the core.

## A1. Windows roles and lab defaults out of the collection (done)

In `ansible-collection-win_workman`, `ansible-collection-samba_dc` and
`ansible-win_edulab`; nothing changes in this repository.
`docs/architecture.md`, "Boundaries".

- [x] **win_workman: a `domain` management role** merging `samba_win_join`
      and `samba_win_status`, as win_workman's `CLAUDE.md` asks (schema in
      `vars/`, `act_join`, `act_leave`, `act_status`, default `status`,
      `meta/mcp.yaml`, docs and catalog rows); variables
      `win_workman_domain_*`; the DNS step of win_edulab's
      `playbooks/samba_dc_join.yaml` moves into `act_join`
      (`win_workman_domain_dns_servers`); dependency `microsoft.ad`
- [x] Try it on this project's Windows client with the test DC (skill
      `vm-lab`): status, leave (the computer account is disabled, not
      deleted), join again, secure channel verified (`nltest /sc_verify`);
      win_edulab's `samba_dc_join.yaml` idempotent on the joined client
- [x] **win_edulab**: `samba_dc_join.yaml` and the `samba_win_join_*`
      variables become the task `domain-join` and `win_workman_domain_*`;
      membership status through the win-workman MCP; its skills and docs
- [x] **The collection**: remove the two roles,
      `playbooks/samba_win_status.yaml`, the `samba_win_status` MCP tool and
      the dependencies `microsoft.ad` and `ansible.windows`; the MCP
      `inventory` no longer defaults to `school` (named by the call, or by
      `ANSIBLE_MCP_DEFAULT_INVENTORY` or `ANSIBLE_MCP_INVENTORY` in the
      server's environment); no `lab_win` fallback; examples with
      neutral group names; README and `galaxy.yml` describe what the
      Cockpit page does (no DNS or service controls)
- [x] Releases of win_workman (v0.3.0) and of the collection (v0.7.0, which
      also carries the untagged 0.6.0); win_edulab pinned to both tags
      instead of `main`; CI green on both collections

## A2. The collection in this repository (done) — v0.8.0

The first release with the collection is 0.8.0 for both: the collection was
at 0.7.0, the Cockpit page at 0.2.1, and one version may not go back
(`make release VERSION=0.8.0`).

- [x] Carry over the collection's open `TODO.md` items (the
      `samba_tool_user` bugs, the sanity ignore files) into section 0; it
      had no change since its tag v0.7.0
- [x] `git subtree add --prefix=ansible` of the collection at v0.7.0, with
      its history; `ansible/galaxy.yml` stays at the collection root
- [x] One version: `make release` writes it into `ansible/galaxy.yml`,
      `release.mjs verify` checks it, `release.yml` builds the collection
      tarball (`ansible-galaxy collection build ansible`) and attaches it.
      Not published on Ansible Galaxy for now (to reconsider when the
      project is more mature). It also writes it into the release that
      `samba_dc_build` installs (`scripts/collection.mjs`)
- [x] CI: the collection's jobs (ansible-lint, `ansible-test sanity` and
      `units`, which need an `ansible_collections/lineadicomando/samba_dc`
      path) next to the existing ones
- [x] `samba_dc_build` installs the Cockpit page from the release of its own
      version, checksum verified: `samba_dc_build_cockpit_install: package`
      (default), `source` (a git revision built on the DC, for development)
      or `none`; an optional URL or local path for sites without Internet
      access; it removes the working copy `/usr/local/src/cockpit-samba-dc`
- [x] Docs: a README section on the collection (installed from
      `git+https://github.com/lineadicomando/cockpit-samba-dc.git#/ansible/`
      with `version: vX.Y.Z`, tried with `ansible-galaxy`); `ansible/README.md` for
      Galaxy; the collection's rules in `CLAUDE.md` (ansible-lint as the
      gate, SPDX headers, variable names); one `CHANGELOG.md`; licenses per
      directory (`ansible/LICENSE`)
- [x] `test/vm` runs Ansible from the host against the test DC (`lab.sh
      ansible`): `samba_dc_build` from `baseline` with the package install
      (then no change on a second run, once the role manages
      `cockpit.socket`), a local `.deb`, `source` and back; a share made by
      `samba_tool` shown in Cockpit, one made in Cockpit read and changed by
      `samba_tool`; `sysvolcheck` clean

## A3. Core: spike on shared folders and drive mapping (done) — v0.9.0

The most duplicated part (`src/lib/shares.ts`, `src/lib/drivemaps.ts`;
`ansible/plugins/module_utils/samba_share.py`). Ends with a decision.

- [x] First, once v0.8.0 is out: a README in `ansible-collection-samba_dc`
      pointing here (archived at the end of the plan, A6); win_edulab's
      `requirements.yaml` on `git+…/cockpit-samba-dc.git#/ansible/` at
      v0.8.0, its symlink under `ansible_collections/` and `.mcp.json` on
      `ansible/`
- [x] `addcctl` (`core/`): `share list|get|set|delete|rename-principal`
      and the drive mapping, from the collection's model (idempotent,
      check mode, diff) and the page's (paths exactly under
      `/srv/samba/shares`, sysvol files keeping their NT ACL); a lock
      serializes the changes. Through the samba Python bindings, tried on
      the target: loadparm (also `registry shares`), the registry shares
      (`smbconf`, one transaction), `sam.ldb` with the system session, NSS
      through `pwd`/`grp`
- [x] The schemas of these operations (`addcctl schema`), validated on input
- [x] The generator of the TypeScript types from the schemas
      (`scripts/addcctl-types.mjs`, `make schema`; CI checks that
      `src/lib/addcctl-schema.ts` is up to date; `addcctl()` takes the input
      type of its operation). The A4 modules were written by hand (see A6)
- [x] Tests: `unittest` (`core/tests`, in `make check` and CI) with a fake DC
- [x] Debian source package with two binaries, `addcctl` (private modules
      in `/usr/lib/addcctl`, man page) and `cockpit-samba-dc` depending on
      it; lintian clean; `lab.sh deploy` and the release handle both
- [x] `shares.ts` calls the core (`drivemaps.ts` is gone, 508 lines less);
      `samba_share` and `samba_share_info` too (`module_utils/samba_share.py`
      is gone), failing clearly when `addcctl` is missing; `samba_dc_build`
      installs it, also with `none`
- [x] On the test DC: the times below; a share made by `samba_tool` and by
      the page; `sysvolcheck` clean; the mapped drive at a Windows logon
      (`student1` sees "Classe (S:)")
- [x] **Go/no-go**, with the measures: go, decided on 2026-10-23 (one
      implementation, saves about twice as fast, concurrent writers
      serialized, the chain to a Windows logon works)

Measures on the test DC (2 vCPU), through the page:

| | before (src/lib) | addcctl |
|---|---|---|
| refresh the list of shared folders | 210–320 ms | 215–270 ms |
| create one with a mapped drive | 1.46–1.58 s | 0.70–0.71 s |
| change its drive letter | 1.18–1.32 s | 0.45–0.60 s |
| one `addcctl` call from a shell (start, read, answer) | | ≈185 ms |

## A4. Core: every other operation (done) — v0.9.0

- [x] In addcctl: users (list, get, create, set, password, unlock, delete;
      lockout and expiry), groups (list, get, create, set, delete), computers
      (list, get, create, delete), home directories (provision, delete), the
      password policy (read); SamDB API, `samba-tool` only for the renames, the
      primary group and a computer's deletion; built-in objects protected in
      the core; tried on the test DC
- [x] The page's `samba.ts` on the core (`parsers.ts` is gone); every page
      tried in the browser on the test DC
- [x] Ansible modules `samba_user`, `samba_group`, `samba_computer`,
      `samba_home` on the core; `samba_tool` dispatches to them (OUs and the
      read-only actions still run `samba-tool`); `samba_dc_build` creates its
      accounts with `samba_user`, after installing addcctl; `samba_tool_user`
      goes (tombstone in `meta/runtime.yml`); tried on the test DC, from a DC
      built from `baseline`
- [x] `CLAUDE.md`: the non-negotiable rules refer to the core

## A5. MCP server on the DC (done) — v0.9.0

- [x] `addcctl mcp` (stdio, JSON-RPC written in `core/addcctl/mcp.py`, no
      dependency): one tool per operation, named `<object>_<action>`, with
      the operation's schema; `"check": true` as preview; `writeOnly` inputs
      (passwords) never in a result, masked in the log (syslog, authpriv,
      `addcctl-mcp`, with the caller); `--read-only` offers only the reads
- [x] Reached through SSH, with a sudoers rule for that command alone and
      the key bound to it (`command=` in `authorized_keys`); README, "MCP
      server on the DC", and `man addcctl`. Tried on the test DC with the
      official MCP Python SDK as client: users, groups, shares with a mapped
      drive, previews, refusals (built-in account, bad name), read-only;
      `sysvolcheck` clean
- [x] The orchestration MCP (playbooks on the control node) keeps
      `samba_dc_build` (new: playbook and tool, `force_provision` needs a
      confirmation) and `samba_dc_backup` and drops the `samba` tool;
      `lab.sh mcp` runs it against the test VMs; a DC built from `baseline`
      through the tool
- [x] The integration suite of section 0 runs through the MCP tools, the
      Ansible modules and the Cockpit page's operations

## A6. The roadmap in the new layout

- [x] win_edulab on v0.9.0 (2026-10-24): `requirements.yaml`, and
      `.mcp.json.example`, `docs/mcp.md` and its skill `win-edulab-mcp` move
      from the `samba` tool to `addcctl mcp` over SSH (sudoers rule and a key
      bound to the command, README "MCP server on the DC"). Not tried on its
      DC: setting up the `mcp` user there and adding the server to its own
      `.mcp.json` are left to the developer of that lab
- [x] Rewrite sections 0 and 4–8 as operations of the core with their three
      interfaces; update "Where things stand", `docs/architecture.md` (its
      "Today" section described the two repositories) and the README
- [x] The Ansible modules' options generated from the schemas (decided on
      2026-10-24): `scripts/ansible-specs.py` (`make schema`, checked by CI)
      writes the doc fragment `options` and `module_utils/argument_specs.py`;
      what only a module has (`state`, `create`, `update_password`, aliases,
      its own descriptions) is in the script's `MODULES`
- [x] Archive `ansible-collection-samba_dc` on GitHub (2026-10-28)
- [x] Rename the repository after the collection joined it: decided on
      2026-10-29 to keep `cockpit-samba-dc`

## 0. Follow-ups of the October 2026 review (done) — v0.15.0

- [x] **Stale share entries after a delete.** Deleting a user or group leaves
      it in its shares, on purpose (rule 6). `share get` and `share list`
      mark such entries `unknown`; `share set` keeps them (it refused the
      share as "Unknown user or group"), outside the ACL and the drive
      mapping, which needs one existing target; `user delete` and `group
      delete` return `shares`. Page: "Deleted account" in the list and the
      editor, the shares named in the delete confirmations (from the cached
      list); Ansible: `samba_share_info`, `shares` and a warning on delete
- [x] **`registry shares` is not checked.** Confirmed on the test DC: with
      `no`, `net conf` writes a share that smbd does not serve
      (`BAD_NETWORK_NAME`); with `include = registry` it does, and only
      smbd's (s3) loadparm says so. `share set` and `home provision` refuse
      without it (`Dc.registry_shares`), `share list` returns it; a warning
      on the Shared folders tab, `registry_shares` in `samba_share_info`
- [x] **Home directory after a user rename.** `home provision` and `home
      delete` follow `homeDirectory`, so a renamed user keeps its folder;
      a folder owned by another account (renamed or deleted) is neither
      handed to a new namesake nor deleted with its data
- [?] **Rename the home folder with the user.** `user set` with `new_name`
      could move `/srv/samba/home/<old>` and `homeDirectory` too (only when
      they are the ones `home provision` made); a user logged on loses H:
      until the next logon. Optional: the folder works under its old name
- [x] **`ensureHomeShare` remembers success for the whole session**: the
      promise is now kept only while it runs, so the next provisioning checks
      the share again.
- [x] **`samba-tool ntacl sysvolreset` after every mapping change**: 0.7 s
      on the test DC (3 GPOs), more with every file in sysvol. A rewritten
      file now takes the attributes of the old one (`cp --attributes-only
      --preserve=mode,ownership,xattr`, which carries `security.NTACL`);
      the reset runs only for a new file (now in `core/addcctl/runner.py`
      and `drivemaps.py`). Checked with `sysvolcheck` and at a Windows logon
      (A3).
- [x] **Nested groups** are expanded on the user page
      (`expandNestedGroups`, from the members that `listGroups` reads).
- [x] **Linter.** ESLint (`eslint.config.mjs`: recommended, typescript-eslint,
      react-hooks), `make lint` and a CI step; `src/lib/hooks.ts` now 4-space
      (`UsersPage.tsx` and `app.tsx` are still 2-space throughout)
- [x] **Integration checks.** `test/vm/integration.ts` (run with
      `run-lib.sh` before each release): one scenario (group, user, home
      directory, share with a mapped drive, smbd access, renames, removal)
      through the page's functions, the Ansible modules and the `addcctl mcp`
      tools, the same checks on the DC, plus the core's own (CN vs account
      name, the GPO linked again, hand-made shares left alone); 30 s on the
      test DC; since section 8, also the "Domain" tab (overview, checks, a
      backup or its preview), since section 4 the password policy and a
      PSO, since section 5 an OU (a user moved in and out, the OU renamed,
      deleted with a computer in it), since section 6 the forms (a user with
      its details, a distribution group with an e-mail, a computer account),
      since section 7 DNS records and GPO links (linked to an OU, enforced,
      disabled, unlinked; the protected links refused by the core),
      through each interface (about 3 minutes on the test DC). It replaces
      `review-smoke.ts`. Its second run found that a
      user or group deleted and created again under the same name got the
      old uid/gid (winbind's name cache): addcctl now resolves ids by SID
- [x] **`lab.sh root` lost its stdin once** (2026-10-23, not reproduced):
      sudo no longer reads the command's stdin. The remote shell reads the
      password line and gives it to `sudo -v` on a pipe of its own, then
      runs `sudo -n sh -c` with the rest
- [x] **Collection: `samba_tool_user` bugs** (enable, disable and
      setprimarygroup creating a missing user; any failure read as "no such
      user"; an empty DN reaching `ldbmodify`; `commands` documented as
      conditional): gone with the module, replaced by `samba_user` on addcctl
      (A4), which fails on a missing user unless given a password
- [x] **Collection: structured reads.** `samba_directory_info` returns the
      users, groups or computers (`addcctl … list` / `get`)
- [x] **The GPOs of an OU.** The "Organizational units" tab shows the GPOs
      linked to each OU (from `gpo list`, no new operation); a label opens
      `GpoLinksModal`.
- [x] **`tdb-tools` missing from the test DC's baseline.** `addcctl`
      depends on it since v0.10.0: `provision-dc.sh` installs it now; it
      reaches the snapshots at the next `build dc`.
- [x] **Collection unit tests locally.** `ansible-test units --venv` (and
      `sanity --venv`) build their own virtual environment with pytest: no
      install on the host (collection README, "Development")
- [x] **Collection: sanity ignore files for ansible-core 2.16–2.18**: deleted,
      below `requires_ansible: ">=2.19.0"`
- [x] **Rebuild scripts.** The test VMs are built from scratch, with no
      manual step, on a network of the lab's own (`test/vm/lab.conf`,
      after cockpit-fleet's `test/vm/`): `lab.sh build dc` (Debian from the
      installer of the mirror with `preseed.cfg`, then Samba: ~15 min),
      `lab.sh build win` (Windows from `WIN_ISO` with `win/autounattend.xml`,
      then the join: ~45 min). Run end to end on 2026-10-24

## 1. Versioning through git tags (done) — v0.1.0

The tag `vX.Y.Z` on `main` is the only source of the version
(`scripts/version.mjs`): the build writes it into `dist/manifest.json` and
the page header, `make release` dates `CHANGELOG.md`, commits and tags, and
`release.yml` publishes on the tag. Rule and procedure: README, "Versions
and releases".

At 1.0.0, update the "Supported versions" table in `SECURITY.md`, which
lists only `0.x`.

## 2. Debian package (done) — v0.2.0

`debian/` packages the `dist/` built beforehand, since a Debian build
environment does not download npm dependencies: `debian/rules` only copies
it into `/usr/share/cockpit/samba-dc` (since A3 it also installs addcctl as a
second binary package, see "Where things stand"). `scripts/debian.mjs` turns the tag
into the Debian version (`0.2.0+3.gabc1234` between releases) and writes
`debian/changelog`, which is not tracked. `debian/preinst` removes a
hand-made copy on first install. `make deb` = build + `deb-package`
(changelog, then `scripts/deb-container.sh`: `deb-binary` and `lintian` in
a Debian 13 container); `release.yml` attaches the `.deb`, `ci.yml` builds
it on every push. README, "Installation".

When a requirement is raised (Cockpit, Samba), raise the matching
`Depends:` in `debian/control` too.

- [?] RPM package for Fedora/RHEL-based servers — future implementation to be
      decided

## 3. Account lockout and expiry (done) — v0.2.0

User page "Account" section, row menu, bulk actions, "Locked" and "Expired"
labels and filters. README, "Account lockout and expiry". Tried on the test
DC on 2026-10-23 (lockout after failed SMB logons, unlock single and bulk,
expiry single and bulk, logon refused with `NT_STATUS_ACCOUNT_EXPIRED`).
Since A4 both are addcctl operations (`user unlock`, `user set` with
`expires`); what follows records how they were first built.

- [x] **Unlock account** — `samba-tool user unlock <username>`; the locked
      state comes from `msDS-User-Account-Control-Computed` (UF_LOCKOUT),
      which Samba computes with the lockout duration, also through local
      `ldbsearch`
- [x] **Account expiry** — written as `accountExpires` with `ldbmodify` on
      `sam.ldb`, not with `samba-tool user setexpiry`, which also sets
      (`--noexpiry`) or clears (`--days`) "password never expires"; a date
      picker for the last day of use, plus "never"; not offered for system
      accounts

## 4. Password policy (high priority) — v0.11.0

- [x] **Edit the domain policy** (2026-10-24; tried on the test DC: the
      integration suite changes and restores it through each interface,
      `samba-tool domain passwordsettings show` reads the change, Samba
      refuses a password below the new minimum, the form in the browser)
  - [x] Core: `domain set-password-policy`, on the domain object through
        SamDB, with the ranges (in the schema: the validator now knows
        `minimum` and `maximum`) and checks of `samba-tool domain
        passwordsettings set`, plus the lockout window within the lockout
        duration; `null` for never
  - [x] Page: a "Password policy" card in the "Domain" tab with an edit
        modal; `PasswordPolicy` has every field; a change drops the cache
  - [x] Ansible: module `samba_password_policy` (`0` for never, as
        `samba-tool`)
- [x] **Fine-grained policies (PSO)** (2026-10-24; tried on the test DC:
      the integration suite through each interface, `samba-tool domain
      passwordsettings pso show-user` and Samba's refusal of a short
      password, a lockout until unlocked, the card and the user page in
      the browser)
  - [x] Core: `pso list`, `pso get`, `pso create` (settings left out: the
        domain's; never plaintext passwords; domain level 2008 or higher),
        `pso set` (`applies_to` with `applies_to_mode`), `pso delete`; the
        PSO's DN built with `ldb.Dn`; `user get` returns `password_policy`
        (`msDS-ResultantPSO`, else the domain's). A lockout duration of 0
        reads as "until unlocked", as Samba applies it
  - [x] Page: a card in the "Domain" tab (list, create, edit, delete); the
        policy fields shared with the domain's form; the user page names
        the policy that applies and checks the password against it
  - [x] Ansible: module `samba_pso` (`0` for never)

## 5. Organizational units (high priority, largest change) — v0.12.0

Done on 2026-10-26; tried on the test DC: the integration suite through
each interface (an OU with an inner one, a user moved in and out, the OU
renamed, deleted with a computer in it), the tab, the moves and the
confirmations in the browser.

- [x] **Core**
  - [x] `ou list` (the tree: DN relative to the domain, name, description,
        built-in or not, with the default containers `CN=Users` and
        `CN=Computers`, read from the domain's `wellKnownObjects`), `ou get`,
        `ou create`, `ou set` (rename, move, description), `ou delete` (a
        non-empty OU only with `recursive`; never with a built-in object or
        a domain controller in it; computers first, with their DNS records)
  - [x] Built-in containers (`Domain Controllers`, `Users`, `Computers`)
        never renamed, moved or deleted; nothing created or moved into
        `Domain Controllers`; built-in accounts and groups and domain
        controllers never moved
  - [x] `user`, `group` and `computer list` return the container;
        `user`, `group` and `computer set` take `ou` (move; `computer set`
        is new, with `description`); `group create` takes `ou`
  - [x] DNs built with `ldb.Dn`, never by joining strings (rule 3)
- [x] **Page**: an "Organizational units" tab with the tree (create, rename,
      move, describe, delete with an explicit confirmation for a non-empty
      OU, its contents read again before it); the container as a column and
      a filter in the users, groups and computers lists; an OU selector in
      the create modals of users and groups (computers: section 6); move
      from the lists, users also in bulk (`mapLimit`); the lists read again
      when another tab is chosen
- [x] **Ansible**: module `samba_ou`, replacing the OU actions of
      `samba_tool` (the last that changed the DC through `samba-tool`); `ou`
      on `samba_user`, `samba_group`, `samba_computer`

## 6. Richer create and edit forms (medium priority) — v0.13.0

Done on 2026-10-26; tried on the test DC: the integration suite through
each interface (a user with its details and a password to change, a
distribution group with an e-mail, a computer account with its description),
the modals, the computer's page and the bulk move of groups in the browser.

- [x] **Users** — in the create modal: must change at next logon,
      description, e-mail, title, department, company (`user create`);
      description, title, department and company also edited on the user
      page (`OrganizationFields`)
- [x] **Groups** — in the create modal: description, e-mail, scope, category
      (`group create`); "Edit group" (name, description, e-mail: `group
      set`) replaces "Rename group"; `email` in `group create` and `group
      set`, and in `samba_group`
- [x] **Computers** — a detail page (`#/computers/<name>`, `computer get`),
      with the description edited (`computer set`); "Create computer
      account" (`computer create`) with the OU selector. `computer create`
      now refuses names that are not NetBIOS names (15 letters, digits,
      hyphens)
- [x] **Bulk move of groups and computers**: selection in both lists
      (`useSelection` in `src/lib/hooks.ts`, also used by the users list)

## 7. DNS and Group Policy (medium priority) — v0.14.0

`samba-tool dns` and most of `samba-tool gpo` talk to the server over RPC
or SMB and want domain credentials, against rule 5. The records and the
GPOs are in `sam.ldb` and sysvol, though: the core reads and writes them
locally (first item), as it already does for the drive-mapping GPO.

- [x] **Decide the access** (spike on 2026-10-27, Samba 4.22.11): local,
      no credentials. DNS: the `dnsNode` entries of the DNS partitions,
      read and written through SamDB as `rpc_server/dnsserver/dnsdb.c`
      does (a new node added, an empty one tombstoned by
      `dns_replace_by_dn`, a tombstoned one revived with `dNSTombstoned:
      FALSE`, the zone's SOA serial increased and carried by the changed
      records); the internal DNS server serves a change at once, `samba-tool
      dns query` reads it, `dbcheck` stays clean, and a node gets the ACL
      the RPC interface gives (owner SYSTEM). GPOs: listing and linking are
      `sam.ldb` writes, as for the drive-mapping GPO. `samba-tool gpo
      backup` and `restore` go through SMB with credentials: left out
      rather than rewritten in the core (decided with the user on
      2026-10-27, table "Left out"), since the domain backups of section 8
      hold sysvol and the directory
- [x] **DNS**
  - [x] Core: `dns zones`, `dns list` (zone, name), `dns set` (the
        records of one type at one name become the values given),
        `dns delete` (A, AAAA, CNAME, PTR, TXT, SRV, MX; `core/addcctl/dns.py`,
        the dnsp records in `dc.py`); the records the domain depends on
        (`_msdcs`, `_ldap`, `_kerberos`, `_gc`, `_kpasswd`, `_sites`,
        `DomainDnsZones`, `ForestDnsZones`, the DCs' own names, SOA and NS,
        the addresses of the domain's name) never changed
  - [x] Page: a "DNS" tab (`DnsPage.tsx`, `src/lib/dns.ts`); Ansible: module
        `samba_dns_record`; a step of the integration suite
- [x] **Group Policy**
  - [x] Core: `gpo list` (display name, GUID, version, flags, where it is
        linked), `gpo get` (one, with its links), `gpo link` and `gpo
        unlink` (the domain root or an OU, `OU=Domain Controllers`
        included, not `CN=Users` or `CN=Computers`; the link's enforced and
        disabled flags, left out: kept). `core/addcctl/gpos.py`, tests in
        `core/tests/test_gpos.py`. The GPOs are the `groupPolicyContainer`
        entries under `CN=Policies,CN=System,<domain>`; a link is an item
        `[LDAP://<GPO DN>;<flags>]` of the container's `gPLink` (1 disabled,
        2 enforced), written as `samba-tool gpo setlink` and `dellink` write
        it (read in Samba 4.22's `netcmd/gpo.py`): a new link goes first,
        the lowest precedence; the others keep their order and their DN as
        written; with no link left the attribute is deleted. A link's
        `order` is the GPMC's link order (1 = the last item). The default
        GPOs (by GUID) where provisioning linked them and the drive-mapping
        GPO ("Cockpit - Mapped drives") on the domain are `protected`: never
        unlinked or disabled. Tried on the test DC on 2026-10-28:
        `samba-tool gpo getlink` reads what addcctl writes, `dbcheck` clean
  - [x] Page: a "Group Policy" tab of its own (`GpoPage.tsx`, the links
        of a GPO in `GpoLinksModal.tsx`, `src/lib/gpos.ts`; the "Domain"
        tab was long already); Ansible: module `samba_gpo_link`; a step of
        the integration suite for each interface (link a GPO to a `t-` OU,
        enforce, disable, unlink, as `samba-tool gpo getlink` reads it) and
        one of the core (the protected links refused); the tab and its modal
        tried in the browser. The GPOs of each OU in the "Organizational
        units" tab came later (section 0, v0.15.0)

## 8. Domain status and maintenance — v0.10.0

A new "Domain" tab (`src/components/DomainPage.tsx`, `src/lib/domain.ts`),
which also holds the policies of section 4.

- [x] **Overview** — core: `domain info` (`core/addcctl/domain.py`), read
      locally (sam.ldb: functional levels, FSMO owners from `fSMORoleOwner`,
      the servers under `CN=Sites`; loadparm; `samba.version`) plus
      `samba-tool processes`; page: the tab's first card; Ansible: module
      `samba_dc_info`
- [x] **Health checks**, run on demand — core: `domain check` (`samba-tool
      dbcheck --cross-ncs`, never `--fix`; `samba-tool ntacl sysvolcheck`;
      `testparm -s`: each with its exit code and output, cut at 64 KiB),
      `domain sysvol-reset`; page: the results with their output, the reset
      offered when `sysvolcheck` fails
- [x] **Backup**
  - [x] Core: `backup create` (`samba-tool domain backup offline`) into
        `/var/backups/samba-dc` (0700, archives 0600: they hold the password
        hashes), `backup list` (`core/addcctl/backups.py`). It is a change:
        it holds addcctl's lock while it runs, so other changes wait; the
        page waits for it with a spinner, an MCP client as long as its
        timeout allows
  - [x] Page: list and create, with errors; restore documented as a manual
        procedure (README, "Domain backups and restore")
  - [x] Ansible: `samba_dc_backup` makes the offline backup through `backup
        create` when `samba_dc_backup_targetdir` is unset or that directory
        (it is optional now); online backups, other directories and file
        backups stay in the role
- [x] Tried on the test DC (2026-10-24): the integration suite passes
      through every interface, the page's backup included; `samba_dc_backup`
      with no `samba_dc_backup_targetdir` makes it through addcctl (`lab.sh
      ansible`); the tab in the browser shows the overview, runs the checks
      with their output and makes a backup. `samba-tool domain backup
      offline` wants `tdbbackup` (`tdb-tools`), which a DC lacks: `addcctl`
      depends on it, `samba_dc_build` installs it, and `backup create` says
      so when it is missing

## 9. With the next breaking release (done) — v0.16.0

Changes that ask the users of the collection to act: kept for a release
that has a breaking change anyway.

- [x] **Collection: `samba_tool`'s read-only actions on addcctl.** `user`,
      `group` and `computer` `list` and `show`, and `group listmembers`, run
      `samba_directory_info` (`tasks/_info.yaml`): `samba_tool_result.objects`
      replaces the raw text, `samba_tool_bin` is gone

## 10. Domain provisioning from the page — v0.17.0

The package depends on `samba-ad-dc`, so `apt install cockpit-samba-dc` on
a clean Debian brings Samba with no domain, and the page has nothing to
manage: most installations start there. A guided procedure provisions a new
domain from the page (decided on 2026-10-29). Scope: a new forest with one
DC. No join to an existing domain, no demotion, never over an existing
domain (no "force", unlike `samba_dc_build_force_provision`). The network is
verified, not changed (decided on 2026-10-29): changing the address from the
browser would drop the session; the static address is set in Cockpit's
"Networking" page, or by hand.

- [x] **Spike: the provisioning in the process** (2026-10-29, Samba
      4.22, from snapshot `baseline` with the packages installed).
      `samba.provision.provision()` called from Python with the arguments
      `samba-tool domain provision` passes (`serverrole="dc"`,
      `use_rfc2307=True`, `dns_backend="SAMBA_INTERNAL"`, `hostip`,
      `dns_forwarder`, `base_schema="2019"`, `adprep_level` 2016, level
      2008 R2, `useeadb=False`, `lp` with `registry shares = yes`) gives the
      same domain as the command: directory (every object and attribute,
      SIDs and GUIDs aside), `smb.conf`, sysvol ACLs and files; only the
      KDS root key differs (random). It takes about 5 s. The password read
      from stdin works for `Administrator` through NTLM and Kerberos, and
      is in no log. No fallback needed. Found on the way:
  - the packages leave `smbd`, `nmbd`, `winbind` enabled and running with
    Debian's `smb.conf` (`server role = standalone server`), which makes
    `provision()` fail (`guess_names`): moving it aside is required.
    `samba-ad-dc` is enabled, not masked, and not running
    (`ExecCondition=/usr/share/samba/is-configured`). The `.tdb` files of
    the standalone server do not hinder the provisioning: left alone;
  - `samba-tool domain provision` has no `--dns-forwarder`: without
    `--interactive` it takes the first `nameserver` of `resolv.conf`
    (`--option` does not override it); `provision()` takes it as an
    argument;
  - `libnss-winbind` already adds winbind to `nsswitch.conf`; no chrony
    (Debian uses `systemd-timesyncd`), so the DC serves no time to its
    clients: the setup check reports it, the procedure does not install it;
  - `cockpit-samba-dc` brings `cockpit-bridge` only, not the web service:
    the README's installation is `apt install cockpit chrony` with the packages;
  - addcctl without `sam.ldb`: an operation that reads the directory ends
    in a Python traceback (`LdbError` from `Dc.samdb`), not a JSON error;
  - `lab.sh deploy` from a snapshot needed `apt-get update` (stale package
    lists): added
- [x] **Core: `domain setup-check`** (`core/addcctl/setup.py`),
      read-only, also with no `sam.ldb` (an operation that needs it now
      says "No domain on this host"): a DC already, or each prerequisite
      with its state (ok, warning, error) and its fix: `smb.conf` (none, or
      Debian's standalone one with no shares of its own; no leftovers of a
      provisioning), a static address on the interface of the default route
      (read from `ip -j`: an address from DHCP is `dynamic`, with a finite
      lifetime, whatever manages it), the host name, the ports of a DC
      (`ss`; `smbd`, `nmbd`, `systemd-resolved` are stopped by the
      provisioning), time and chrony (warnings), free space; the defaults
      (realm and NetBIOS name from the FQDN, the forwarder from
      `resolv.conf`)
- [x] **Core: `domain provision`**, under the lock, refused on a domain or
      a failed prerequisite, values checked as the page does (realm,
      NetBIOS name, forwarder, password with `samba.check_password_quality`).
      The steps of the plan, each in `commands` (so `--check` is the page's
      confirmation); Samba's messages in
      `/var/log/samba/addcctl-provision.log`, not on stdout or stderr. A
      failure before `sam.ldb` puts back `smb.conf` and the services; after
      it, the error names what is left. About 10 s on the test DC. `"mcp":
      False` in `OPERATIONS` keeps it out of `addcctl mcp`
- [x] **Page.** `src/app.tsx` asks `getSetupStatus()` first; with no
      domain, `SetupPage.tsx` (prerequisites, "Check again", a link to the
      Networking page, the form with `validators.ts`) and
      `modals/ProvisionModal.tsx` (the commands of `--check`, the wait);
      `provisionDomain()` drops every cached answer. The prerequisites'
      messages are addcctl's, in English, under translated titles
- [x] **Ansible.** `samba_dc_build`: the reboot of the network applied
      first, then the packages, addcctl, `tasks/provision.yaml` (setup check,
      `addcctl domain provision` with the JSON on stdin, `no_log`);
      `kerberos.yaml` and `resolver.yaml` gone (addcctl does them). The
      forced re-provisioning clears the databases, the old sysvol and
      `smb.conf` before addcctl runs. An existing DC keeps `registry
      shares` and the forwarder, compared as `testparm` reads them
- [x] **Tried on the test DC** (inspiron27, 2026-10-29) from `baseline`:
      `deploy`, the setup page in the browser (Debian with no Cockpit
      web server: `cockpit-ws` installed by hand), the tabs on the new
      domain; `addcctl domain provision` from the shell, with chrony;
      `samba_dc_build` from `baseline` (4 min, a second run changes
      nothing), then the test accounts and the integration suite, all
      passing (its new step: `setup-check` says a DC, `provision` refused,
      no MCP tool). Not tried: a failure halfway on a real host
- [x] README ("Requirements", "Installation" from a clean Debian, "Setting
      up a new domain" with the ports, "MCP server on the DC"),
      `CHANGELOG.md`

