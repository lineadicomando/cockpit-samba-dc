// Runs domain.ts against the spawn() test double: what the "Domain" tab sends
// to addcctl, how it reads the answers, and the cache.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import cockpit, { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import {
    getDomainInfo, runHealthChecks, resetSysvolAcls, listBackups, createBackup, getSetupStatus, previewProvision,
    provisionDomain,
} from "../src/lib/domain.ts";
import { networkingPageAvailable, setupCheckText } from "../src/lib/setupText.ts";
import type { SetupCheck } from "../src/lib/types.ts";

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

const SETUP = { provisioned: false, ready: true,
    checks: [{ name: "address", state: "ok", message: "Static address 192.168.1.20/24 on enp1s0" },
        { name: "time", state: "warning", message: "The clock is not synchronized", fix: "Install chrony" }],
    host: { name: "dc", address: "192.168.1.20", prefix_length: 24, interface: "enp1s0" },
    defaults: { realm: "EXAMPLE.LAN", netbios_domain: "EXAMPLE", dns_forwarder: "192.168.1.1" } };
const PROVISIONED = { changed: true, check: false, commands: ["systemctl stop smbd nmbd winbind"],
    domain: { realm: "SCHOOL.EXAMPLE.ORG", dns_domain: "school.example.org", netbios_domain: "SCHOOL",
        server: "dc.school.example.org", address: "192.168.1.20", dns_forwarder: "192.168.1.1" },
    smb_conf_dist: "/etc/samba/smb.conf.dist" };
const NEW_DOMAIN = { realm: "school.example.org", netbiosDomain: "SCHOOL", adminPassword: "Secret-Pass1",
    dnsForwarder: "192.168.1.1" };

describe("a new domain", () => {
    it("reads the setup check", async () => {
        setSpawnHandler(() => JSON.stringify(SETUP));
        const status = await getSetupStatus();
        assert.equal(status.ready, true);
        assert.deepEqual(status.host, { name: "dc", address: "192.168.1.20", prefixLength: 24, interface: "enp1s0" });
        assert.deepEqual(status.defaults, { realm: "EXAMPLE.LAN", netbiosDomain: "EXAMPLE",
            dnsForwarder: "192.168.1.1" });
        assert.equal(status.checks[1].fix, "Install chrony");
        setSpawnHandler(() => JSON.stringify({ provisioned: true, ready: false, checks: [], host: null,
            defaults: null }));
        const done = await getSetupStatus();
        assert.equal(done.provisioned, true);
        assert.equal(done.host, null);
    });

    it("previews with --check, the password on stdin only", async () => {
        calls.length = 0;
        setSpawnHandler(() => JSON.stringify(dict(PROVISIONED, { check: true })));
        assert.deepEqual(await previewProvision(NEW_DOMAIN), ["systemctl stop smbd nmbd winbind"]);
        assert.deepEqual(calls[0].args, ["addcctl", "domain", "provision", "--check"]);
        assert.deepEqual(JSON.parse(calls[0].input!), { realm: "school.example.org", netbios_domain: "SCHOOL",
            admin_password: "Secret-Pass1", dns_forwarder: "192.168.1.1" });
        assert.ok(!calls[0].args.some(a => a.includes("Secret")));
    });

    it("provisions and drops every cached answer, also on failure", async () => {
        core();
        await getDomainInfo();
        calls.length = 0;
        setSpawnHandler(call => JSON.stringify(op(call) === "domain provision" ? PROVISIONED : ANSWERS[op(call)]));
        const done = await provisionDomain(NEW_DOMAIN);
        assert.equal(done.server, "dc.school.example.org");
        assert.deepEqual(calls[0].args, ["addcctl", "domain", "provision"]);
        await getDomainInfo();
        assert.equal(sent("domain info").length, 1);
        setSpawnHandler(call => {
            if (op(call) === "domain provision") throw new Error("This host is a domain controller already");
            return JSON.stringify(ANSWERS[op(call)]);
        });
        // setSpawnHandler clears the calls
        await assert.rejects(provisionDomain(NEW_DOMAIN), /domain controller already/);
        await getDomainInfo();
        assert.equal(sent("domain info").length, 1);
    });
});

// A t() that marks what it translated and fills the {{params}}
function t(key: string, options?: Record<string, unknown>): string {
    return "T:" + key.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(options?.[k]));
}

describe("the text of a prerequisite", () => {
    it("is written from the code and its params", () => {
        const dhcp: SetupCheck = { name: "address", state: "error", code: "address.dhcp",
            params: { address: "192.168.1.20", prefix_length: 24, interface: "enp1s0" },
            message: "192.168.1.20/24 on enp1s0 comes from DHCP", fix: "Set a static address" };
        assert.deepEqual(setupCheckText(t, dhcp, true), {
            message: "T:192.168.1.20/24 on enp1s0 comes from DHCP: a domain controller needs a static address.",
            fix: "T:Set a static address in the Networking page, then check again." });
        assert.equal(setupCheckText(t, dhcp, false).fix,
            "T:Set a static address in /etc/network/interfaces, then check again.");
        const ports: SetupCheck = { name: "ports", state: "error", code: "ports.busy",
            params: { busy: [{ program: "dnsmasq", ports: [{ port: 53, service: "DNS" }, { port: 88, service: "Kerberos" }] }] },
            message: "in use" };
        assert.equal(setupCheckText(t, ports, true).message,
            "T:Ports a domain controller needs are in use: T:dnsmasq on 53 (DNS), 88 (Kerberos).");
        const stopped: SetupCheck = { name: "ports", state: "ok", code: "ports.stopped",
            params: { stopped: ["nmbd", "smbd"] }, message: "free" };
        assert.match(setupCheckText(t, stopped, true).message, /once nmbd, smbd are stopped/);
    });

    it("falls back to the core's English text for an unknown code", () => {
        const check: SetupCheck = { name: "disk", state: "warning", code: "disk.quota", params: {},
            message: "Quota almost reached", fix: "Raise it" };
        assert.deepEqual(setupCheckText(t, check, true), { message: "Quota almost reached", fix: "Raise it" });
        assert.deepEqual(setupCheckText(t, { name: "disk", state: "ok", message: "Fine" }, true),
            { message: "Fine", fix: undefined });
    });

    it("offers the Networking page only when the shell lists it", () => {
        assert.equal(networkingPageAvailable(), false);
        cockpit.manifests.network = { name: "network" };
        try {
            assert.equal(networkingPageAvailable(), true);
        } finally {
            delete cockpit.manifests.network;
        }
    });
});

function dict<T extends object>(base: T, extra: Partial<T>): T {
    return { ...base, ...extra };
}
