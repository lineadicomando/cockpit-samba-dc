// Runs drivemaps.ts against a stateful fake DC built on the spawn() test
// double: sysvol files, the GPO object and the domain gPLink.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import {
    parseDrivesXml, buildDriveXml, buildDrivesXml, buildFiltersXml,
    setDriveMapping, listDriveMappings,
} from "../src/lib/drivemaps.ts";

const BASE = "DC=school,DC=internal";
const DEFAULT_LINK = `[LDAP://CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,${BASE};0]`;
const SIDS: Record<string, string> = {
    teachers: "S-1-5-21-1-2-3-1108",
    students: "S-1-5-21-1-2-3-1107",
    mrossi: "S-1-5-21-1-2-3-1200",
};

function isCmd(call: SpawnCall, ...prefix: string[]): boolean {
    return prefix.every((p, i) => call.args[i] === p);
}

function fakeDc() {
    const files = new Map<string, string>();
    const dc = {
        files,
        gpo: null as { guid: string; version: number } | null,
        gplink: DEFAULT_LINK,
        ldbadds: 0,
    };
    setSpawnHandler(call => {
        const a = call.args;
        if (isCmd(call, "testparm")) {
            const param = a.find(x => x.startsWith("--parameter-name="))!.split("=")[1];
            return ({ "netbios name": "DC", workgroup: "SCHOOL", realm: "SCHOOL.INTERNAL", path: "/var/lib/samba/sysvol" } as Record<string, string>)[param] + "\n";
        }
        if (isCmd(call, "ldbsearch")) {
            if (a.includes("defaultNamingContext")) return `dn: \ndefaultNamingContext: ${BASE}\n`;
            if (a.includes("gPLink")) return `dn: ${BASE}\ngPLink: ${dc.gplink}\n`;
            const filter = a.find(x => x.startsWith("(")) ?? "";
            if (filter.includes("groupPolicyContainer")) {
                return dc.gpo
                    ? `dn: CN=${dc.gpo.guid},CN=Policies,CN=System,${BASE}\ncn: ${dc.gpo.guid}\nversionNumber: ${dc.gpo.version}\n`
                    : "";
            }
            return [...filter.matchAll(/sAMAccountName=([^)]+)/g)]
                .map(([, n]) => n)
                .filter(n => SIDS[n.toLowerCase()])
                .map(n => `dn: CN=${n},CN=Users,${BASE}\nsAMAccountName: ${n}\nobjectSid: ${SIDS[n.toLowerCase()]}\n`)
                .join("\n");
        }
        if (isCmd(call, "ldbadd")) {
            dc.ldbadds++;
            const guid = /^dn: CN=(\{[^}]+\})/.exec(call.input ?? "")![1];
            dc.gpo = { guid, version: 0 };
            return "Added 3 records successfully\n";
        }
        if (isCmd(call, "ldbmodify")) {
            const version = /versionNumber: (\d+)/.exec(call.input ?? "");
            if (version) dc.gpo!.version = Number(version[1]);
            const link = /gPLink: (.*)/.exec(call.input ?? "");
            if (link) dc.gplink = link[1];
            return "";
        }
        if (isCmd(call, "tee")) { files.set(a[1], call.input ?? ""); return call.input ?? ""; }
        if (isCmd(call, "cp")) {
            // cp --attributes-only --preserve=… SOURCE DEST
            if (!files.has(a[3])) throw new Error(`cp: cannot stat '${a[3]}': No such file or directory`);
            return "";
        }
        if (isCmd(call, "mv")) { files.set(a[3], files.get(a[2])!); files.delete(a[2]); return ""; }
        if (isCmd(call, "cat")) {
            if (!files.has(a[1])) throw new Error("No such file or directory");
            return files.get(a[1])!;
        }
        return "";
    });
    return dc;
}

