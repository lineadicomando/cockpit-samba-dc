// Integration suite, run before each release on the test DC: one scenario
// (group, user, home directory, shared folder with a mapped drive, renames,
// removal) through each interface of the project, with the same checks of
// what the DC ends up with (addcctl, sam.ldb, smbd, sysvol, the folders).
//
//   test/vm/lab.sh reset && test/vm/lab.sh start dc && test/vm/lab.sh wait dc
//   test/vm/lab.sh deploy
//   test/vm/run-lib.sh test/vm/integration.ts [core] [page] [ansible] [mcp]
//
// core: what addcctl does whatever calls it; page: the functions of src/lib/ the Cockpit page calls; ansible: the
// collection's modules (lab.sh ansible); mcp: the tools of addcctl mcp. Its
// data is named t-<x|p|a|m>-…, and removed at the end even when a check fails.
import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cockpit from "cockpit";
import type { DnsRecordType } from "../../src/lib/types.ts";
import {
    addGroupMembers, createGroup, createUser, deleteGroup, deleteUser, getPasswordPolicy, modifyUser, provisionHomeDir,
    renameGroup, setPasswordPolicy, createPso, listPsos, updatePso, deletePso, createOu, listOus, updateOu, deleteOu,
    moveUser, updateGroup, createComputer, setComputerDescription,
} from "../../src/lib/samba.ts";
import { createShare, deleteShare } from "../../src/lib/shares.ts";
import { addcctl } from "../../src/lib/addcctl.ts";
import { createBackup, getDomainInfo, listBackups, runHealthChecks } from "../../src/lib/domain.ts";
import { deleteDnsRecords, listDnsRecords, setDnsRecords } from "../../src/lib/dns.ts";

const env = process.env;
const password = env.DOMAIN_TEST_PASSWORD!;
const netbios = env.DOMAIN_NETBIOS!;
const root = new URL("../../", import.meta.url).pathname;

// As root on the DC (cockpit-ssh.ts)
const run = (args: string[], input?: string): Promise<string> =>
    input === undefined ? cockpit.spawn(args) : cockpit.spawn(args).input(input);

async function core(operation: string, input: object = {}): Promise<Record<string, unknown>> {
    return JSON.parse(await run(["addcctl", ...operation.split(" ")], JSON.stringify(input)));
}

interface Access { name: string; kind: "user" | "group"; level: "read" | "write" }

// The password policy as addcctl reads and takes it: null for never
interface Policy {
    complexity: boolean;
    min_length: number;
    history_length: number;
    min_age_days: number;
    max_age_days: number | null;
    lockout_threshold: number;
    lockout_duration_minutes: number | null;
    lockout_window_minutes: number | null;
}

interface Driver {
    name: string;
    createGroup(name: string): Promise<void>;
    createUser(name: string, groups: string[]): Promise<void>;
    provisionHome(name: string): Promise<void>;
    // Preview of a new share, where the interface has one: changes nothing
    previewShare?(name: string, access: Access[], letter: string): Promise<void>;
    createShare(name: string, access: Access[], letter: string): Promise<void>;
    renameUser(name: string, newName: string): Promise<void>;
    renameGroup(name: string, newName: string): Promise<void>;
    deleteShare(name: string): Promise<void>;
    deleteHome(name: string): Promise<void>;
    deleteUser(name: string): Promise<void>;
    deleteGroup(name: string): Promise<void>;
    // The "Domain" tab: the overview, and a backup or its preview
    domain(): Promise<void>;
    // Change the password policy; with check, only a preview, where the interface has one
    setPolicy(changes: Partial<Policy>, check?: boolean): Promise<void>;
    // A PSO with a minimum length, on these users and groups; add one more; delete it
    createPso(name: string, minLength: number, appliesTo: string[]): Promise<void>;
    appendToPso(name: string, account: string): Promise<void>;
    deletePso(name: string): Promise<void>;
    // An OU in parent ("" the domain); rename it; delete it with what is in it
    createOu(name: string, parent: string): Promise<void>;
    renameOu(name: string, parent: string, newName: string): Promise<void>;
    deleteOu(name: string, parent: string): Promise<void>;
    // Move a user into a container (relative DN)
    moveUser(name: string, ou: string): Promise<void>;
    // The create and edit forms: a user with its details, a group with its
    // scope, type and e-mail, a computer account made before it joins
    createUserWith(name: string, details: UserDetails): Promise<void>;
    createGroupWith(name: string, details: GroupDetails): Promise<void>;
    setGroupEmail(name: string, email: string): Promise<void>;
    createComputer(name: string, ou: string, description: string): Promise<void>;
    setComputerDescription(name: string, description: string): Promise<void>;
    // The records of one type at one name become these values; delete some, or all of that type
    setDns(zone: string, name: string, type: string, values: string[], ttl?: number): Promise<void>;
    deleteDns(zone: string, name: string, type: string, values?: string[]): Promise<void>;
    close?(): void;
}

