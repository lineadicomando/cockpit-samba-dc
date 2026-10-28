// Runs gpos.ts against the spawn() test double: what the "Group Policy" tab
// sends to addcctl, how it reads the answers, and the cache.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import { listGpos, linkGpo, unlinkGpo } from "../src/lib/gpos.ts";
import { listDnsZones } from "../src/lib/dns.ts";
import { deleteOu } from "../src/lib/samba.ts";
import { updateShare } from "../src/lib/shares.ts";

const GUID = "{11111111-2222-3333-4444-555555555555}";
const CORE_GPO = {
    guid: GUID, name: "Lab settings", path: "\\\\samba.test\\sysvol\\samba.test\\Policies\\" + GUID,
    version: { user: 2, computer: 3 }, user_enabled: false, computer_enabled: true, builtin: false,
    drive_mapping: false,
    links: [{ container: "OU=School", enforced: true, disabled: false, order: 1, protected: false }],
};
// Verbatim shape of addcctl's answers
const ANSWERS: Record<string, unknown> = {
    "gpo list": { gpos: [CORE_GPO] },
    "gpo link": { changed: true, gpo: CORE_GPO, diff: {}, commands: [], check: false },
    "gpo unlink": { changed: true, gpo: { ...CORE_GPO, links: [] }, diff: {}, commands: [], check: false },
    "dns zones": { zones: [] },
};

const op = (call: SpawnCall) => call.args.slice(1).join(" ");
const sent = (operation: string) => calls.filter(c => c.args[0] === "addcctl" && op(c) === operation)
    .map(c => JSON.parse(c.input!));

function core() {
    setSpawnHandler(call => {
        if (call.args[0] !== "addcctl") throw new Error(`unexpected ${call.args.join(" ")}`);
        return JSON.stringify(ANSWERS[op(call)] ?? { changed: true, commands: [], check: false });
    });
}

describe("Group Policy objects", () => {
    it("translates the GPOs and caches them", async () => {
        core();
        calls.length = 0;
        assert.deepEqual(await listGpos(), [{
            guid: GUID, name: "Lab settings", path: CORE_GPO.path, version: { user: 2, computer: 3 },
            userEnabled: false, computerEnabled: true, builtIn: false, driveMapping: false, links: CORE_GPO.links,
        }]);
        await listGpos();
        assert.equal(sent("gpo list").length, 1);
    });

    it("sends link and unlink as addcctl takes them, and reads the list again", async () => {
        core();
        await listGpos();
        calls.length = 0;
        const linked = await linkGpo(GUID, "");
        assert.equal(linked.links.length, 1);
        await linkGpo(GUID, "OU=School", { disabled: true });
        const unlinked = await unlinkGpo(GUID, "OU=School");
        assert.deepEqual(unlinked.links, []);
        assert.deepEqual(sent("gpo link"), [{ gpo: GUID, container: "" },
            { gpo: GUID, container: "OU=School", disabled: true }]);
        assert.deepEqual(sent("gpo unlink"), [{ gpo: GUID, container: "OU=School" }]);
        await listGpos();
        assert.equal(sent("gpo list").length, 1);
    });

    it("a change here drops only the GPOs", async () => {
        core();
        await listDnsZones();
        calls.length = 0;
        await linkGpo(GUID, "");
        await listDnsZones();
        assert.equal(sent("dns zones").length, 0);
    });

    it("drops the GPOs when an OU or a share changes", async () => {
        core();
        await listGpos();
        calls.length = 0;
        await deleteOu("OU=School", false);
        await listGpos();
        assert.equal(sent("gpo list").length, 1);
        await updateShare("data", { comment: "", browseable: true, access: [{ name: "Teachers", kind: "group", level: "write" }],
            automount: { letter: "S", label: "Data" } });
        await listGpos();
        assert.equal(sent("gpo list").length, 2);
    });
});
