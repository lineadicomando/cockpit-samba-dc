# CLAUDE.md

Agent instructions for this project.

## What this is

`cockpit-samba-dc` is a Cockpit plugin that manages a Samba Active Directory
domain controller from the browser: users, groups, computers, home
directories and shared folders, with network drives mapped through a GPO. It
runs on the DC itself and drives the local tools (`samba-tool`, `ldbsearch`,
`ldbmodify`, `net conf`, `testparm`, `setfacl`) as root through Cockpit.

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
- This file: how to work on the project.

`CLAUDE.local.md` and `Makefile.local`, when present, are not tracked: they
describe one developer's own machines (test VMs, addresses, deploy targets).
Nothing of them goes into tracked files, which must make sense to anyone who
clones the repository.

Layout: `src/app.tsx` the tabs, `src/components/` pages and
`src/components/modals/`, `src/lib/` everything that talks to the system
(`exec.ts` spawn wrappers, smb.conf parameters and the base DN; `samba.ts`
users, groups, computers, home directories; `shares.ts` shared folders;
`drivemaps.ts` the drive-mapping GPO; `parsers.ts`, `validators.ts`,
`cache.ts`, `hooks.ts`, `concurrency.ts`), `test/` unit tests with a cockpit
mock, `test/vm/` scripts for the test VMs, `.claude/skills/` agent skills,
`po/` and `src/locales/` translations, `scripts/` build and release
helpers (`version.mjs` reads the version from the git tag, `debian.mjs`
turns it into the Debian version and `debian/changelog`, `plan.mjs`
computes the next one from `CHANGELOG.md` and checks it against `TODO.md`),
`debian/` the
Debian package of the built `dist/`.

## Non-negotiable rules

They keep a web page that runs commands as root on a domain controller safe.
A change that breaks one of them needs the user's explicit agreement.

1. **No shell.** Spawn with argv arrays through `runAsRoot` /
   `runAsRootWithInput` in `src/lib/exec.ts` (`superuser: "require"`); never
   `sudo` in argv, never `sh -c`.
2. **Secrets never appear in argv.** Passwords go to `samba-tool` on stdin
   (`runSambaWithInput`), so they are not readable in `/proc/<pid>/cmdline`.
3. **Names are checked in `src/lib/`, not only in the UI.** New names go
   through `validators.ts`; every name that reaches a command as a positional
   argument goes through `checkName` (a leading `-` would be read as an
   option). Values in an LDAP filter go through `escapeLdapFilter`.
4. **Destructive commands only on paths the module created.** Recursive
   `setfacl` and `rm -rf` run only on `SHARES_DIR/<name>` (`isManagedPath`);
   shares elsewhere (the home share, hand-made shares) are not listed or
   touched.
5. **Local reads, no domain credentials.** Read the configuration with
   `testparm` and the directory from the local `sam.ldb`, not with network
   queries (`samba-tool domain info` and CLDAP fail when Samba does not listen
   on loopback). The GPO is written directly to `sam.ldb` and sysvol.
6. **Never open a share by mistake.** An empty `valid users` grants every
   domain user: a share always keeps at least one entry, and nothing removes
   entries automatically (deleted accounts stay listed).
7. **Every mutation invalidates the caches it affects** (`cache.invalidate`
   in `samba.ts`, `shares.ts`, `drivemaps.ts`). The cache is shared between
   modules, so a mutation in one invalidates entries of the others.

## Stack and conventions

- TypeScript, React 18, PatternFly 6, esbuild. 4-space indent, `.ts` import
  extensions, comments only where the reason is not obvious.
- Target: Debian 13 (Cockpit 337, Samba 4.22). Check `samba-tool <cmd>
  --help` on the target before using a subcommand or flag: some were renamed
  across releases.
- Bulk actions run through `mapLimit(…, BULK_CONCURRENCY, …)`, not an
  unbounded `Promise.all`: each call spawns a `samba-tool` process and takes
  the `sam.ldb` lock.
- Group members and user groups come as DNs: turn them into account names
  with `resolveDn` and a `buildDnNameMap`, not from the CN (a user's CN is
  often its full name).
- Errors raised in `src/lib/` are English and shown as they are.
- Code, comments, commit messages and docs (`TODO.md` included) in English;
  conversation with the user in Italian.
- Commits: short imperative subject, as in the history.

## Adding things

Each new feature (see `TODO.md`) also needs:

- validators in `src/lib/validators.ts`, with a `…ViolationMessage` that calls
  `t()` with literal strings (so the parser can extract them);
- parsers and tests under `test/`;
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
make check              # unit tests (npm test: node --test with the cockpit mock)
npx tsc --noEmit        # type check (CI runs it before the build)
make pot                # extract strings into src/locales/*/translation.json
make po-compile         # po/it.po → src/locales/it/translation.json
make deb                # Debian package in build/ (Debian 13 container, lintian)
make devel-install      # symlink dist/ into ~/.local/share/cockpit/samba-dc
sudo make install       # copy dist/ into /usr/share/cockpit/samba-dc
make next-version       # next version: CHANGELOG.md checked against the plan in TODO.md
make release            # commit and tag it (README, "Versions and releases")
```

Releases are made only when the user asks; pushing the tag publishes them.

## Tests

- Unit tests run `src/lib/` against `test/mocks/cockpit.ts`: a test sets a
  handler with `setSpawnHandler`, which answers each spawned argv, and checks
  the recorded `calls` (argv and stdin). Answer with output in the verbatim
  shape of the real tool on the target (see `test/samba.test.ts`).
- Module state (the cache, the smb.conf parameters, the home share promise)
  is shared by the tests of one file: a test that needs fresh data either
  runs a mutation that invalidates it or imports the module again with a
  query string (`import("../src/lib/samba.ts?name")`).
- What the mock cannot show (real `samba-tool` output, ACLs, smbd access,
  GPO applied on a Windows client, the interface) needs a DC with the module
  installed: test there before a commit that touches `src/lib/`.

## Test environment

- A test DC is Debian 13 with `samba-ad-dc` provisioned, `registry shares =
  yes`, `acl`, and Cockpit. Drive mapping needs a Windows client joined to
  the domain (`gpupdate /force`, then a new logon).
- The test VMs are described by `.env` (from `.env.example`, not tracked)
  and driven by `test/vm/`: skill `vm-lab` for their lifecycle, SSH and
  deploy, skill `win-gui` for the Windows interface. Load the skill before
  using them.
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
- License: `LGPL-2.1-or-later`.
- CI: `.github/workflows/ci.yml` (Node.js 22: `npm ci`, type check, build,
  tests, then `make deb-package` in a Debian 13 container with `lintian`);
  `.github/workflows/release.yml` on `v*` tags publishes the tarball and the
  `.deb`.
- Never commit, push or create remote repositories unless asked.