// As addcctl takes them
interface UserDetails {
    email: string; description: string; title: string; department: string; company: string;
    must_change_password: boolean;
}
interface GroupDetails {
    description: string; email: string; scope: "domain" | "global" | "universal"; category: "security" | "distribution";
}

const ouDn = (name: string, parent: string) => (parent ? `OU=${name},${parent}` : `OU=${name}`);

const realm = () => env.DOMAIN_REALM!.toUpperCase();

// --- the page

const page: Driver = {
    name: "page",
    createGroup: name => createGroup(name),
    async createUser(name, groups) {
        await createUser(name, password);
        for (const g of groups) await addGroupMembers(g, [name]);
    },
    provisionHome: name => provisionHomeDir(name),
    createShare: (name, access, letter) =>
        createShare(name, { comment: "", browseable: true, access, automount: { letter, label: name } }),
    renameUser: (name, newName) => modifyUser(name, { newUsername: newName }),
    renameGroup: (name, newName) => renameGroup(name, newName),
    deleteShare: name => deleteShare(name, true),
    // The page has no action for it: the operation it would call
    deleteHome: async name => { await addcctl("home delete", { name, delete_data: true }); },
    deleteUser: name => deleteUser(name),
    deleteGroup: name => deleteGroup(name),
    async domain() {
        const info = await getDomainInfo();
        assert.equal(info.realm, realm());
        assert.ok(info.domainControllers.length > 0);
        const [testparm] = await runHealthChecks(["testparm"]);
        assert.ok(testparm.ok, testparm.output);
        const backup = await createBackup();
        assert.ok(backup, "the new archive is reported");
        try {
            assert.ok((await listBackups()).some(b => b.name === backup.name));
            assert.equal((await run(["stat", "-c", "%a %U", backup.path])).trim(), "600 root");
            assert.equal((await run(["stat", "-c", "%a", "/var/backups/samba-dc"])).trim(), "700");
        } finally {
            await run(["rm", "-f", "--", backup.path]);
        }
    },
    async setPolicy(changes, check) {
        if (check) return;
        const current = await getPasswordPolicy();
        await setPasswordPolicy(current, {
            complexityRequired: changes.complexity ?? current.complexityRequired,
            minLength: changes.min_length ?? current.minLength,
            historyLength: changes.history_length ?? current.historyLength,
            minAgeDays: changes.min_age_days ?? current.minAgeDays,
            maxAgeDays: "max_age_days" in changes ? changes.max_age_days! : current.maxAgeDays,
            lockoutThreshold: changes.lockout_threshold ?? current.lockoutThreshold,
            lockoutDurationMinutes: "lockout_duration_minutes" in changes
                ? changes.lockout_duration_minutes! : current.lockoutDurationMinutes,
            lockoutWindowMinutes: "lockout_window_minutes" in changes
                ? changes.lockout_window_minutes! : current.lockoutWindowMinutes,
        });
    },
    async createPso(name, minLength, appliesTo) {
        const domain = await getPasswordPolicy();
        await createPso({ name, precedence: 10, appliesTo, policy: { ...domain, minLength } });
    },
    async appendToPso(name, account) {
        const pso = (await listPsos()).find(p => p.name === name)!;
        await updatePso(pso, { ...pso, appliesTo: [...pso.appliesTo, account] });
    },
    deletePso: name => deletePso(name),
    createOu: (name, parent) => createOu(name, parent, ""),
    async renameOu(name, parent, newName) {
        const ou = (await listOus()).find(o => o.dn === ouDn(name, parent))!;
        await updateOu(ou, { name: newName, parent: ou.parent, description: ou.description });
    },
    deleteOu: async (name, parent) => { await deleteOu(ouDn(name, parent), true); },
    moveUser: (name, ou) => moveUser(name, ou),
    createUserWith: (name, d) => createUser(name, password, {
        email: d.email, description: d.description, title: d.title, department: d.department, company: d.company,
        mustChangePassword: d.must_change_password,
    }),
    createGroupWith: (name, d) => createGroup(name, d),
    setGroupEmail: (name, email) => updateGroup(name, { email }),
    createComputer: (name, ou, description) => createComputer(name, { ou, description }),
    setComputerDescription: (name, description) => setComputerDescription(name, description),
    async setDns(zone, name, type, values, ttl) {
        await setDnsRecords(zone, name, type as DnsRecordType, values, ttl);
        const shown = (await listDnsRecords(zone)).filter(r => r.name === name && r.type === type);
        assert.deepEqual(shown.map(r => r.value).sort(), [...values].sort(), "the tab reads the change");
    },
    deleteDns: (zone, name, type, values) => deleteDnsRecords(zone, name, type as DnsRecordType, values),
};

// --- the Ansible modules, one playbook per step