function drivesFile(dc: ReturnType<typeof fakeDc>): string {
    const path = [...dc.files.keys()].find(p => p.endsWith("/USER/Preferences/Drives/Drives.xml"));
    return path ? dc.files.get(path)! : "";
}

describe("Drives.xml", () => {
    it("round-trips drive entries, escaping XML special characters", () => {
        const filters = buildFiltersXml([
            { name: "Teachers", kind: "group", sid: SIDS.teachers },
            { name: "mrossi", kind: "user", sid: SIDS.mrossi },
        ], "SCHOOL");
        const xml = buildDrivesXml([buildDriveXml({
            uid: "{U1}", changed: "2026-09-18 10:00:00",
            path: "\\\\DC\\R&D docs", letter: "p", label: "R&D <docs>", filters,
        })]);
        const [d] = parseDrivesXml(xml);
        assert.equal(d.uid, "{U1}");
        assert.equal(d.path, "\\\\DC\\R&D docs");
        assert.equal(d.letter, "P");
        assert.equal(d.label, "R&D <docs>");
        assert.equal(d.filters, filters);
        assert.ok(xml.includes('name="P:"'));
        assert.ok(filters.includes(`<FilterGroup bool="OR" not="0" name="SCHOOL\\Teachers" sid="${SIDS.teachers}" userContext="1"`));
        assert.ok(filters.includes(`<FilterUser bool="OR" not="0" name="SCHOOL\\mrossi" sid="${SIDS.mrossi}"/>`));
    });
});

