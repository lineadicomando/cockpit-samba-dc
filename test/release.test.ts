import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEMVER, buildVersion, versionFromDescribe } from "../scripts/version.mjs";
import { changelogSection, releaseChangelog, changeKinds, nextVersion } from "../scripts/changelog.mjs";
import { todoSections, plannedVersions, openItems } from "../scripts/todo.mjs";
import { planRelease, compareVersions } from "../scripts/plan.mjs";
import { galaxyVersion, setGalaxyVersion, cockpitVersion, setCockpitVersion } from "../scripts/collection.mjs";

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Added

- Unlock accounts

## [0.1.0] - 2026-10-22

### Added

- First release

[0.1.0]: https://example.invalid/v0.1.0
`;

describe("versionFromDescribe", () => {
    it("drops the v of the tag", () => {
        assert.equal(versionFromDescribe("v1.2.3\n"), "1.2.3");
    });

    it("keeps the distance from the tag and the dirty mark", () => {
        assert.equal(versionFromDescribe("v0.1.0-4-gabc1234-dirty"), "0.1.0-4-gabc1234-dirty");
    });
});

describe("SEMVER", () => {
    it("accepts releases and pre-releases", () => {
        for (const v of ["0.1.0", "1.0.0", "10.20.30", "1.0.0-rc.1"]) assert.ok(SEMVER.test(v), v);
    });

    it("rejects other forms", () => {
        for (const v of ["v1.0.0", "1.0", "01.0.0", "1.0.0-", "1.0.0 ", ""]) assert.ok(!SEMVER.test(v), v);
    });
});

describe("buildVersion", () => {
    const gitIn = (dir: string, ...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });

    function repo() {
        const dir = mkdtempSync(join(tmpdir(), "samba-dc-version-"));
        writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }));
        return dir;
    }

    function commitAll(dir: string) {
        gitIn(dir, "init", "--quiet", "--initial-branch=main");
        gitIn(dir, "add", ".");
        gitIn(dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
            "commit", "--quiet", "-m", "init");
    }

    it("uses package.json outside git", () => {
        const dir = repo();
        try {
            // Inside the system temp directory, which is not a repository.
            assert.equal(buildVersion(dir), "0.3.0");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("ignores the tags of an enclosing repository", () => {
        const outer = repo();
        try {
            commitAll(outer);
            gitIn(outer, "tag", "v9.9.9");
            const inner = join(outer, "unpacked");
            mkdirSync(inner);
            writeFileSync(join(inner, "package.json"), JSON.stringify({ version: "0.2.0" }));
            assert.equal(buildVersion(inner), "0.2.0");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("uses the tag, and the commit when there is none", () => {
        const dir = repo();
        try {
            commitAll(dir);
            assert.match(buildVersion(dir), /^0\.3\.0\+g[0-9a-f]+$/);
            gitIn(dir, "tag", "v0.3.0");
            assert.equal(buildVersion(dir), "0.3.0");
            writeFileSync(join(dir, "package.json"), "{\"version\": \"0.3.0\" }");
            assert.equal(buildVersion(dir), "0.3.0-dirty");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("changelogSection", () => {
    it("returns the body of a section", () => {
        assert.equal(changelogSection(CHANGELOG, "Unreleased"), "### Added\n\n- Unlock accounts");
    });

    it("leaves out the link definitions after the last section", () => {
        assert.equal(changelogSection(CHANGELOG, "0.1.0"), "### Added\n\n- First release");
    });

    it("returns null for a missing section", () => {
        assert.equal(changelogSection(CHANGELOG, "0.2.0"), null);
    });
});

describe("releaseChangelog", () => {
    it("moves the unreleased changes under the new version", () => {
        const out = releaseChangelog(CHANGELOG, "0.2.0", "2026-11-01");
        assert.equal(changelogSection(out, "Unreleased"), "");
        assert.equal(changelogSection(out, "0.2.0"), "### Added\n\n- Unlock accounts");
        assert.match(out, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-11-01\n\n### Added/);
        assert.equal(changelogSection(out, "0.1.0"), "### Added\n\n- First release");
    });

    it("refuses an empty Unreleased section", () => {
        const out = releaseChangelog(CHANGELOG, "0.2.0", "2026-11-01");
        assert.throws(() => releaseChangelog(out, "0.3.0", "2026-11-02"), /empty/);
    });

    it("refuses a version already released", () => {
        assert.throws(() => releaseChangelog(CHANGELOG, "0.1.0", "2026-11-01"), /already/);
    });
});

describe("nextVersion", () => {
    const kinds = (...k: string[]) => new Set(k);

    it("raises the minor number for features and, before 1.0.0, breaking changes", () => {
        assert.equal(nextVersion("0.1.0", kinds("Added", "Fixed")), "0.2.0");
        assert.equal(nextVersion("0.1.3", kinds("Changed")), "0.2.0");
        assert.equal(nextVersion("0.4.1", kinds("Breaking")), "0.5.0");
        assert.equal(nextVersion("0.4.1", kinds("Removed")), "0.5.0");
    });

    it("raises the patch number for fixes only", () => {
        assert.equal(nextVersion("0.2.0", kinds("Fixed")), "0.2.1");
        assert.equal(nextVersion("0.2.1", kinds("Fixed", "Security")), "0.2.2");
    });

    it("raises the major number for breaking changes from 1.0.0", () => {
        assert.equal(nextVersion("1.2.3", kinds("Breaking", "Added")), "2.0.0");
        assert.equal(nextVersion("1.2.3", kinds("Added")), "1.3.0");
    });

    it("refuses an empty set of changes", () => {
        assert.throws(() => nextVersion("0.1.0", kinds()), /empty/);
    });
});

describe("changeKinds", () => {
    it("counts only headings with entries", () => {
        assert.deepEqual(changeKinds("### Added\n\n- One\n\n### Fixed\n"), new Set(["Added"]));
    });

    it("refuses unknown headings and entries without one", () => {
        assert.throws(() => changeKinds("### New\n\n- One"), /unknown kind/);
        assert.throws(() => changeKinds("- One"), /no "### Kind"/);
    });
});

const TODO = `# TODO

