# CLAUDE.md

Agent instructions for this project.

## What this is

`cockpit-samba-dc` is a Cockpit plugin that manages a Samba Active Directory
domain controller from the browser: users, groups, computers, home
directories and shared folders, with network drives mapped through a GPO. It
runs on the DC itself and calls `addcctl`, the project's core, as root
through Cockpit; addcctl reads and changes the DC locally (Samba's Python
bindings, `setfacl`, a few `samba-tool` commands).

`ansible/` holds the Ansible collection `lineadicomando.samba_dc`, which
provisions the DC (`samba_dc_build`, installing this module's package) and
manages the same objects from playbooks, plus an MCP server that runs them.
It has the version of the repository.

`core/` holds `addcctl`, the shared core of `docs/architecture.md`: a Python
command on the DC that runs one operation per call, JSON in and out. The
page and the collection call it for users, groups, computers, home
directories, shared folders, drive mapping and the password policy: a change
to what the project does on the DC is made there, once.

Documents, each with one job; do not repeat one in another:

- `README.md`: what the module does, how to install it, and what it creates
  on the server ("Files and shares on the server", "Network drive mapping").
  Update it with every change a user or an administrator would notice.
- `CHANGELOG.md`: what changed in each release, for its users. Add a line
  under `[Unreleased]` with every change that goes into the README, under the
  heading of its kind (`Added`, `Changed`, `Fixed`, `Breaking`, …): the
  kinds decide the next version.
- `TODO.md`: the roadmap of `samba-tool` features and the plan of the next
  release (`— vX.Y.Z` at the end of the headings of its sections). Tick
  items as they are completed and keep it short.
- `docs/architecture.md`: how the project is built, the target of the
  unification with `ansible-collection-samba_dc` (one core on the DC, with
  Cockpit, Ansible and MCP on top) and how far it has got. Update its
  migration table when a step of `TODO.md` A1–A6 is done.
- This file: how to work on the project.

`CLAUDE.local.md` and `Makefile.local`, when present, are not tracked: they
describe one developer's own machines (test VMs, addresses, deploy targets).
Nothing of them goes into tracked files, which must make sense to anyone who
clones the repository.

Layout: `src/app.tsx` the tabs, `src/components/` pages and
`src/components/modals/`, `src/lib/` everything that talks to the system
(`exec.ts` spawn wrappers; `addcctl.ts` the call to the core; `samba.ts`
users, groups, computers, home directories, password policy, `shares.ts`
shared folders and drive mapping, `domain.ts` the "Domain" tab (overview,
health checks, backups), all through it, translating and caching;
`validators.ts`, `passwordUtils.ts`, `cache.ts`, `hooks.ts`,
`concurrency.ts`; `addcctl-schema.ts` is generated),
`core/` the core (`addcctl/`: `cli.py` the command, `operations.py` the
operations and their JSON Schemas, `dc.py` everything that reads or writes
the DC, `accounts.py` users groups computers, `ous.py` organizational units, `homes.py`, `domain.py`
(policy, overview, health checks), `backups.py`,
`shares.py`, `drivemaps.py`, `acl.py`, `smbconf.py`, `ad.py`; `tests/`,
`bin/addcctl`, `addcctl.1`), `test/` unit tests with a cockpit
mock, `test/vm/` scripts for the test VMs, `.claude/skills/` agent skills,
`po/` and `src/locales/` translations, `scripts/` build and release
helpers (`addcctl-types.mjs` and `ansible-specs.py` generate from the
core's schemas the page's types and the modules' options, `version.mjs`
reads the version from the git tag, `debian.mjs` turns it into the Debian
version and `debian/changelog`, `plan.mjs` computes the next one from
`CHANGELOG.md` and checks it against `TODO.md`), `debian/` the Debian
package of the built `dist/`, `ansible/` the collection (`roles/`,
`plugins/modules/`, `module_utils/` and the generated `doc_fragments/`,
`playbooks/`, `mcp/`, `tests/`; its own `README.md` for its users).

## Non-negotiable rules

They keep a web page and a set of modules that change a domain controller as
root safe. They are enforced in `core/` (addcctl), which every interface
calls; the page and the modules check what they can too. A change that breaks
one of them needs the user's explicit agreement.

1. **No shell.** Commands are argv lists: `Runner` in `core/addcctl/runner.py`,
   `runAsRoot` / `runAsRootWithInput` in `src/lib/exec.ts` (`superuser:
   "require"`). Never `sudo` in argv, never `sh -c`.
2. **Secrets never appear in argv or in an output.** Passwords reach addcctl
   in its JSON input on stdin (`writeOnly` in the schema), go to Samba through
   its Python API in the same process, and are never returned or recorded in
   `commands`; the modules mark them `no_log`.
3. **Names are checked before they reach a command.** In the core
   (`check_principal_names`, `share_name_violation`: a leading `-` would be
   read as an option); in the page too (`validators.ts`, `checkName`). Values
   in an LDAP filter go through `ldb.binary_encode`.
4. **Destructive commands only on paths the project created.** Recursive
   `setfacl` and `rm -rf` run only on `/srv/samba/shares/<name>`
   (`is_managed_path`) and `/srv/samba/home/<user>` (`is_home_path`); shares
   elsewhere (hand-made ones) are not listed or touched.
5. **Local reads, no domain credentials.** The configuration through Samba's
   loadparm, the directory from the local `sam.ldb` with the system session,
   not with network queries (`samba-tool domain info` and CLDAP fail when Samba
   does not listen on loopback). The GPO is written directly to `sam.ldb` and
   sysvol.
6. **Never open a share by mistake.** An empty `valid users` grants every
   domain user: a share always keeps at least one entry, and nothing removes
   entries automatically (deleted accounts stay listed).
7. **Every mutation invalidates the caches it affects.** The page caches
   addcctl's answers (`samba.ts` drops them all on a change, `shares.ts` and
   `domain.ts` their own); the cache is shared, so a change in one drops
   entries of the other.

