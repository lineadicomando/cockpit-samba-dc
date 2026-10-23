// Runs shares.ts against the spawn() test double (see cockpit-loader.mjs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import { listShares, createShare, updateShare, deleteShare, effectiveShareAccess, expandNestedGroups, renameSharePrincipal, isManagedPath } from "../src/lib/shares.ts";

const NET_CONF = [
    "[home]",
    "\tpath = /srv/samba/home",
    "\tread only = no",
    "",
    "[docs]",
    "\tpath = /srv/samba/shares/docs",
    "\tread only = no",
    "\tvalid users = @\"SCHOOL\\Teachers\" @\"SCHOOL\\Students\" \"SCHOOL\\mrossi\"",
    "\tread list = @\"SCHOOL\\Students\"",
    "\tcomment = Documents",
    "\tbrowseable = no",
    "",
    "[manual]",
    "\tpath = /data/manual",
    "",
].join("\n");

function isCmd(call: SpawnCall, ...prefix: string[]): boolean {
    return prefix.every((p, i) => call.args[i] === p);
}

// Answers like the DC: every principal resolves except those in "unknown".
function handler(unknown: string[] = []) {
    return (call: SpawnCall): string => {
        if (isCmd(call, "testparm")) return "SCHOOL\n";
        if (isCmd(call, "ldbsearch") && call.args.includes("base") && call.args.includes("")) {
            return "dn: \ndefaultNamingContext: DC=school,DC=internal\n";
        }
        if (isCmd(call, "net", "conf", "list")) return NET_CONF;
        if (isCmd(call, "getent")) {
            const name = call.args[2].split("\\")[1];
            if (unknown.includes(name.toLowerCase())) throw new Error("exit status 2");
            return `${call.args[2]}:*:3000022:3000022::/home:/bin/false\n`;
        }
        return "";
    };
}

function setparm(param: string): string | undefined {
    return calls.find(c => isCmd(c, "net", "conf", "setparm") && c.args[4] === param)?.args[5];
}

function setfaclSpec(flag: "-x" | "-m"): string[] {
    const call = calls.find(c => isCmd(c, "setfacl"));
    const i = call?.args.indexOf(flag) ?? -1;
    return i >= 0 ? call!.args[i + 1].split(",") : [];
}

describe("listShares", () => {
    it("returns only shares under the managed directory, with access levels", async () => {
        setSpawnHandler(handler());
        const shares = await listShares();
        assert.equal(shares.length, 1);
        assert.deepEqual(shares[0], {
            name: "docs",
            path: "/srv/samba/shares/docs",
            comment: "Documents",
            browseable: false, automount: null,
            access: [
                { name: "Teachers", kind: "group", level: "write" },
                { name: "Students", kind: "group", level: "read" },
                { name: "mrossi", kind: "user", level: "write" },
            ],
        });
    });
});