function ansibleDriver(): Driver {
    const dir = mkdtempSync(join(tmpdir(), "t-integration-"));
    let n = 0;
    const play = (module: string, args: object, check = false): Promise<void> => {
        const file = join(dir, `step${++n}.yaml`);
        const tasks = [{ name: module, [`lineadicomando.samba_dc.${module}`]: args }];
        writeFileSync(file, JSON.stringify([{ name: "integration", hosts: "samba_dc", become: true, gather_facts: false, tasks }]));
        return new Promise((resolve, reject) => {
            const child = spawnProcess(join(root, "test/vm/lab.sh"), ["ansible", file, ...(check ? ["--check"] : [])],
                { cwd: root, env });
            let out = "";
            child.stdout.on("data", d => { out += d; });
            child.stderr.on("data", d => { out += d; });
            child.on("close", code => (code === 0 ? resolve() : reject(new Error(`${module} failed:\n${out.slice(-3000)}`))));
        });
    };
    const testPassword = "{{ lookup('env', 'DOMAIN_TEST_PASSWORD') }}";
    const share = (name: string, access: Access[], letter: string) =>
        ({ name, access, drive_letter: letter, drive_label: name });
    return {
        name: "ansible",
        createGroup: name => play("samba_group", { name }),
        createUser: (name, groups) => play("samba_user", { name, password: testPassword, groups, groups_mode: "append" }),
        provisionHome: name => play("samba_home", { name }),
        previewShare: (name, access, letter) => play("samba_share", share(name, access, letter), true),
        createShare: (name, access, letter) => play("samba_share", share(name, access, letter)),
        renameUser: (name, newName) => play("samba_user", { name, new_name: newName }),
        renameGroup: (name, newName) => play("samba_group", { name, new_name: newName }),
        deleteShare: name => play("samba_share", { name, state: "absent", delete_data: true }),
        deleteHome: name => play("samba_home", { name, state: "absent", delete_data: true }),
        deleteUser: name => play("samba_user", { name, state: "absent" }),
        deleteGroup: name => play("samba_group", { name, state: "absent" }),
        domain: () => play("samba_dc_info", {}),
        // 0 is never for the module, as for samba-tool
        createPso: (name, minLength, appliesTo) =>
            play("samba_pso", { name, precedence: 10, min_length: minLength, applies_to: appliesTo }),
        appendToPso: (name, account) => play("samba_pso", { name, applies_to: [account], applies_to_mode: "append" }),
        deletePso: name => play("samba_pso", { name, state: "absent" }),
        createOu: (name, parent) => play("samba_ou", { name, parent }),
        renameOu: (name, parent, newName) => play("samba_ou", { name, parent, new_name: newName }),
        deleteOu: (name, parent) => play("samba_ou", { name, parent, state: "absent", recursive: true }),
        moveUser: (name, ou) => play("samba_user", { name, ou }),
        createUserWith: (name, d) => play("samba_user", { name, password: testPassword, ...d }),
        createGroupWith: (name, d) => play("samba_group", { name, ...d }),
        setGroupEmail: (name, email) => play("samba_group", { name, email }),
        createComputer: (name, ou, description) => play("samba_computer", { name, ou, description }),
        setComputerDescription: (name, description) => play("samba_computer", { name, description }),
        setDns: (zone, name, type, values, ttl) =>
            play("samba_dns_record", { zone, name, type, values, ...(ttl !== undefined ? { ttl } : {}) }),
        deleteDns: (zone, name, type, values) =>
            play("samba_dns_record", { zone, name, type, state: "absent", ...(values ? { values } : {}) }),
        setPolicy: (changes, check) => play("samba_password_policy",
            Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v === null ? 0 : v])), check),
        close: () => rmSync(dir, { recursive: true, force: true }),
    };
}

// --- the tools of addcctl mcp, over SSH and sudo (JSON-RPC, one message per line)