describe("setDriveMapping", () => {
    it("creates and links the GPO once, even for concurrent calls", async () => {
        const dc = fakeDc();
        await Promise.all([
            setDriveMapping("docs", [{ name: "Teachers", kind: "group", level: "write" }], { letter: "P", label: "" }),
            setDriveMapping("lab", [{ name: "Students", kind: "group", level: "read" }], { letter: "L", label: "Lab" }),
        ]);
        assert.equal(dc.ldbadds, 1);
        const guid = dc.gpo!.guid;
        assert.match(guid, /^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
        assert.equal(dc.gplink, `${DEFAULT_LINK}[LDAP://CN=${guid},CN=Policies,CN=System,${BASE};0]`);

        const add = calls.find(c => isCmd(c, "ldbadd"))!;
        assert.ok(add.input!.includes(`gPCFileSysPath: \\\\school.internal\\sysvol\\school.internal\\Policies\\${guid}`));
        assert.ok(add.input!.includes("gPCUserExtensionNames: [{00000000-0000-0000-0000-000000000000}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}][{5794DAFD-BE60-433F-88A2-1A31939AC01F}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]"));

        // Two writes: user version 2, in both AD and GPT.INI
        assert.equal(dc.gpo!.version, 2 * 65536);
        assert.match(dc.files.get(`/var/lib/samba/sysvol/school.internal/Policies/${guid}/GPT.INI`)!, /Version=131072\r\n/);
        assert.ok(calls.some(c => c.args.join(" ") === "samba-tool ntacl sysvolreset"));

        const drives = parseDrivesXml(drivesFile(dc));
        assert.deepEqual(drives.map(d => [d.path, d.letter, d.label]), [
            ["\\\\DC\\docs", "P", "docs"],
            ["\\\\DC\\lab", "L", "Lab"],
        ]);
        assert.deepEqual([...await listDriveMappings()], [
            ["docs", { letter: "P", label: "docs" }],
            ["lab", { letter: "L", label: "Lab" }],
        ]);
    });

    it("updates an entry in place, keeps its uid and skips no-op writes", async () => {
        const dc = fakeDc();
        const teachers = [{ name: "Teachers", kind: "group" as const, level: "write" as const }];
        await setDriveMapping("docs", teachers, { letter: "P", label: "Docs" });
        const uid = parseDrivesXml(drivesFile(dc))[0].uid;

        await setDriveMapping("docs", [...teachers, { name: "mrossi", kind: "user", level: "read" }], { letter: "Q", label: "Docs" });
        const [d] = parseDrivesXml(drivesFile(dc));
        assert.equal(d.uid, uid);
        assert.equal(d.letter, "Q");
        assert.ok(d.filters.includes("FilterUser"));
        const version = dc.gpo!.version;

        await setDriveMapping("DOCS", [...teachers, { name: "mrossi", kind: "user", level: "read" }], { letter: "q", label: "Docs" });
        assert.equal(dc.gpo!.version, version);
    });

    it("resets the sysvol ACLs only when it writes a new file", async () => {
        const dc = fakeDc();
        const teachers = [{ name: "Teachers", kind: "group" as const, level: "write" as const }];
        const resets = () => calls.filter(c => c.args.join(" ") === "samba-tool ntacl sysvolreset").length;
        await setDriveMapping("docs", teachers, { letter: "P", label: "" });
        assert.equal(resets(), 1);

        await setDriveMapping("lab", teachers, { letter: "L", label: "" });
        assert.equal(resets(), 1);
        // The replacement takes the NT ACL of the file it replaces
        const dir = `/var/lib/samba/sysvol/school.internal/Policies/${dc.gpo!.guid}`;
        assert.ok(calls.some(c => c.args.join(" ") ===
            `cp --attributes-only --preserve=mode,ownership,xattr ${dir}/GPT.INI ${dir}/GPT.INI.tmp`));

        dc.files.delete(`${dir}/USER/Preferences/Drives/Drives.xml`); // removed by hand
        await setDriveMapping("lab", [], null);
        await setDriveMapping("docs", teachers, { letter: "Q", label: "" });
        assert.equal(resets(), 2);
    });

    it("removes a mapping and rejects a letter used by another share", async () => {
        const dc = fakeDc();
        const teachers = [{ name: "Teachers", kind: "group" as const, level: "write" as const }];
        await setDriveMapping("docs", teachers, { letter: "P", label: "" });
        await setDriveMapping("lab", teachers, { letter: "L", label: "" });
        await assert.rejects(setDriveMapping("lab", teachers, { letter: "P", label: "" }), /already used/);

        await setDriveMapping("docs", [], null);
        assert.deepEqual(parseDrivesXml(drivesFile(dc)).map(d => d.path), ["\\\\DC\\lab"]);
    });

    it("links an existing GPO that was left unlinked", async () => {
        const dc = fakeDc();
        const teachers = [{ name: "Teachers", kind: "group" as const, level: "write" as const }];
        await setDriveMapping("docs", teachers, { letter: "P", label: "" });
        dc.gplink = DEFAULT_LINK; // e.g. the link write failed after the GPO was created
        await setDriveMapping("lab", teachers, { letter: "L", label: "" });
        assert.equal(dc.ldbadds, 1);
        assert.equal(dc.gplink, `${DEFAULT_LINK}[LDAP://CN=${dc.gpo!.guid},CN=Policies,CN=System,${BASE};0]`);
    });

    it("does nothing when removing a mapping and no GPO exists", async () => {
        const dc = fakeDc();
        await setDriveMapping("docs", [], null);
        assert.equal(dc.gpo, null);
        assert.ok(!calls.some(c => isCmd(c, "tee") || isCmd(c, "ldbadd") || isCmd(c, "ldbmodify")));
    });

    it("rejects unknown principals and invalid letters before writing", async () => {
        fakeDc();
        await assert.rejects(
            setDriveMapping("docs", [{ name: "ghost", kind: "user", level: "read" }], { letter: "P", label: "" }),
            /Unknown user or group: ghost/,
        );
        for (const letter of ["H", "C", "1"]) {
            await assert.rejects(
                setDriveMapping("docs", [{ name: "Teachers", kind: "group", level: "read" }], { letter, label: "" }),
                /Invalid drive letter/,
            );
        }
        assert.ok(!calls.some(c => isCmd(c, "tee") || isCmd(c, "ldbadd")));
    });
});
