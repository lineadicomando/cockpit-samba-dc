// Runs shares.ts against the spawn() test double (see cockpit-loader.mjs):
// the model lives in addcctl (core/), tested there; here, what the page
// sends to it and how it caches.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import { listShares, createShare, updateShare, deleteShare, effectiveShareAccess, expandNestedGroups, renameSharePrincipal } from "../src/lib/shares.ts";

// Verbatim shape of "addcctl share list"
const LIST = JSON.stringify({ shares: [{
    name: "docs", path: "/srv/samba/shares/docs", comment: "Documents", browseable: true,
    access: [{ name: "Teachers", kind: "group", level: "write" }, { name: "mrossi", kind: "user", level: "read" }],
    drive: { letter: "P", label: "Docs" },
}, {
    name: "lab", path: "/srv/samba/shares/lab", comment: "", browseable: false,
    access: [{ name: "Students", kind: "group", level: "read" }], drive: null,
}] });

const isCore = (call: SpawnCall, action: string) => call.args.join(" ") === `addcctl share ${action}`;
const input = (action: string) => JSON.parse(calls.find(c => isCore(c, action))!.input!);

function core(answers: Record<string, string> = {}) {
    setSpawnHandler(call => {
        const action = call.args[2];
        if (call.args[0] !== "addcctl") throw new Error(`unexpected ${call.args.join(" ")}`);
        if (action in answers) return answers[action];
        if (action === "list") return LIST;
        return JSON.stringify({ changed: true, commands: [], check: false });
    });
}

describe("listShares", () => {
    it("reads addcctl share list, with the drive as automount", async () => {
        core();
        await deleteShare("none", false); // drops the cache of an earlier test
        const shares = await listShares();
        assert.deepEqual(shares.map(s => [s.name, s.automount]), [["docs", { letter: "P", label: "Docs" }], ["lab", null]]);
        assert.equal(shares[0].access[1].level, "read");
        assert.deepEqual(calls.find(c => isCore(c, "list"))?.input, "{}");
    });

    it("caches the list until a mutation", async () => {
        core();
        await deleteShare("none", false);
        await listShares();
        await listShares();
        assert.equal(calls.filter(c => isCore(c, "list")).length, 1);
        await updateShare("docs", { comment: "", browseable: true, automount: null,
            access: [{ name: "Teachers", kind: "group", level: "write" }] });
        await listShares();
        assert.equal(calls.filter(c => isCore(c, "list")).length, 2);
    });
});

describe("createShare", () => {
    it("sends the share to addcctl share set, on stdin", async () => {
        core();
        await createShare("Projects", { comment: "P", browseable: true, automount: { letter: "Q", label: "" },
            access: [{ name: "Staff", kind: "group", level: "write" }] });
        assert.deepEqual(input("set"), { name: "Projects", comment: "P", browseable: true,
            drive: { letter: "Q", label: "" }, access: [{ name: "Staff", kind: "group", level: "write" }] });
    });

    it("refuses a share that exists, an invalid name, an empty access list", async () => {
        core();
        const data = { comment: "", browseable: true, automount: null, access: [{ name: "Staff", kind: "group" as const, level: "read" as const }] };
        await assert.rejects(createShare("DOCS", data), /already exists/);
        await assert.rejects(createShare("home", data), /Invalid share name/);
        await assert.rejects(createShare("x", { ...data, access: [] }), /at least one user or group/);
        await assert.rejects(createShare("x", { ...data, access: [{ name: "-x", kind: "user", level: "read" }] }), /Invalid account name/);
        assert.ok(!calls.some(c => isCore(c, "set")));
    });

    it("passes the core's error on as it is", async () => {
        setSpawnHandler(call => {
            if (call.args[2] === "list") return JSON.stringify({ shares: [] });
            throw new Error("Unknown user or group: ghost");
        });
        await assert.rejects(createShare("new", { comment: "", browseable: true, automount: null,
            access: [{ name: "ghost", kind: "user", level: "read" }] }), /^Error: Unknown user or group: ghost$/);
    });
});

describe("updateShare and deleteShare", () => {
    it("removes the mapping with drive null, deletes with the data flag", async () => {
        core();
        await updateShare("docs", { comment: "", browseable: false, automount: null,
            access: [{ name: "Teachers", kind: "group", level: "write" }] });
        assert.equal(input("set").drive, null);
        assert.equal(input("set").browseable, false);
        await deleteShare("docs", true);
        assert.deepEqual(input("delete"), { name: "docs", delete_data: true });
    });
});

describe("renameSharePrincipal", () => {
    it("asks addcctl to follow the rename, and skips a no-op", async () => {
        core();
        await renameSharePrincipal("user", "mrossi", "mrossi");
        assert.equal(calls.length, 0);
        await renameSharePrincipal("user", "mrossi", "mario.rossi");
        assert.deepEqual(input("rename-principal"), { kind: "user", old: "mrossi", new: "mario.rossi" });
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