async function mcpDriver(): Promise<Driver> {
    const child = spawnProcess("sshpass", [
        "-e", "ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
        `${env.DC_ADMIN_USER}@${env.DC_HOST}`, "sudo -S -p '' addcctl mcp",
    ], { env: { ...env, SSHPASS: env.DC_ADMIN_PASSWORD } });
    // sudo reads the first line, the server the rest
    child.stdin.write(`${env.DC_ADMIN_PASSWORD}\n`);
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    let buffer = "";
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    child.stdout.on("data", d => {
        buffer += d;
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
            const message = JSON.parse(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
            pending.get(message.id)?.(message);
            pending.delete(message.id);
        }
    });
    let id = 0;
    const request = (method: string, params: object): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method}: ${stderr}`)), 60_000);
        pending.set(++id, m => { clearTimeout(timer); resolve(m); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const init = await request("initialize", {
        protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration", version: "1" },
    });
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, "addcctl", JSON.stringify(init));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const tool = async (name: string, args: object): Promise<Record<string, unknown>> => {
        const answer = await request("tools/call", { name, arguments: args });
        const result = answer.result as { isError: boolean; content: { text: string }[]; structuredContent: Record<string, unknown> };
        if (!result || result.isError) throw new Error(`${name}: ${result?.content[0].text ?? JSON.stringify(answer)}`);
        return result.structuredContent;
    };
    const drive = (name: string, letter: string) => ({ letter, label: name });
    return {
        name: "mcp",
        createGroup: async name => { await tool("group_create", { name }); },
        createUser: async (name, groups) => { await tool("user_create", { name, password, groups }); },
        provisionHome: async name => { await tool("home_provision", { name }); },
        async previewShare(name, access, letter) {
            const out = await tool("share_set", { name, access, drive: drive(name, letter), check: true });
            assert.equal(out.changed, true);
            assert.ok((out.commands as string[]).length > 0, "the preview lists what it would do");
        },
        createShare: async (name, access, letter) => { await tool("share_set", { name, access, drive: drive(name, letter) }); },
        renameUser: async (name, newName) => { await tool("user_set", { name, new_name: newName }); },
        renameGroup: async (name, newName) => { await tool("group_set", { name, new_name: newName }); },
        deleteShare: async name => { await tool("share_delete", { name, delete_data: true }); },
        deleteHome: async name => { await tool("home_delete", { name, delete_data: true }); },
        deleteUser: async name => { await tool("user_delete", { name }); },
        deleteGroup: async name => { await tool("group_delete", { name }); },
        async domain() {
            const info = (await tool("domain_info", {})).domain as { realm: string };
            assert.equal(info.realm, realm());
            const before = ((await tool("backup_list", {})).backups as unknown[]).length;
            const preview = await tool("backup_create", { check: true });
            assert.equal(preview.backup, null);
            assert.equal(((await tool("backup_list", {})).backups as unknown[]).length, before, "a preview makes none");
        },
        createPso: async (name, minLength, appliesTo) => {
            await tool("pso_create", { name, precedence: 10, min_length: minLength, applies_to: appliesTo });
        },
        appendToPso: async (name, account) => {
            await tool("pso_set", { name, applies_to: [account], applies_to_mode: "append" });
        },
        deletePso: async name => { await tool("pso_delete", { name }); },
        createOu: async (name, parent) => { await tool("ou_create", { name, parent }); },
        renameOu: async (name, parent, newName) => { await tool("ou_set", { dn: ouDn(name, parent), new_name: newName }); },
        deleteOu: async (name, parent) => { await tool("ou_delete", { dn: ouDn(name, parent), recursive: true }); },
        moveUser: async (name, ou) => { await tool("user_set", { name, ou }); },
        createUserWith: async (name, d) => { await tool("user_create", { name, password, ...d }); },
        createGroupWith: async (name, d) => { await tool("group_create", { name, ...d }); },
        setGroupEmail: async (name, email) => { await tool("group_set", { name, email }); },
        createComputer: async (name, ou, description) => { await tool("computer_create", { name, ou, description }); },
        setComputerDescription: async (name, description) => { await tool("computer_set", { name, description }); },
        async setDns(zone, name, type, values, ttl) {
            const preview = await tool("dns_set", { zone, name, type, values, check: true });
            assert.equal(preview.changed, true);
            await tool("dns_set", { zone, name, type, values, ...(ttl !== undefined ? { ttl } : {}) });
        },
        deleteDns: async (zone, name, type, values) => { await tool("dns_delete", { zone, name, type, ...(values ? { values } : {}) }); },
        async setPolicy(changes, check) {
            const out = await tool("domain_set_password_policy", { ...changes, ...(check ? { check: true } : {}) });
            assert.equal(out.changed, true);
        },
        close: () => child.stdin.end(),
    };
}

// --- checks on the DC

async function exists(path: string): Promise<boolean> {
    return (await run(["sh", "-c", 'test -e "$1" && echo yes || echo no', "sh", path])).trim() === "yes";
}

async function drivesXml(): Promise<string> {
    return run(["sh", "-c", "cat /var/lib/samba/sysvol/*/Policies/*/USER/Preferences/Drives/Drives.xml 2>/dev/null || true"]);
}

async function homeDrive(user: string): Promise<string> {
    const out = await run(["ldbsearch", "-H", "/var/lib/samba/private/sam.ldb", `(sAMAccountName=${user})`, "homeDrive"]);
    return out.match(/^homeDrive: (.*)$/m)?.[1] ?? "";
}

// smbclient takes the password from PASSWD, set from stdin (not argv)
function smb(share: string, user: string, command: string): Promise<string> {
    return run(["sh", "-c",
        'read -r PASSWD; export PASSWD; out=$(smbclient "//localhost/$1" -U "$2" -c "$3" 2>&1) || { echo "$out" >&2; exit 1; }; echo "$out"',
        "sh", share, `${netbios}\\${user}`, command], `${password}\n`);
}

async function shareAccess(name: string): Promise<string[]> {
    const share = (await core("share get", { name })).share as { access: Access[] };
    return share.access.map(a => `${a.kind}:${a.name}:${a.level}`).sort();
}

let failures = 0;

async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
    process.stdout.write(`  - ${name} ... `);
    try {
        await fn();
        console.log("ok");
        return true;
    } catch (e) {
        failures++;
        console.log("FAILED");
        console.error((e as Error).message.split("\n").map(l => `      ${l}`).join("\n"));
        return false;
    }
}

async function scenario(driver: Driver, letter: string): Promise<void> {
    const p = `t-${driver.name[0]}-`;
    const group = `${p}staff`, group2 = `${p}team`, user = `${p}user`, user2 = `${p}user2`, share = `${p}docs`;
    const pso = `${p}pso`, ou = `${p}ou`, ou2 = `${p}ou2`, inner = `${p}inner`, computer = `${p}pc`.slice(0, 15);
    const access: Access[] = [
        { name: group, kind: "group", level: "write" },
        { name: "student1", kind: "user", level: "read" },
    ];
    console.log(`${driver.name}:`);
    try {
        const ok = await step(`group ${group}, user ${user} in it`, async () => {
            await driver.createGroup(group);
            await driver.createUser(user, [group]);
            const u = (await core("user get", { name: user })).user as { groups: string[]; enabled: boolean };
            assert.ok(u.groups.includes(group), `groups: ${u.groups}`);
            assert.equal(u.enabled, true);
        });
        if (!ok) return;
        await step("home directory, owned by the user, H: at logon", async () => {
            await driver.provisionHome(user);
            assert.equal(await homeDrive(user), "H:");
            // By the SID: a name may still resolve to an account deleted
            // under the same name (an earlier run)
            const sid = ((await core("user get", { name: user })).user as { sid: string }).sid;
            const uid = (await run(["wbinfo", "--sid-to-uid", sid])).trim();
            assert.equal((await run(["stat", "-c", "%u", `/srv/samba/home/${user}`])).trim(), uid);
        });
        if (driver.previewShare) {
            await step("a preview of the share changes nothing", async () => {
                await driver.previewShare!(share, access, letter);
                assert.ok(!(await exists(`/srv/samba/shares/${share}`)));
                const names = ((await core("share list")).shares as { name: string }[]).map(s => s.name);
                assert.ok(!names.includes(share), `listed: ${names}`);
            });
        }
        await step(`share ${share}: ${group} write, student1 read, mapped as ${letter}:`, async () => {
            await driver.createShare(share, access, letter);
            assert.deepEqual(await shareAccess(share), [`group:${group}:write`, "user:student1:read"]);
            const xml = await drivesXml();
            assert.ok(xml.includes(`letter="${letter}"`) && xml.includes(`name="${netbios}\\${group}"`), xml);
        });
        await step("smbd: the user writes, student1 reads, student2 is refused", async () => {
            await smb(share, user, "put /etc/hostname from-user.txt");
            assert.match(await smb(share, "student1", "ls"), /from-user\.txt/);
            await assert.rejects(smb(share, "student1", "put /etc/hostname from-student.txt"), /ACCESS_DENIED/);
            await assert.rejects(smb(share, "student2", "ls"), /ACCESS_DENIED/);
        });
        await step(`rename ${user} → ${user2}, ${group} → ${group2}: the share follows`, async () => {
            await driver.renameUser(user, user2);
            await driver.renameGroup(group, group2);
            assert.deepEqual(await shareAccess(share), [`group:${group2}:write`, "user:student1:read"]);
            const xml = await drivesXml();
            assert.ok(xml.includes(`name="${netbios}\\${group2}"`) && !xml.includes(`${netbios}\\${group}"`), xml);
            await smb(share, user2, "put /etc/hostname from-user2.txt");
        });
        await step(`PSO ${pso} on ${group2}: ${user2} gets it, Samba enforces it`, async () => {
            try {
                await driver.createPso(pso, 14, [group2]);
                const got = await core("user get", { name: user2 });
                const effective = got.password_policy as { pso: string; policy: Policy };
                assert.equal(effective.pso, pso);
                assert.equal(effective.policy.min_length, 14);
                assert.match(await run(["samba-tool", "domain", "passwordsettings", "pso", "show-user", user2]),
                    /Minimum password length: 14/);
                await assert.rejects(core("user password", { name: user2, password: "Abcdef-12345", must_change: false }),
                    /too short/);
                await driver.appendToPso(pso, "student1");
                const listed = ((await core("pso get", { name: pso })).pso as { applies_to: string[] }).applies_to;
                assert.deepEqual(listed, ["student1", group2]);
                await driver.deletePso(pso);
                const after = (await core("user get", { name: user2 })).password_policy as { pso: string | null };
                assert.equal(after.pso, null);
            } finally {
                await core("pso delete", { name: pso });
            }
        });
        await step(`OU ${ou}/${inner}: ${user2} moved in, the OU renamed, deleted with what is in it`, async () => {
            const container = async (name: string) =>
                ((await core("user get", { name })).user as { container: string }).container;
            try {
                await driver.createOu(ou, "");
                await driver.createOu(inner, `OU=${ou}`);
                await driver.moveUser(user2, `OU=${inner},OU=${ou}`);
                assert.equal(await container(user2), `OU=${inner},OU=${ou}`);
                // Its shares and logons do not depend on where it is
                await smb(share, user2, "ls");
                await driver.renameOu(ou, "", ou2);
                assert.equal(await container(user2), `OU=${inner},OU=${ou2}`);
                await assert.rejects(core("ou delete", { dn: `OU=${ou2}` }), /not empty/);
                await driver.moveUser(user2, "CN=Users");
                assert.equal(await container(user2), "CN=Users");
                // A computer in it goes with its DNS records
                await core("computer create", { name: computer, ou: `OU=${inner},OU=${ou2}` });
                await driver.deleteOu(ou2, "");
                const left = ((await core("ou list")).ous as { dn: string }[]).filter(o => o.dn.includes(p));
                assert.deepEqual(left, []);
                await assert.rejects(core("computer get", { name: computer }), /not found/);
                assert.equal(await container(user2), "CN=Users", "the user moved out stays");
            } finally {
                const u = await present("user list", "users", user2);
                if (u && !(await container(u)).startsWith("CN=")) await core("user set", { name: u, ou: "CN=Users" });
                await sweepOus(p);
            }
        });
    } finally {
        // Through the driver, then whatever is left through addcctl
        const u = await present("user list", "users", user2, user) ?? user;
        const g = await present("group list", "groups", group2, group) ?? group;
        const removed = await step("remove the share, the home directory, the user and the group", async () => {
            await driver.deleteShare(share);
            await driver.deleteHome(u);
            await driver.deleteUser(u);
            await driver.deleteGroup(g);
            assert.ok(!(await exists(`/srv/samba/shares/${share}`)));
            assert.ok(!(await exists(`/srv/samba/home/${u}`)));
            assert.ok(!(await drivesXml()).includes(`letter="${letter}"`));
            assert.equal(await present("user list", "users", u), undefined, "user still listed");
            assert.equal(await present("group list", "groups", g), undefined, "group still listed");
        });
        if (!removed) await sweep(p);
    }
    await step("forms: a user with its details, a group with scope, type and e-mail, a computer account", async () => {
        const info = `${p}info`, list = `${p}list`, pc = `${p}pc2`;
        try {
            const details: UserDetails = {
                email: `${info}@example.org`, description: "Integration", title: "Teacher", department: "Science",
                company: "School", must_change_password: true,
            };
            await driver.createUserWith(info, details);
            const u = (await core("user get", { name: info })).user as Record<string, unknown>;
            for (const key of ["email", "description", "title", "department", "company"] as const)
                assert.equal(u[key], details[key], key);
            assert.match(await run(["samba-tool", "user", "show", info, "--attributes=pwdLastSet"]), /pwdLastSet: 0$/m);

            await driver.createGroupWith(list, {
                description: "A list", email: `${list}@example.org`, scope: "universal", category: "distribution",
            });
            await driver.setGroupEmail(list, `${list}-2@example.org`);
            const g = (await core("group get", { name: list })).group as Record<string, unknown>;
            assert.deepEqual([g.description, g.email, g.scope, g.category],
                ["A list", `${list}-2@example.org`, "universal", "distribution"]);

            await driver.createComputer(pc, "CN=Computers", "Lab");
            await driver.setComputerDescription(pc, "Lab, row 2");
            const c = (await core("computer get", { name: pc })).computer as Record<string, unknown>;
            assert.deepEqual([c.description, c.container], ["Lab, row 2", "CN=Computers"]);
        } finally {
            if (await present("user list", "users", info)) await core("user delete", { name: info });
            if (await present("group list", "groups", list)) await core("group delete", { name: list });
            if (await present("computer list", "computers", pc)) await core("computer delete", { name: pc });
        }
    });
    await step("DNS: A and TXT records of a name, served at once, changed, then deleted", async () => {
        const zone = dnsZone(), name = `${p}www`, fqdn = `${name}.${dnsZone()}`;
        try {
            await driver.setDns(zone, name, "A", ["192.0.2.10", "192.0.2.11"], 300);
            await driver.setDns(zone, name, "TXT", ["integration"]);
            assert.deepEqual(await lookup("A", fqdn), ["192.0.2.10", "192.0.2.11"]);
            assert.deepEqual(await lookup("TXT", fqdn), ["\"integration\""]);
            await driver.deleteDns(zone, name, "A", ["192.0.2.11"]);
            assert.deepEqual(await lookup("A", fqdn), ["192.0.2.10"]);
            await driver.deleteDns(zone, name, "A");
            await driver.deleteDns(zone, name, "TXT");
            assert.deepEqual(await lookup("A", fqdn), []);
            assert.deepEqual((await core("dns list", { zone, name })).records, []);
        } finally {
            await sweepDns(p);
        }
    });
    await step("the domain tab: overview, health check, backup", () => driver.domain());
    await step("the password policy: a change, as samba-tool reads it, then restored", () => passwordPolicy(driver));
}

