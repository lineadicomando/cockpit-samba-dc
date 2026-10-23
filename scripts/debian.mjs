// Debian packaging helper.
//
//   node scripts/debian.mjs changelog   (make deb-changelog)
//       Print debian/changelog for the version being built: the git tag
//       (scripts/version.mjs), with the CHANGELOG.md entries of a release.
//   node scripts/debian.mjs version
//       Print the Debian version of the build.
//
// debian/changelog is not tracked: the tag is the only source of the
// version, and this file is written from it before each package build.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { changelogSection } from "./changelog.mjs";
import { SEMVER, buildVersion } from "./version.mjs";

const PACKAGE = "cockpit-samba-dc";
const DEBIAN_VERSION = /^[0-9][A-Za-z0-9.+~]*$/;

// Module version → Debian version of a native package (no hyphens):
//   "1.2.3"                      → "1.2.3"
//   "1.0.0-rc.1"                 → "1.0.0~rc.1"   (sorts before 1.0.0)
//   "1.2.3-4-gabc1234-dirty"     → "1.2.3+4.gabc1234.dirty"
//   "0.1.0+gabc1234.dirty"       → unchanged (build before the first tag)
export function debianVersion(version) {
    const m = /^(.+?)(?:-(\d+)-g([0-9a-f]+))?(-dirty)?$/.exec(version);
    if (!m) throw new Error(`cannot turn "${version}" into a Debian version`);
    const [, base, distance, hash, dirty] = m;
    const extra = [];
    if (distance) extra.push(distance, `g${hash}`);
    if (dirty) extra.push("dirty");
    // A semver pre-release (after the first hyphen) sorts before the
    // release, as "~" does in Debian; hyphens inside it become dots.
    const i = base.indexOf("-");
    let deb = i < 0 ? base : `${base.slice(0, i)}~${base.slice(i + 1).replaceAll("-", ".")}`;
    if (extra.length) deb += (deb.includes("+") ? "." : "+") + extra.join(".");
    if (!DEBIAN_VERSION.test(deb)) throw new Error(`"${deb}" (from "${version}") is not a Debian version`);
    return deb;
}

// CHANGELOG.md section (Keep a Changelog) → Debian changelog items:
// "### Added" → "  * Added:", "- item" → "    - item", continuations
// indented to match.
export function debianItems(section) {
    const out = [];
    for (const line of section.split("\n")) {
        if (!line.trim()) continue;
        const heading = /^###\s+(.*)$/.exec(line);
        if (heading) out.push(`  * ${heading[1]}:`);
        else if (line.startsWith("- ")) out.push(`    ${line}`);
        else out.push(`      ${line.trim()}`);
    }
    return out;
}

// One changelog entry. `notes` is the CHANGELOG.md section of a release,
// null for a build between releases.
export function debianChangelog({ version, notes, maintainer, date }) {
    const deb = debianVersion(version);
    const items = notes ? debianItems(notes) : [`  * Development build ${version}, not a release.`];
    if (!items.length) items.push(`  * Release ${version}.`);
    return [
        `${PACKAGE} (${deb}) unstable; urgency=medium`,
        "",
        ...items,
        "",
        ` -- ${maintainer}  ${date}`,
        "",
    ].join("\n");
}

function maintainer() {
    const m = /^Maintainer:\s*(.+)$/m.exec(readFileSync("debian/control", "utf8"));
    if (!m) throw new Error("debian/control has no Maintainer field");
    return m[1].trim();
}

// RFC 2822 date of the commit being built, so that the same commit gives the
// same changelog; now, without git metadata.
function changelogDate() {
    try {
        return execFileSync("git", ["log", "-1", "--format=%cD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        const d = new Date();
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const p = (n) => String(n).padStart(2, "0");
        return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
            `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
    }
}

function main(command) {
    const version = buildVersion();
    if (command === "version") {
        process.stdout.write(debianVersion(version) + "\n");
    } else if (command === "changelog") {
        const notes = SEMVER.test(version)
            ? changelogSection(readFileSync("CHANGELOG.md", "utf8"), version)
            : null;
        process.stdout.write(debianChangelog({ version, notes, maintainer: maintainer(), date: changelogDate() }));
    } else {
        console.error("usage: node scripts/debian.mjs changelog|version");
        process.exit(1);
    }
}

// Run as a script, not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv[2]);
    } catch (e) {
        console.error(`debian: ${e.message}`);
        process.exit(1);
    }
}
