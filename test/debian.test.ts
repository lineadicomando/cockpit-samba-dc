import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { debianChangelog, debianItems, debianVersion } from "../scripts/debian.mjs";

describe("debianVersion", () => {
    it("keeps a release as it is", () => {
        assert.equal(debianVersion("1.2.3"), "1.2.3");
    });
    it("sorts a pre-release before its release", () => {
        assert.equal(debianVersion("1.0.0-rc.1"), "1.0.0~rc.1");
        assert.equal(debianVersion("1.0.0-beta-2"), "1.0.0~beta.2");
    });
    it("turns the distance from the tag into a +suffix", () => {
        assert.equal(debianVersion("0.1.0-4-gabc1234"), "0.1.0+4.gabc1234");
        assert.equal(debianVersion("0.1.0-4-gabc1234-dirty"), "0.1.0+4.gabc1234.dirty");
        assert.equal(debianVersion("0.1.0-dirty"), "0.1.0+dirty");
        assert.equal(debianVersion("1.0.0-rc.1-2-gabc1234"), "1.0.0~rc.1+2.gabc1234");
    });
    it("keeps the build before the first tag", () => {
        assert.equal(debianVersion("0.1.0+gabc1234.dirty"), "0.1.0+gabc1234.dirty");
    });
    it("refuses what Debian cannot order", () => {
        assert.throws(() => debianVersion("v1.0.0"));
        assert.throws(() => debianVersion("1.0.0 beta"));
    });
});

describe("debianChangelog", () => {
    const base = {
        maintainer: "A Maintainer <a@example.invalid>",
        date: "Thu, 22 Oct 2026 10:00:00 +0200",
    };

    it("lists the CHANGELOG.md entries of a release", () => {
        const notes = "### Added\n\n- Users: list, create,\n  delete.\n- Groups.\n\n### Fixed\n\n- A bug.";
        assert.equal(debianChangelog({ ...base, version: "0.2.0", notes }), [
            "cockpit-samba-dc (0.2.0) unstable; urgency=medium",
            "",
            "  * Added:",
            "    - Users: list, create,",
            "      delete.",
            "    - Groups.",
            "  * Fixed:",
            "    - A bug.",
            "",
            " -- A Maintainer <a@example.invalid>  Thu, 22 Oct 2026 10:00:00 +0200",
            "",
        ].join("\n"));
    });

    it("marks a build between releases", () => {
        const text = debianChangelog({ ...base, version: "0.1.0-3-gabc1234", notes: null });
        assert.match(text, /^cockpit-samba-dc \(0\.1\.0\+3\.gabc1234\) unstable; urgency=medium\n/);
        assert.match(text, /\n {2}\* Development build 0\.1\.0-3-gabc1234, not a release\.\n/);
    });

    it("keeps items within 80 columns when CHANGELOG.md does", () => {
        const line = "- " + "x".repeat(74);
        assert.ok(debianItems(line).every((l) => l.length <= 80));
    });
});
