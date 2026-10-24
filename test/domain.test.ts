// Runs domain.ts against the spawn() test double: what the "Domain" tab sends
// to addcctl, how it reads the answers, and the cache.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import { getDomainInfo, runHealthChecks, resetSysvolAcls, listBackups, createBackup } from "../src/lib/domain.ts";

const BACKUP = { name: "samba-backup-samba.test-2026-10-24T10-00-00.000000.tar.bz2",
    path: "/var/backups/samba-dc/samba-backup-samba.test-2026-10-24T10-00-00.000000.tar.bz2",
    size: 1048576, created: "2026-10-24T08:00:00+00:00" };
// Verbatim shape of addcctl's answers
const ANSWERS: Record<string, unknown> = {
    "domain info": { domain: { realm: "SAMBA.TEST", dns_domain: "samba.test", netbios_domain: "SAMBATEST",
        domain_dn: "DC=samba,DC=test", server: "DC", samba_version: "4.22.11-Debian", domain_level: "2008 R2",
        forest_level: "2008 R2", domain_controllers: [{ name: "DC", dns_name: "dc.samba.test",
            site: "Default-First-Site-Name" }],
        fsmo: [{ role: "schema", owner: "DC" }, { role: "pdc", owner: "DC" }], processes: null } },
    "domain check": { checks: [
        { name: "dbcheck", command: "samba-tool dbcheck --cross-ncs", ok: true, exit_code: 0, output: "0 errors\n" },
        { name: "sysvolcheck", command: "samba-tool ntacl sysvolcheck", ok: false, exit_code: 255,
            output: "ProvisioningError\n" },
    ] },
    "backup list": { backups: [BACKUP] },
    "backup create": { changed: true, backup: BACKUP, commands: [], check: false },
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

describe("domain overview", () => {
    it("translates addcctl's answer and caches it", async () => {
        core();
        calls.length = 0;
        const info = await getDomainInfo();
        assert.equal(info.realm, "SAMBA.TEST");
        assert.equal(info.netbiosDomain, "SAMBATEST");
        assert.equal(info.sambaVersion, "4.22.11-Debian");
        assert.equal(info.domainLevel, "2008 R2");
        assert.deepEqual(info.domainControllers, [{ name: "DC", dnsName: "dc.samba.test",
            site: "Default-First-Site-Name" }]);
        assert.deepEqual(info.fsmo[1], { role: "pdc", owner: "DC" });
        assert.equal(info.processes, null);
        await getDomainInfo();
        assert.equal(sent("domain info").length, 1);
    });
});

describe("health checks", () => {
    it("runs all of them, or the ones asked for, every time", async () => {
        core();
        calls.length = 0;
        const checks = await runHealthChecks();
        assert.deepEqual(checks.map(c => [c.name, c.ok, c.exitCode]), [["dbcheck", true, 0], ["sysvolcheck", false, 255]]);
        await runHealthChecks(["sysvolcheck"]);
        assert.deepEqual(sent("domain check"), [{}, { checks: ["sysvolcheck"] }]);
    });

    it("resets the sysvol ACLs", async () => {
        core();
        calls.length = 0;
        await resetSysvolAcls();
        assert.deepEqual(sent("domain sysvol-reset"), [{}]);
    });
});

describe("backups", () => {
    it("lists them from the cache until one is made", async () => {
        core();
        calls.length = 0;
        const [b] = await listBackups();
        assert.equal(b.name, BACKUP.name);
        assert.equal(b.created, Date.parse("2026-10-24T08:00:00Z"));
        await listBackups();
        assert.equal(sent("backup list").length, 1);
        const made = await createBackup();
        assert.equal(made?.size, 1048576);
        await listBackups();
        assert.equal(sent("backup list").length, 2);
    });

    it("drops the list when a backup fails too", async () => {
        await listBackups();
        calls.length = 0;
        setSpawnHandler(call => {
            if (op(call) === "backup create") throw new Error("samba-tool domain failed: no space left");
            return JSON.stringify(ANSWERS[op(call)]);
        });
        await assert.rejects(createBackup(), /no space left/);
        await listBackups();
        assert.equal(sent("backup list").length, 1);
    });
});
