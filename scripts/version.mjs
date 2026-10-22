// The module's version comes from the git tag (vX.Y.Z on main). Builds from a
// tree without git metadata (a source tarball) fall back to package.json,
// which `make release` keeps equal to the tag.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

// `git describe --tags --match "v[0-9]*" --dirty` output → version string:
// "v1.2.3" → "1.2.3", "v1.2.3-4-gabc1234-dirty" → "1.2.3-4-gabc1234-dirty".
export function versionFromDescribe(describe) {
    const out = describe.trim();
    return out.startsWith("v") ? out.slice(1) : out;
}

function git(dir, args) {
    return execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim();
}

export function packageVersion(dir) {
    return JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).version;
}

export function buildVersion(dir = process.cwd()) {
    const pkg = packageVersion(dir);
    let top;
    try {
        top = git(dir, ["rev-parse", "--show-toplevel"]);
    } catch {
        return pkg;
    }
    // A tarball unpacked inside another repository must not take its tags.
    if (realpathSync(top) !== realpathSync(dir)) return pkg;
    try {
        return versionFromDescribe(git(dir, ["describe", "--tags", "--match", "v[0-9]*", "--dirty"]));
    } catch {
        // No tag yet (or a shallow clone without tags).
        try {
            const dirty = git(dir, ["status", "--porcelain", "--untracked-files=no"]) ? ".dirty" : "";
            return `${pkg}+g${git(dir, ["rev-parse", "--short", "HEAD"])}${dirty}`;
        } catch {
            return pkg;
        }
    }
}