async function policyOnDc(): Promise<Policy> {
    return (await core("domain password-policy")).policy as Policy;
}

async function passwordPolicy(driver: Driver): Promise<void> {
    const before = await policyOnDc();
    const changes: Partial<Policy> = {
        min_length: before.min_length === 10 ? 11 : 10,
        max_age_days: null,
        lockout_threshold: 5,
        lockout_duration_minutes: 20,
        lockout_window_minutes: 15,
    };
    try {
        await driver.setPolicy(changes, true);
        assert.deepEqual(await policyOnDc(), before, "a preview changes nothing");
        await driver.setPolicy(changes);
        assert.deepEqual(await policyOnDc(), { ...before, ...changes });
        const shown = await run(["samba-tool", "domain", "passwordsettings", "show"]);
        for (const line of [`Minimum password length: ${changes.min_length}`, "Maximum password age (days): 0",
            "Account lockout threshold (attempts): 5", "Account lockout duration (mins): 20",
            "Reset account lockout after (mins): 15"]) {
            assert.ok(shown.includes(line), `${line} not in:\n${shown}`);
        }
    } finally {
        await core("domain set-password-policy", before);
    }
    assert.deepEqual(await policyOnDc(), before, "restored");
}

const dnsZone = () => env.DOMAIN_REALM!.toLowerCase();

