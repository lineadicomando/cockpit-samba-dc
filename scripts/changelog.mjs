// CHANGELOG.md follows https://keepachangelog.com: an "## [Unreleased]"
// section collects the changes until a release turns it into
// "## [X.Y.Z] - YYYY-MM-DD".

const HEADING = /^## \[([^\]]+)\]/;

function sections(text) {
    const lines = text.split("\n");
    const found = [];
    lines.forEach((line, i) => {
        const m = HEADING.exec(line);
        if (m) found.push({ name: m[1], start: i });
    });
    return { lines, found };
}

// Body of a section, without its heading and surrounding blank lines;
// null when the section does not exist.
export function changelogSection(text, name) {
    const { lines, found } = sections(text);
    const idx = found.findIndex((s) => s.name === name);
    if (idx < 0) return null;
    const end = idx + 1 < found.length ? found[idx + 1].start : lines.length;
    let body = lines.slice(found[idx].start + 1, end);
    // Link reference definitions at the end of the file are not part of it.
    if (idx + 1 === found.length) {
        const firstRef = body.findIndex((l) => /^\[[^\]]+\]: /.test(l));
        if (firstRef >= 0) body = body.slice(0, firstRef);
    }
    return body.join("\n").trim();
}

// Moves the Unreleased changes under a new version heading and leaves an
// empty Unreleased section above it.
export function releaseChangelog(text, version, date) {
    if (changelogSection(text, version) !== null) {
        throw new Error(`CHANGELOG.md already has a section for ${version}`);
    }
    const unreleased = changelogSection(text, "Unreleased");
    if (unreleased === null) throw new Error("CHANGELOG.md has no [Unreleased] section");
    if (unreleased === "") throw new Error("The [Unreleased] section of CHANGELOG.md is empty");
    return text.replace(
        /^## \[Unreleased\][^\n]*\n/m,
        `## [Unreleased]\n\n## [${version}] - ${date}\n`,
    );
}