describe("createShare", () => {
    it("creates the directory, POSIX ACL and registry share", async () => {
        setSpawnHandler(handler());
        await createShare("Progetti", {
            comment: "",
            browseable: true, automount: null,
            access: [
                { name: "Teachers", kind: "group", level: "write" },
                { name: "mrossi", kind: "user", level: "read" },
            ],
        });
        const path = "/srv/samba/shares/Progetti";
        assert.ok(calls.some(c => c.args.join(" ") === `chmod 2770 ${path}`));
        const add = setfaclSpec("-m");
        for (const e of ["g::---", "d:o::---", "g:SCHOOL\\Teachers:rwX", "d:g:SCHOOL\\Teachers:rwX", "u:SCHOOL\\mrossi:r-X"]) {
            assert.ok(add.includes(e), `missing ACL entry ${e}`);
        }
        const addshare = calls.find(c => isCmd(c, "net", "conf", "addshare"));
        assert.deepEqual(addshare?.args, ["net", "conf", "addshare", "Progetti", path, "writeable=y", "guest_ok=n"]);
        assert.equal(setparm("valid users"), '@"SCHOOL\\Teachers" "SCHOOL\\mrossi"');
        assert.equal(setparm("read list"), '"SCHOOL\\mrossi"');
        assert.equal(setparm("inherit acls"), "yes");
        assert.ok(calls.some(c => isCmd(c, "net", "conf", "delparm") && c.args[4] === "comment"));
    });

    it("rejects existing (case-insensitive), reserved and option-like names before touching the disk", async () => {
        setSpawnHandler(handler());
        const data = { comment: "", browseable: true, automount: null, access: [{ name: "Teachers", kind: "group" as const, level: "write" as const }] };
        await assert.rejects(createShare("DOCS", data), /already exists/);
        await assert.rejects(createShare("sysvol", data), /Invalid share name/);
        await assert.rejects(createShare("-x", data), /Invalid share name/);
        await assert.rejects(createShare("../etc", data), /Invalid share name/);
        assert.ok(!calls.some(c => isCmd(c, "mkdir") || isCmd(c, "setfacl")));
    });

    it("refuses a share without any user or group", async () => {
        setSpawnHandler(handler());
        await assert.rejects(createShare("empty", { comment: "", browseable: true, automount: null, access: [] }), /at least one/);
        assert.equal(calls.length, 0);
    });

    it("reports unknown principals before changing permissions", async () => {
        setSpawnHandler(handler(["ghost"]));
        await assert.rejects(
            createShare("x", { comment: "", browseable: true, automount: null, access: [{ name: "ghost", kind: "user", level: "read" }] }),
            /Unknown user or group: ghost/,
        );
        assert.ok(!calls.some(c => isCmd(c, "setfacl") || isCmd(c, "net", "conf", "addshare")));
    });
});

describe("updateShare", () => {
    it("clears both u: and g: entries of old and new principals, then re-adds the current ones", async () => {
        setSpawnHandler(handler());
        await updateShare("docs", {
            comment: "Documents",
            browseable: false, automount: null,
            access: [{ name: "Teachers", kind: "group", level: "read" }],
        });
        const remove = setfaclSpec("-x");
        for (const n of ["teachers", "students", "mrossi"]) {
            for (const tag of ["u", "g", "d:u", "d:g"]) {
                assert.ok(remove.includes(`${tag}:SCHOOL\\${n}`), `missing removal ${tag}:${n}`);
            }
        }
        assert.ok(setfaclSpec("-m").includes("g:SCHOOL\\Teachers:r-X"));
        const setfacl = calls.find(c => isCmd(c, "setfacl"));
        assert.equal(setfacl?.args[setfacl.args.length - 1], "/srv/samba/shares/docs");
        assert.equal(setparm("valid users"), '@"SCHOOL\\Teachers"');
        assert.equal(setparm("read list"), '@"SCHOOL\\Teachers"');
    });

    it("skips removing principals that no longer exist in the domain", async () => {
        setSpawnHandler(handler(["mrossi"]));
        await updateShare("docs", {
            comment: "",
            browseable: true, automount: null,
            access: [{ name: "Teachers", kind: "group", level: "write" }],
        });
        assert.ok(!setfaclSpec("-x").some(e => e.includes("mrossi")));
        assert.ok(calls.some(c => isCmd(c, "net", "conf", "delparm") && c.args[4] === "read list"));
    });

    it("does not manage shares outside the shares directory", async () => {
        setSpawnHandler(handler());
        const data = { comment: "", browseable: true, automount: null, access: [{ name: "Teachers", kind: "group" as const, level: "write" as const }] };
        await assert.rejects(updateShare("manual", data), /not found/);
        await assert.rejects(updateShare("home", data), /not found/);
        assert.ok(!calls.some(c => isCmd(c, "setfacl")));
    });
});

describe("deleteShare", () => {
    it("keeps the data unless asked to delete it", async () => {
        setSpawnHandler(handler());
        await deleteShare("docs", false);
        assert.ok(calls.some(c => c.args.join(" ") === "net conf delshare docs"));
        assert.ok(!calls.some(c => isCmd(c, "rm")));

        setSpawnHandler(handler());
        await deleteShare("docs", true);
        const rm = calls.find(c => isCmd(c, "rm"));
        assert.deepEqual(rm?.args, ["rm", "-rf", "--one-file-system", "--", "/srv/samba/shares/docs"]);
    });

    it("never removes paths of unmanaged shares", async () => {
        setSpawnHandler(handler());
        await assert.rejects(deleteShare("manual", true), /not found/);
        assert.ok(!calls.some(c => isCmd(c, "rm") || isCmd(c, "net", "conf", "delshare")));
    });
});