// What the DC's DNS server answers, sorted
async function lookup(type: string, name: string): Promise<string[]> {
    const out = await run(["dig", "+short", "-t", type, name, "@127.0.0.1"]);
    return out.split("\n").filter(Boolean).sort();
}

// Deletes the records of the names that start with prefix
async function sweepDns(prefix: string): Promise<void> {
    const zone = dnsZone();
    const records = (await core("dns list", { zone })).records as { name: string; type: string; protected: boolean }[];
    for (const r of records) {
        if (r.name.startsWith(prefix) && !r.protected) {
            await core("dns delete", { zone, name: r.name, type: r.type }).catch(() => undefined);
        }
    }
}

// The first of names that the list operation returns, if any
async function present(operation: string, key: string, ...names: string[]): Promise<string | undefined> {
    const all = ((await core(operation))[key] as { name: string }[]).map(x => x.name);
    return names.find(n => all.includes(n));
}

// Deletes the top OUs named with prefix, with what is in them
async function sweepOus(prefix: string): Promise<void> {
    for (const o of (await core("ou list")).ous as { dn: string; name: string; parent: string }[]) {
        if (o.name.startsWith(prefix) && !o.parent.includes(prefix)) {
            await core("ou delete", { dn: o.dn, recursive: true }).catch(() => undefined);
        }
    }
}