## 0. Follow-ups

- [ ] **Stale entries.** Show them.

## 1. Versioning (done) — v0.1.0

- [x] Tags

## 3. Lockout — v0.2.0

- [x] **Unlock**
  - [ ] Bulk action

## 4. Password policy

- [ ] Edit the policy, with
      every field

| [?] | \`drs\` | Left out |
`;

describe("TODO.md plan", () => {
    it("reads the version at the end of a section heading", () => {
        const sections = todoSections(TODO);
        assert.deepEqual(sections.map(s => [s.title, s.version]), [
            ["0. Follow-ups", null],
            ["1. Versioning (done)", "0.1.0"],
            ["3. Lockout", "0.2.0"],
            ["4. Password policy", null],
        ]);
    });

    it("plans only the versions without a tag", () => {
        assert.deepEqual(plannedVersions(TODO, ["0.1.0"]), ["0.2.0"]);
        assert.deepEqual(plannedVersions(TODO, ["0.1.0", "0.2.0"]), []);
    });

    it("lists the open items of a planned version, nested ones too", () => {
        assert.deepEqual(openItems(TODO, "0.2.0"), ["3. Lockout: Bulk action"]);
        assert.deepEqual(openItems(TODO, "0.1.0"), []);
        assert.deepEqual(todoSections(TODO)[3].open, ["Edit the policy, with every field"]);
    });
});