describe("effectiveShareAccess", () => {
    const share = {
        name: "docs", path: "/srv/samba/shares/docs", comment: "", browseable: true, automount: null,
        access: [
            { name: "Teachers", kind: "group" as const, level: "write" as const },
            { name: "Students", kind: "group" as const, level: "read" as const },
            { name: "mrossi", kind: "user" as const, level: "write" as const },
        ],
    };

    it("grants access through the user or its groups, case-insensitively", () => {
        assert.deepEqual(effectiveShareAccess(share, "MRossi", []), { level: "write", via: [share.access[2]] });
        assert.deepEqual(effectiveShareAccess(share, "carol", ["teachers", "Domain Users"]), { level: "write", via: [share.access[0]] });
        assert.equal(effectiveShareAccess(share, "bob", ["Domain Users"]), null);
    });

    it("is read-only when any matching entry is read-only (smbd read list)", () => {
        const r = effectiveShareAccess(share, "mrossi", ["Students"]);
        assert.equal(r?.level, "read");
        assert.equal(r?.via.length, 2);
    });
});

describe("renameSharePrincipal", () => {
    it("rewrites the renamed group in valid users and read list only", async () => {
        setSpawnHandler(handler());
        await renameSharePrincipal("group", "students", "Alunni");
        assert.equal(setparm("valid users"), '@"SCHOOL\\Teachers" @"SCHOOL\\Alunni" "SCHOOL\\mrossi"');
        assert.equal(setparm("read list"), '@"SCHOOL\\Alunni"');
        assert.ok(calls.every(c => !isCmd(c, "net", "conf", "setparm") || c.args[3] === "docs"));
        assert.ok(!calls.some(c => isCmd(c, "setfacl")));
    });

    it("matches the kind: a group rename leaves a same-named user alone", async () => {
        setSpawnHandler(handler());
        await renameSharePrincipal("group", "mrossi", "x");
        assert.ok(!calls.some(c => isCmd(c, "net", "conf", "setparm")));

        setSpawnHandler(handler());
        await renameSharePrincipal("user", "MRossi", "mario.rossi");
        assert.equal(setparm("valid users"), '@"SCHOOL\\Teachers" @"SCHOOL\\Students" "SCHOOL\\mario.rossi"');
    });
});

describe("isManagedPath", () => {
    it("accepts only direct children of the shares directory", () => {
        assert.ok(isManagedPath("/srv/samba/shares/docs"));
        for (const p of ["/srv/samba/shares", "/srv/samba/shares/", "/srv/samba/shares/.", "/srv/samba/shares/..",
            "/srv/samba/shares/../home", "/srv/samba/shares/a/b", "/srv/samba/shares/docs/", "/srv/samba/sharesX/a"]) {
            assert.ok(!isManagedPath(p), p);
        }
    });
});

describe("expandNestedGroups", () => {
    const groups = [
        { name: "Staff", members: ["Teachers", "secretary"] },
        { name: "Teachers", members: ["mrossi"] },
        { name: "All", members: ["staff", "Students"] },
        // A cycle, which AD allows
        { name: "LoopA", members: ["LoopB"] },
        { name: "LoopB", members: ["LoopA"] },
    ];

    it("adds the groups that contain the user's groups, at any depth", () => {
        assert.deepEqual(expandNestedGroups(["Teachers", "Domain Users"], groups).sort(),
            ["All", "Domain Users", "Staff", "Teachers"]);
    });

    it("stops on cycles", () => {
        assert.deepEqual(expandNestedGroups(["LoopA"], groups).sort(), ["LoopA", "LoopB"]);
    });

    it("gives the access a nested group grants", () => {
        const share = { name: "docs", path: "/srv/samba/shares/docs", comment: "", browseable: true, automount: null,
            access: [{ name: "Staff", kind: "group" as const, level: "write" as const }] };
        assert.equal(effectiveShareAccess(share, "mrossi", ["Teachers"]), null);
        assert.deepEqual(effectiveShareAccess(share, "mrossi", expandNestedGroups(["Teachers"], groups))?.via, share.access);
    });
});