// Removes what a failed run left behind, named with prefix
async function sweep(prefix: string, quietly = false): Promise<boolean> {
    const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
    await sweepOus(prefix);
    for (const s of (await core("share list")).shares as { name: string }[]) {
        if (s.name.startsWith(prefix)) await quiet(core("share delete", { name: s.name, delete_data: true }));
    }
    for (const u of (await core("user list")).users as { name: string }[]) {
        if (!u.name.startsWith(prefix)) continue;
        await quiet(core("home delete", { name: u.name, delete_data: true }));
        await quiet(core("user delete", { name: u.name }));
    }
    for (const g of (await core("group list")).groups as { name: string }[]) {
        if (g.name.startsWith(prefix)) await quiet(core("group delete", { name: g.name }));
    }
    await sweepDns(prefix);
    if (!quietly) console.log(`  (left-overs of ${prefix}* removed)`);
    return false;
}

// --- behaviour of the core that no interface changes

async function baseDn(): Promise<string> {
    const raw = await run(["ldbsearch", "-H", "/var/lib/samba/private/sam.ldb", "-s", "base", "-b", "", "defaultNamingContext"]);
    return raw.match(/^defaultNamingContext: (.*)$/m)?.[1] ?? "";
}

async function gpLink(): Promise<string> {
    const raw = await run(["ldbsearch", "-H", "/var/lib/samba/private/sam.ldb", "-s", "base", "-b", await baseDn(), "gPLink"]);
    return raw.replace(/\n /g, "").match(/^gPLink: (.*)$/m)?.[1] ?? "";
}

