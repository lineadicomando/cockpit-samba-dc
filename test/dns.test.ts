// Runs dns.ts against the spawn() test double: what the "DNS" tab sends to
// addcctl, how it reads the answers, and the cache.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import { listDnsZones, listDnsRecords, setDnsRecords, deleteDnsRecords } from "../src/lib/dns.ts";
import { deleteComputer } from "../src/lib/samba.ts";

const RECORDS = [
    { name: "@", type: "NS", value: "dc.samba.test", ttl: 900, dynamic: false, protected: true },
    { name: "pc01", type: "A", value: "192.168.142.21", ttl: 1200, dynamic: true, protected: false },
    { name: "www", type: "A", value: "192.168.142.80", ttl: 900, dynamic: false, protected: false },
];
// Verbatim shape of addcctl's answers
const ANSWERS: Record<string, unknown> = {
    "dns zones": { zones: [{ name: "_msdcs.samba.test", partition: "forest", read_only: true },
        { name: "samba.test", partition: "domain", read_only: false }] },
    "dns list": { records: RECORDS },
};

const op = (call: SpawnCall) => call.args.slice(1).join(" ");
const sent = (operation: string) => calls.filter(c => c.args[0] === "addcctl" && op(c) === operation)
    .map(c => JSON.parse(c.input!));

function core() {
    setSpawnHandler(call => {
        if (call.args[0] !== "addcctl") throw new Error(`unexpected ${call.args.join(" ")}`);
        return JSON.stringify(ANSWERS[op(call)] ?? { changed: true, records: [], diff: {}, commands: [], check: false });
    });
}

describe("DNS zones and records", () => {
    it("translates the zones and caches them", async () => {
        core();
        calls.length = 0;
        assert.deepEqual(await listDnsZones(), [
            { name: "_msdcs.samba.test", partition: "forest", readOnly: true },
            { name: "samba.test", partition: "domain", readOnly: false }]);
        await listDnsZones();
        assert.equal(sent("dns zones").length, 1);
    });

    it("reads a zone's records once, until a change", async () => {
        core();
        calls.length = 0;
        assert.deepEqual(await listDnsRecords("samba.test"), RECORDS);
        await listDnsRecords("Samba.Test");
        assert.deepEqual(sent("dns list"), [{ zone: "samba.test" }]);
        await setDnsRecords("samba.test", "www", "A", ["192.168.142.81"], 300);
        await listDnsRecords("samba.test");
        assert.equal(sent("dns list").length, 2);
    });

    it("sends set and delete as addcctl takes them", async () => {
        core();
        calls.length = 0;
        await setDnsRecords("samba.test", "www", "A", ["192.168.142.81"]);
        await deleteDnsRecords("samba.test", "www", "TXT");
        await deleteDnsRecords("samba.test", "www", "A", ["192.168.142.81"]);
        assert.deepEqual(sent("dns set"), [{ zone: "samba.test", name: "www", type: "A", values: ["192.168.142.81"] }]);
        assert.deepEqual(sent("dns delete"), [{ zone: "samba.test", name: "www", type: "TXT" },
            { zone: "samba.test", name: "www", type: "A", values: ["192.168.142.81"] }]);
    });

    it("drops the records when a computer is deleted with its own", async () => {
        core();
        await listDnsRecords("samba.test");
        calls.length = 0;
        await deleteComputer("PC01");
        await listDnsRecords("samba.test");
        assert.equal(sent("dns list").length, 1);
    });
});
