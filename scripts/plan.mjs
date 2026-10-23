// The version of the next release, computed from CHANGELOG.md and checked
// against the plan in TODO.md (README, "Versions and releases").
import { changelogSection, changeKinds, nextVersion } from "./changelog.mjs";
import { plannedVersions, openItems } from "./todo.mjs";
import { SEMVER } from "./version.mjs";

function numbers(version) {
    return version.split(/[-+]/)[0].split(".").map(Number);
}

export function compareVersions(a, b) {
    const [x, y] = [numbers(a), numbers(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}

export function latestVersion(versions) {
    return [...versions].sort(compareVersions).at(-1) ?? null;
}

// changelog, todo: file contents; released: versions with a tag ("0.1.0");
// requested: the VERSION given to `make release`, if any.
// Returns { version, computed, planned, current, problems }: the release may
// go ahead only when problems is empty.
export function planRelease({ changelog, todo, released, requested }) {
    const problems = [];
    const current = latestVersion(released) ?? "0.0.0";
    const planned = plannedVersions(todo, released);

    let computed = null;
    try {
        const unreleased = changelogSection(changelog, "Unreleased");
        if (unreleased === null) throw new Error("CHANGELOG.md has no [Unreleased] section");
        computed = nextVersion(current, changeKinds(unreleased));
    } catch (e) {
        problems.push(e.message);
    }

    if (requested !== undefined && requested !== "" && !SEMVER.test(requested)) {
        problems.push(`"${requested}" is not a version of the form X.Y.Z`);
        return { version: null, computed, planned, current, problems };
    }
    const version = requested || computed;
    if (!version) return { version, computed, planned, current, problems };
    const base = version.split("-")[0];

    if (released.includes(version)) problems.push(`v${version} is already released`);
    if (computed && compareVersions(version, computed) < 0) {
        problems.push(`CHANGELOG.md asks for at least v${computed}, not v${version}`);
    }
    if (planned.length > 1) {
        problems.push(`TODO.md plans more than one release (${planned.map((v) => `v${v}`).join(", ")}): only the next one gets a version`);
    } else if (planned.length === 1 && planned[0] !== base) {
        problems.push(`TODO.md plans v${planned[0]}, the release would be v${base}` +
            (computed ? ` (CHANGELOG.md gives v${computed})` : "") +
            ": change the plan in TODO.md, or the kinds of change in CHANGELOG.md");
    } else if (planned.length === 0 && numbers(base)[2] === 0) {
        problems.push(`v${base} has new features but TODO.md does not plan it: end the heading of its sections with "— v${base}"`);
    }
    for (const item of openItems(todo, base)) problems.push(`open in TODO.md: ${item}`);

    return { version, computed, planned, current, problems };
}