async function coreChecks(): Promise<void> {
    console.log("core:");
    try {
        await step("members are account names, not CNs (a user made by samba-tool, CN \"Mario Rossi\")", async () => {
            await run(["samba-tool", "user", "create", "t-x-mrossi", "--random-password", "--given-name", "Mario", "--surname", "Rossi"]);
            await core("group create", { name: "t-x-group", members: ["t-x-mrossi", "student1"] });
            const u = (await core("user get", { name: "t-x-mrossi" })).user as { cn: string; groups: string[] };
            assert.equal(u.cn, "Mario Rossi");
            assert.ok(u.groups.includes("t-x-group"), `groups: ${u.groups}`);
            const g = (await core("group get", { name: "t-x-group" })).group as { members: string[] };
            assert.deepEqual(g.members.sort(), ["student1", "t-x-mrossi"]);
        });
        await step("an unlinked drive-mapping GPO is linked again on the next write", async () => {
            await core("share set", { name: "t-x-docs", access: [{ name: "student1" }], drive: { letter: "S" } });
            const link = await gpLink();
            const ours = /\[LDAP:\/\/CN=\{[^}]+\},CN=Policies[^\]]*;0\]$/.exec(link)?.[0];
            assert.ok(ours, `our link is the last one: ${link}`);
            const without = link.slice(0, link.length - ours.length);
            await run(["ldbmodify", "-H", "/var/lib/samba/private/sam.ldb"],
                `dn: ${await baseDn()}\nchangetype: modify\nreplace: gPLink\ngPLink: ${without}\n-\n`);
            assert.equal(await gpLink(), without);
            await core("share set", { name: "t-x-docs", drive: { letter: "S", label: "Documents" } });
            assert.equal(await gpLink(), link);
        });
        await step("domain info: the realm, this DC, every FSMO role it holds", async () => {
            const d = (await core("domain info")).domain as { realm: string; server: string;
                fsmo: { role: string; owner: string }[]; samba_version: string };
            assert.equal(d.realm, realm());
            assert.ok(d.samba_version.length > 0);
            assert.ok(d.fsmo.length >= 5, JSON.stringify(d.fsmo));
            assert.ok(d.fsmo.every(f => f.owner?.toLowerCase() === d.server.toLowerCase()), JSON.stringify(d.fsmo));
        });
        await step("domain check: dbcheck, sysvolcheck and testparm pass", async () => {
            const checks = (await core("domain check")).checks as { name: string; ok: boolean; output: string }[];
            for (const c of checks) assert.ok(c.ok, `${c.name}:\n${c.output}`);
        });
        await step("DNS: the domain's records refused, a deleted name used again, dbcheck clean", async () => {
            const zone = dnsZone();
            const records = (await core("dns list", { zone })).records as { name: string; type: string; protected: boolean }[];
            for (const kind of ["SOA", "NS"]) {
                assert.ok(records.some(r => r.name === "@" && r.type === kind && r.protected), `@ ${kind} protected`);
            }
            assert.ok(records.some(r => r.name.startsWith("_ldap._tcp") && r.protected));
            const dc = ((await core("domain info")).domain as { server: string }).server.toLowerCase();
            await assert.rejects(core("dns set", { zone, name: dc, type: "A", values: ["192.0.2.1"] }).then(r => {
                if ("error" in r) throw new Error(String(r.error));
            }), /belong to the domain/);
            await assert.rejects(run(["addcctl", "dns", "set"], JSON.stringify(
                { zone: `_msdcs.${zone}`, name: "t-x-dns", type: "A", values: ["192.0.2.1"] })), /cannot be changed/);
            await core("dns set", { zone, name: "t-x-dns", type: "CNAME", values: [`${dc}.${zone}`] });
            await core("dns delete", { zone, name: "t-x-dns", type: "CNAME" });
            await core("dns set", { zone, name: "t-x-dns", type: "AAAA", values: ["2001:db8::1"] });
            const again = await core("dns set", { zone, name: "t-x-dns", type: "AAAA", values: ["2001:DB8:0::1"] });
            assert.equal(again.changed, false, "the same address, written otherwise");
            assert.deepEqual(await lookup("AAAA", `t-x-dns.${zone}`), ["2001:db8::1"]);
            await core("dns delete", { zone, name: "t-x-dns", type: "AAAA" });
            const dbcheck = await run(["samba-tool", "dbcheck", "--cross-ncs"]);
            assert.match(dbcheck, /\(0 errors\)/);
        });
        await step("a hand-made share at the shares directory itself is not managed", async () => {
            await run(["net", "conf", "addshare", "t-x-root", "/srv/samba/shares/", "writeable=n", "guest_ok=n"]);
            try {
                const names = ((await core("share list")).shares as { name: string }[]).map(x => x.name);
                assert.ok(!names.includes("t-x-root"), `listed: ${names}`);
                assert.ok(names.includes("t-x-docs"));
            } finally {
                await run(["net", "conf", "delshare", "t-x-root"]);
            }
        });
    } finally {
        await sweep("t-x-", true);
    }
}

async function main(): Promise<void> {
    const chosen = process.argv.slice(2);
    const want = (name: string) => chosen.length === 0 || chosen.includes(name);
    const letters: Record<string, string> = { page: "P", ansible: "Q", mcp: "R" };
    if (want("core")) await coreChecks();
    for (const name of ["page", "ansible", "mcp"]) {
        if (!want(name)) continue;
        const driver = name === "page" ? page : name === "ansible" ? ansibleDriver() : await mcpDriver();
        try {
            await scenario(driver, letters[name]);
        } finally {
            driver.close?.();
        }
    }
    await step("sysvol ACLs (samba-tool ntacl sysvolcheck)", async () => {
        await run(["samba-tool", "ntacl", "sysvolcheck"]);
    });
    if (failures) {
        console.log(`${failures} check(s) failed`);
        process.exit(1);
    }
    console.log("all checks passed");
}

main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
});
