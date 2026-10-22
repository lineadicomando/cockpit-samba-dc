import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEMVER, buildVersion, versionFromDescribe } from "../scripts/version.mjs";
import { changelogSection, releaseChangelog } from "../scripts/changelog.mjs";

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
