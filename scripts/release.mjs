// Release helper.
//
//   node scripts/release.mjs next [X.Y.Z]  (make next-version [VERSION=X.Y.Z])
//       The version of the next release: computed from the kinds of change
//       under [Unreleased] in CHANGELOG.md, checked against the plan in
//       TODO.md (see scripts/plan.mjs).
//   node scripts/release.mjs prepare [X.Y.Z]   (make release [VERSION=X.Y.Z])
//       On a clean main, when the plan has no problems: run the checks, date
//       the Unreleased changes in CHANGELOG.md, set the version in
//       package.json and in the Ansible collection (scripts/collection.mjs),
//       commit, tag vX.Y.Z. Nothing is pushed. X.Y.Z, when
//       given, may only be higher than the computed version (e.g. 1.0.0).
//   node scripts/release.mjs verify vX.Y.Z
//       The tag matches package.json and CHANGELOG.md (release workflow).
//   node scripts/release.mjs notes X.Y.Z
//       Print the CHANGELOG.md section of a version (release notes).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { changelogSection, releaseChangelog } from "./changelog.mjs";
import { SEMVER, packageVersion } from "./version.mjs";
import { planRelease } from "./plan.mjs";
import { GALAXY, COCKPIT_DEFAULTS, galaxyVersion, setGalaxyVersion, cockpitVersion, setCockpitVersion } from "./collection.mjs";

const CHANGELOG = "CHANGELOG.md";
const TODO = "TODO.md";

function fail(message) {
    console.error(`release: ${message}`);
    process.exit(1);
}

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function git(...args) {
    return run("git", args).trim();
}

function checkVersion(version) {
    if (!version || !SEMVER.test(version)) fail(`"${version ?? ""}" is not a version of the form X.Y.Z`);
}

function releasedVersions() {
    return git("tag", "--list", "v[0-9]*").split("\n").filter(Boolean).map((t) => t.slice(1));
}

function plan(requested) {
    return planRelease({
        changelog: readFileSync(CHANGELOG, "utf8"),
        todo: readFileSync(TODO, "utf8"),
        released: releasedVersions(),
        requested,
    });
}

function next(requested) {
    const p = plan(requested);
    console.log(`last release: v${p.current}`);
    console.log(`CHANGELOG.md: ${p.computed ? `v${p.computed}` : "-"}`);
    console.log(`TODO.md plan: ${p.planned.length ? p.planned.map((v) => `v${v}`).join(", ") : "-"}`);
    if (p.problems.length) {
        console.log("not ready:");
        for (const problem of p.problems) console.log(`  - ${problem}`);
        process.exit(1);
    }
    console.log(`ready: make release${requested ? ` VERSION=${requested}` : ""} (v${p.version})`);
}

function prepare(requested) {
    const p = plan(requested);
    if (p.problems.length) fail(`not ready for a release:\n  - ${p.problems.join("\n  - ")}`);
    const version = p.version;
    checkVersion(version);
    const tag = `v${version}`;
    if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("releases are tagged on main");
    if (git("status", "--porcelain")) fail("the work tree is not clean");
    if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);

    const date = new Date().toISOString().slice(0, 10);
    let changelog;
    try {
        changelog = releaseChangelog(readFileSync(CHANGELOG, "utf8"), version, date);
    } catch (e) {
        fail(e.message);
    }

    console.log("release: type check and tests");
    run("npx", ["tsc", "--noEmit"], { stdio: "inherit" });
    run("npm", ["test"], { stdio: "inherit" });

    writeFileSync(CHANGELOG, changelog);
    writeFileSync(GALAXY, setGalaxyVersion(readFileSync(GALAXY, "utf8"), version));
    writeFileSync(COCKPIT_DEFAULTS, setCockpitVersion(readFileSync(COCKPIT_DEFAULTS, "utf8"), version));
    if (packageVersion(".") !== version) {
        // Updates package.json and package-lock.json together.
        run("npm", ["version", version, "--no-git-tag-version"], { stdio: "ignore" });
    }
    run("git", ["add", CHANGELOG, "package.json", "package-lock.json", GALAXY, COCKPIT_DEFAULTS]);
    run("git", ["commit", "--quiet", "-m", `Release ${tag}`]);
    run("git", ["tag", "--annotate", tag, "-m", `cockpit-samba-dc ${version}`]);
    console.log(`release: committed and tagged ${tag}. Publish with:\n  git push origin main ${tag}`);
}

function verify(tag) {
    if (!tag?.startsWith("v")) fail(`"${tag ?? ""}" is not a release tag vX.Y.Z`);
    const version = tag.slice(1);
    checkVersion(version);
    const pkg = packageVersion(".");
    if (pkg !== version) fail(`package.json has version ${pkg}, the tag ${tag}`);
    const galaxy = galaxyVersion(readFileSync(GALAXY, "utf8"));
    if (galaxy !== version) fail(`${GALAXY} has version ${galaxy}, the tag ${tag}`);
    const cockpit = cockpitVersion(readFileSync(COCKPIT_DEFAULTS, "utf8"));
    if (cockpit !== version) fail(`${COCKPIT_DEFAULTS} installs cockpit-samba-dc ${cockpit}, the tag is ${tag}`);
    const notes = changelogSection(readFileSync(CHANGELOG, "utf8"), version);
    if (!notes) fail(`CHANGELOG.md has no entries for ${version}`);
}

function notes(version) {
    checkVersion(version);
    const body = changelogSection(readFileSync(CHANGELOG, "utf8"), version);
    if (!body) fail(`CHANGELOG.md has no entries for ${version}`);
    process.stdout.write(body + "\n");
}

const [command, arg] = process.argv.slice(2);
switch (command) {
    case "next": next(arg); break;
    case "prepare": prepare(arg); break;
    case "verify": verify(arg); break;
    case "notes": notes(arg); break;
    default: fail("usage: release.mjs next [X.Y.Z] | prepare [X.Y.Z] | verify vX.Y.Z | notes X.Y.Z");
}