The built-in accounts and groups are protected in the core too: not deleted
or renamed, Administrator's and krbtgt's status unchanged, no expiry on a
system account, a domain controller's account never deleted.

## Stack and conventions

- TypeScript, React 18, PatternFly 6, esbuild. 4-space indent, `.ts` import
  extensions, comments only where the reason is not obvious.
- Target: Debian 13 (Cockpit 337, Samba 4.22). Check `samba-tool <cmd>
  --help` on the target before using a subcommand or flag: some were renamed
  across releases.
- Bulk actions run through `mapLimit(…, BULK_CONCURRENCY, …)`, not an
  unbounded `Promise.all`: each call starts an addcctl process, and changes
  wait for its lock.
- In the core, group members and user groups come as DNs: they become
  account names through `Directory.dn_names()`, not from the CN (a user's CN
  is often its full name).
- addcctl prefers Samba's SamDB API; it calls `samba-tool` (argv) only where
  that does the job right and the API does not (renames, the primary group,
  deleting a computer with its DNS records).
- Errors raised by addcctl and in `src/lib/` are English and shown as they are.
- Code, comments, commit messages and docs (`TODO.md` included) in English;
  conversation with the user in Italian.
- Commits: short imperative subject, as in the history.

The collection (`ansible/`):

- `ansible-lint` with the `production` profile is the gate (`ansible/.ansible-lint`);
  CI also runs `ansible-test sanity` and `units` on ansible-core 2.19 and 2.20.
- Every file starts with an SPDX header, `GPL-3.0-or-later`.
- Role variables carry the role name as prefix (`samba_dc_build_*`);
  each role documents them in `README.md` and `meta/argument_specs.yaml`.
- Modules that change the DC call addcctl (`module_utils/addcctl.py`): check
  mode is `addcctl --check`, diff comes from its answer. Only the read-only
  actions of `samba_tool` (`list`, `show`) still run `samba-tool` directly.
- A module's options are generated (`make schema`, `scripts/ansible-specs.py`)
  into the doc fragment `plugins/doc_fragments/options.py` and
  `module_utils/argument_specs.py`: those of a core setting from its schema,
  the module's own (`state`, aliases, descriptions of what the module does
  differently) from the table `MODULES` of the script. The module's file
  keeps its description, examples and return values.

## Adding things

Each new feature (see `TODO.md`) also needs:

- validators in `src/lib/validators.ts`, with a `…ViolationMessage` that calls
  `t()` with literal strings (so the parser can extract them);
- the operation in `core/addcctl/` with its JSON Schema in `operations.py`,
  tests in `core/tests/`, then `make schema` for the page's types and the
  modules' options (a new option of a module goes into `MODULES` of
  `scripts/ansible-specs.py`); the page's
  call in `src/lib/` and its tests under `test/`;
- cache invalidation for every mutation (rule 7);
- strings: English in the source through `t()`, Italian in `po/it.po`, then
  `make po-compile && make pot` (in this order: `pot` sorts the catalogs,
  `po-compile` writes them in the order of `po/it.po`);
- a line in the README feature list and one under `[Unreleased]` in
  `CHANGELOG.md`.

A page is a component under `src/components/` and a tab in `src/app.tsx`;
lists use `useSingleLoad` and `usePagination` from `src/lib/hooks.ts`.

