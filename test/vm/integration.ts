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
import {
    addGroupMembers, createGroup, createUser, deleteGroup, deleteUser, modifyUser, provisionHomeDir, renameGroup,
} from "../../src/lib/samba.ts";
import { createShare, deleteShare } from "../../src/lib/shares.ts";
import { addcctl } from "../../src/lib/addcctl.ts";

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
    close?(): void;
}

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
}

// The first of names that the list operation returns, if any
async function present(operation: string, key: string, ...names: string[]): Promise<string | undefined> {
    const all = ((await core(operation))[key] as { name: string }[]).map(x => x.name);
    return names.find(n => all.includes(n));
}

// Removes what a failed run left behind, named with prefix
async function sweep(prefix: string, quietly = false): Promise<boolean> {
    const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
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
