// TODO.md plans the next release: the heading of each section that goes into
// it ends with its version, "## 3. Account lockout and expiry — v0.2.0".
// Sections keep the version once released, as a record.

const SECTION = /^## (.+?)\s*$/;
const VERSION_MARK = /\s—\s*v(\d+\.\d+\.\d+)\s*$/;
const OPEN_ITEM = /^\s*- \[ \] (.+)$/;

// [{ title, version (or null), open: [item text] }]
export function todoSections(text) {
    const sections = [];
    let current = null;
    let item = null; // index of the open item a continuation line belongs to
    for (const line of text.split("\n")) {
        const heading = SECTION.exec(line);
        if (heading) {
            const mark = VERSION_MARK.exec(heading[1]);
            current = {
                title: heading[1].replace(VERSION_MARK, ""),
                version: mark ? mark[1] : null,
                open: [],
            };
            sections.push(current);
            item = null;
            continue;
        }
        const open = current && OPEN_ITEM.exec(line);
        if (open) {
            current.open.push(open[1].replace(/\*\*/g, "").trim());
            item = current.open.length - 1;
        } else if (item !== null && /^\s{2,}\S/.test(line) && !/^\s*- \[/.test(line)) {
            current.open[item] += " " + line.trim().replace(/\*\*/g, "");
        } else {
            item = null;
        }
    }
    return sections;
}

// Versions named in TODO.md that have no tag yet.
export function plannedVersions(text, releasedVersions) {
    const released = new Set(releasedVersions);
    return [...new Set(
        todoSections(text).map((s) => s.version).filter((v) => v && !released.has(v)),
    )];
}

// Open items of the sections planned for a version: "section: item".
export function openItems(text, version) {
    return todoSections(text)
        .filter((s) => s.version === version)
        .flatMap((s) => s.open.map((item) => `${s.title}: ${item}`));
}