describe("planRelease", () => {
    const ready = TODO.replace("  - [ ] Bulk action", "  - [x] Bulk action");
    const changelog = (body: string) => `# Changelog\n\n## [Unreleased]\n\n${body}\n\n## [0.1.0] - 2026-10-22\n\n### Added\n\n- First\n`;
    const plan = (opts: { todo?: string; body?: string; requested?: string; released?: string[] }) => planRelease({
        changelog: changelog(opts.body ?? "### Added\n\n- Unlock\n\n### Fixed\n\n- Refresh"),
        todo: opts.todo ?? ready,
        released: opts.released ?? ["0.1.0"],
        requested: opts.requested,
    });

    it("agrees when the changelog and the plan give the same version", () => {
        const p = plan({});
        assert.deepEqual(p.problems, []);
        assert.equal(p.version, "0.2.0");
    });

    it("stops on open items of the planned sections", () => {
        assert.deepEqual(plan({ todo: TODO }).problems, ["open in TODO.md: 3. Lockout: Bulk action"]);
    });

    it("stops when only fixes are listed but a feature release is planned", () => {
        const p = plan({ body: "### Fixed\n\n- Refresh" });
        assert.equal(p.computed, "0.1.1");
        assert.match(p.problems.join(), /TODO.md plans v0\.2\.0, the release would be v0\.1\.1/);
    });

    it("allows a fix release with no plan", () => {
        const p = plan({ body: "### Fixed\n\n- Refresh", todo: ready.replace(" — v0.2.0", "") });
        assert.deepEqual(p.problems, []);
        assert.equal(p.version, "0.1.1");
    });

    it("asks to plan a feature release", () => {
        const p = plan({ todo: ready.replace(" — v0.2.0", "") });
        assert.match(p.problems.join(), /TODO.md does not plan it/);
    });

    it("refuses more than one planned release", () => {
        const p = plan({ todo: ready.replace("## 4. Password policy", "## 4. Password policy — v0.3.0") });
        assert.match(p.problems.join(), /more than one release/);
    });

    it("accepts a higher requested version only if the plan names it", () => {
        assert.match(plan({ requested: "1.0.0" }).problems.join(), /plans v0\.2\.0, the release would be v1\.0\.0/);
        assert.deepEqual(plan({ requested: "1.0.0", todo: ready.replace("v0.2.0", "v1.0.0") }).problems, []);
        assert.match(plan({ requested: "0.1.5" }).problems.join(), /at least v0\.2\.0/);
        assert.match(plan({ requested: "0.1.0" }).problems.join(), /already released/);
    });
});

describe("compareVersions", () => {
    it("compares numerically", () => {
        assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
        assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), 0);
    });
});

describe("collection version", () => {
    const galaxy = "namespace: lineadicomando\nname: samba_dc\nversion: 0.7.0\nreadme: README.md\n";
    const defaults = "samba_dc_build_cockpit_install: package\n# comment\nsamba_dc_build_cockpit_version: \"0.2.1\"\nother: 1\n";

    it("reads and writes galaxy.yml", () => {
        assert.equal(galaxyVersion(galaxy), "0.7.0");
        const out = setGalaxyVersion(galaxy, "0.3.0");
        assert.equal(out, galaxy.replace("version: 0.7.0", "version: 0.3.0"));
    });

    it("reads and writes the release samba_dc_build installs", () => {
        assert.equal(cockpitVersion(defaults), "0.2.1");
        assert.equal(setCockpitVersion(defaults, "0.3.0"), defaults.replace('"0.2.1"', '"0.3.0"'));
    });

    it("matches the files of the repository", () => {
        assert.match(galaxyVersion(readFileSync("ansible/galaxy.yml", "utf8")), /^\d+\.\d+\.\d+$/);
        assert.match(cockpitVersion(readFileSync("ansible/roles/samba_dc_build/defaults/main.yaml", "utf8")), /^\d+\.\d+\.\d+$/);
    });

    it("refuses a file without a version line", () => {
        assert.throws(() => galaxyVersion("name: x\n"), /no version line/);
    });
});