## Commands

```
make build | watch      # bundle into dist/, watch mode
make check              # unit tests: npm test (node --test, cockpit mock) and core/tests (unittest)
npx tsc --noEmit        # type check (CI runs it before the build)
make schema             # from the core's schemas: src/lib/addcctl-schema.ts, the modules' options (CI checks them)
make pot                # extract strings into src/locales/*/translation.json
make po-compile         # po/it.po → src/locales/it/translation.json
make deb                # Debian package in build/ (Debian 13 container, lintian)
make devel-install      # symlink dist/ into ~/.local/share/cockpit/samba-dc
sudo make install       # copy dist/ into /usr/share/cockpit/samba-dc
make next-version       # next version: CHANGELOG.md checked against the plan in TODO.md
make release            # commit and tag it (README, "Versions and releases")
(cd ansible && ansible-lint)  # the collection's gate
```

Releases are made only when the user asks; pushing the tag publishes them.

## Tests

- The core's tests (`core/tests`, `unittest`, no dependency) run the
  operations against a fake DC (`FakeDc`, `FakeRunner`) and check the
  registry changes and the commands recorded; what only Samba shows is tried
  on the test DC (`lab.sh deploy`, then `addcctl` as root).
- Unit tests run `src/lib/` against `test/mocks/cockpit.ts`: a test sets a
  handler with `setSpawnHandler`, which answers each spawned argv, and checks
  the recorded `calls` (argv and stdin). Answer in the verbatim shape of
  addcctl's output (see `test/samba.test.ts`).
- Module state (the cache, the smb.conf parameters, the home share promise)
  is shared by the tests of one file: a test that needs fresh data either
  runs a mutation that invalidates it or imports the module again with a
  query string (`import("../src/lib/samba.ts?name")`).
- What the mock cannot show (real `samba-tool` output, ACLs, smbd access,
  GPO applied on a Windows client, the interface) needs a DC with the module
  installed: test there before a commit that touches `src/lib/`.
- `test/vm/integration.ts` (`test/vm/run-lib.sh`, after `lab.sh deploy`)
  runs one scenario through the page's functions, the Ansible modules and
  the tools of `addcctl mcp`, and checks the DC: run it before a release and
  after a change to `core/`; a new operation gets its step there.

## Test environment

- A test DC is Debian 13 with `samba-ad-dc` provisioned, `registry shares =
  yes`, `acl`, and Cockpit. Drive mapping needs a Windows client joined to
  the domain (`gpupdate /force`, then a new logon).
- The test VMs are described by `test/vm/lab.conf` (names, network,
  addresses) and `.env` (from `.env.example`, not tracked: passwords, the
  Windows ISO), built from scratch by `lab.sh build dc` and `lab.sh build
  win`, and driven by `test/vm/`: skill `vm-lab` for their build, lifecycle,
  SSH and deploy, skill `win-gui` for the Windows interface. Load the skill
  before using them.
- After a deploy, a Cockpit tab keeps running the old bundle until reloaded
  (F5): the shell keeps the module's iframe for the whole session. A copy in
  `~/.local/share/cockpit/samba-dc` shadows the one in `/usr/share/cockpit`
  for that user only, and any `samba-ad-dc` directory is a pre-rename copy.
  Compare `sha256sum dist/index.js` with the deployed copy before debugging a
  behaviour that should already be fixed.
- Cockpit has a self-signed certificate, which the browser tools refuse.
  Open an SSH tunnel to the DC (`ssh -L 9091:127.0.0.1:9090`) and use
  `http://127.0.0.1:9091`: Cockpit accepts plain HTTP from localhost. The
  module's page is the iframe `cockpit1:localhost/samba-dc`; React inputs
  need the native value setter followed by an `input` event.
- Create test accounts, groups and shares with a recognisable prefix and
  remove them afterwards; never touch the built-in objects.

## Repository

- Public on GitHub (`lineadicomando/cockpit-samba-dc`): every commit is
  public history. No secrets, passwords, or details of real (non-test)
  environments or of a developer's machines, in files or commit messages.
- License: `LGPL-2.1-or-later`; `ansible/` is `GPL-3.0-or-later`.
- CI: `.github/workflows/ci.yml` (Node.js 22: `npm ci`, type check, build,
  tests, then `make deb-package` in a Debian 13 container with `lintian`;
  the collection's ansible-lint, sanity and unit tests);
  `.github/workflows/release.yml` on `v*` tags publishes the tarball, the
  `.deb` and the collection.
- Never commit, push or create remote repositories unless asked.
