// Runs samba.ts against the spawn() test double (see cockpit-loader.mjs).
// samba.ts keeps module state (cache, home share promise, NetBIOS name), so
// the tests below share one instance and are written to be order-independent.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import { listUsers, listGroups, createUser, createGroup, addGroupMembers, deleteUser, provisionHomeDir, modifyUser, renameGroup, unlockUser, setAccountExpiry, getUserDetails } from "../src/lib/samba.ts";

const ROOT_DSE = [
    "# record 1",
    "dn: ",
    "defaultNamingContext: DC=school,DC=internal",
    "",
    "# returned 1 records",
].join("\n");

// Verbatim shape of ldbsearch output on Samba 4.22: non-ASCII values in
// base64, long lines folded at 78 columns, trailing referrals.
const USERS = [
    "# record 1",
    "dn: CN=Nicolò Rossi,CN=Users,DC=school,DC=internal",
    "cn:: Tmljb2zDsiBSb3NzaQ==",
    "givenName:: Tmljb2zDsg==",
    "sAMAccountName: nrossi",
    "userAccountControl: 512",
    "objectSid: S-1-5-21-1-2-3-1112",
    "primaryGroupID: 513",
    "memberOf: CN=Gruppo docenti con un nome decisamente lungo per il test LDIF,CN=",
    " Users,DC=school,DC=internal",
    "",
    "# Referral",
    "ref: ldap://school.internal/CN=Configuration,DC=school,DC=internal",
    "",
    "# returned 2 records",
].join("\n");

const GROUPS = [
    "# record 1",
    "dn: CN=Domain Users,CN=Users,DC=school,DC=internal",
    "sAMAccountName: Domain Users",
    "objectSid: S-1-5-21-1-2-3-513",
    "",
].join("\n");

function isCmd(call: SpawnCall, ...prefix: string[]): boolean {
    return prefix.every((p, i) => call.args[i] === p);
}

function ldbHandler(call: SpawnCall): string {
    if (call.args.includes("-s") && call.args.includes("base")) return ROOT_DSE;
    if (call.args.includes("(objectClass=group)")) return GROUPS;
    return USERS;
}

describe("listUsers", () => {
    it("decodes base64 names, unfolds long DNs and resolves the primary group", async () => {
        setSpawnHandler(call => (isCmd(call, "ldbsearch") ? ldbHandler(call) : ""));
        const users = await listUsers();
        assert.equal(users.length, 1);
        assert.equal(users[0].username, "nrossi");
        assert.equal(users[0].fullName, "Nicolò Rossi");
        assert.equal(users[0].givenName, "Nicolò");
        assert.deepEqual(users[0].groups, [
            "Gruppo docenti con un nome decisamente lungo per il test LDIF",
            "Domain Users",
        ]);
        assert.equal(users[0].primaryGroup, "Domain Users");
    });

    it("reads the base DN from the local rootDSE, not from a network query", async () => {
        setSpawnHandler(call => (isCmd(call, "ldbsearch") ? ldbHandler(call) : ""));
        await listUsers();
        assert.ok(!calls.some(c => c.args.includes("domain") && c.args.includes("info")));
    });
});

describe("createUser", () => {
    it("passes the password on stdin, never in argv", async () => {
        setSpawnHandler(() => "");
        await createUser("mrossi", "S3cret!pw", "Mario", "Rossi");
        const add = calls.find(c => isCmd(c, "samba-tool", "user", "add"));
        assert.ok(add);
        assert.ok(!add.args.some(a => a.includes("S3cret!pw")));
        assert.equal(add.input, "S3cret!pw\nS3cret!pw\n");
        assert.deepEqual(add.args, ["samba-tool", "user", "add", "mrossi", "--given-name=Mario", "--surname=Rossi"]);
    });
});

describe("option-like names", () => {
    it("are rejected before any command runs", async () => {
        setSpawnHandler(() => "");
        await assert.rejects(createGroup("-H"), /Invalid account name/);
        await assert.rejects(deleteUser("--help"), /Invalid account name/);
        await assert.rejects(addGroupMembers("Teachers", ["alice", "-x"]), /Invalid account name/);
        assert.equal(calls.length, 0);
    });
});

describe("provisionHomeDir", () => {
    it("creates the home share once when several users are provisioned in parallel", async () => {
        let shareExists = false;
        let addshareCount = 0;
        setSpawnHandler(async call => {
            if (isCmd(call, "testparm")) return "DC\n";
            if (isCmd(call, "samba-tool", "user", "show")) {
                return `dn: CN=${call.args[3]},CN=Users,DC=school,DC=internal\nsAMAccountName: ${call.args[3]}\n`;
            }
            if (isCmd(call, "net", "conf", "getparm")) {
                if (!shareExists) throw new Error("share not found");
                return "/srv/samba/home\n";
            }
            if (isCmd(call, "net", "conf", "addshare")) {
                // Real "net conf addshare" fails if the share already exists
                if (shareExists) throw new Error("ERROR: share home already exists");
                await new Promise(r => setTimeout(r, 10));
                shareExists = true;
                addshareCount++;
                return "";
            }
            return "";
        });

        const users = ["alice", "bob", "carol"];
        await Promise.all(users.map(u => provisionHomeDir(u)));

        assert.equal(addshareCount, 1);
        for (const u of users) {
            const chown = calls.find(c => isCmd(c, "chown") && c.args[2] === `/srv/samba/home/${u}`);
            assert.deepEqual(chown?.args, ["chown", `${u}:`, `/srv/samba/home/${u}`]);
            const modify = calls.find(c => isCmd(c, "ldbmodify") && c.input?.includes(`CN=${u},`));
            assert.ok(modify?.input?.includes(`homeDirectory: \\\\DC\\home\\${u}`));
            assert.ok(modify?.input?.includes("homeDrive: H:"));
        }
    });
});

describe("home share", () => {
    it("moves an existing home share to the current base directory", async () => {
        // Separate module instance: the home share promise above is already settled
        // @ts-expect-error -- the query string is not a path TypeScript can resolve
        const { provisionHomeDir: provision } = await import("../src/lib/samba.ts?home-move");
        setSpawnHandler(call => {
            if (isCmd(call, "testparm")) return "DC\n";
            if (isCmd(call, "samba-tool", "user", "show")) return "dn: CN=u1,CN=Users,DC=school,DC=internal\n";
            if (isCmd(call, "net", "conf", "getparm")) return "/home/samba\n";
            return "";
        });
        await provision("u1");
        assert.ok(calls.some(c => c.args.join(" ") === "net conf setparm home path /srv/samba/home"));
        assert.ok(!calls.some(c => isCmd(c, "net", "conf", "addshare")));
    });
});

describe("home share removed meanwhile", () => {
    it("is created again by the next provisioning", async () => {
        // @ts-expect-error -- the query string is not a path TypeScript can resolve
        const { provisionHomeDir: provision } = await import("../src/lib/samba.ts?home-removed");
        let shareExists = false;
        setSpawnHandler(call => {
            if (isCmd(call, "testparm")) return "DC\n";
            if (isCmd(call, "samba-tool", "user", "show")) return `dn: CN=${call.args[3]},CN=Users,DC=school,DC=internal\n`;
            if (isCmd(call, "net", "conf", "getparm")) {
                if (!shareExists) throw new Error("share not found");
                return "/srv/samba/home\n";
            }
            if (isCmd(call, "net", "conf", "addshare")) shareExists = true;
            return "";
        });
        await provision("u1");
        shareExists = false; // "net conf delshare home" by hand
        await provision("u2");
        assert.equal(calls.filter(c => isCmd(c, "net", "conf", "addshare")).length, 2);
    });
});

describe("DN resolution", () => {
    // CNs differ from account names: samba-tool names users "Given Surname",
    // and groups made with other tools can have any CN.
    const groups = [
        "dn: CN=Docenti (2026),CN=Users,DC=school,DC=internal",
        "sAMAccountName: Teachers",
        "objectSid: S-1-5-21-1-2-3-1108",
        "member: CN=Rossi\\, Mario,CN=Users,DC=school,DC=internal",
        "member: CN=PC01,CN=Computers,DC=school,DC=internal",
        "",
        "dn: CN=Domain Users,CN=Users,DC=school,DC=internal",
        "sAMAccountName: Domain Users",
        "objectSid: S-1-5-21-1-2-3-513",
        "",
    ].join("\n");
    const users = [
        "dn: CN=Rossi\\, Mario,CN=Users,DC=school,DC=internal",
        "cn: Rossi, Mario",
        "sAMAccountName: mrossi",
        "objectSid: S-1-5-21-1-2-3-1200",
        "primaryGroupID: 513",
        "memberOf: cn=docenti (2026),cn=users,dc=school,dc=internal",
        "",
    ].join("\n");
    function handler(call: SpawnCall): string {
        if (call.args.includes("-s") && call.args.includes("base")) return ROOT_DSE;
        if (call.args.includes("(objectClass=group)")) return groups;
        return users;
    }
    // Mutations drop the cached ldbsearch results of the earlier tests
    async function resetCaches(): Promise<void> {
        setSpawnHandler(() => "");
        await createGroup("cache-reset");
        await createUser("cache-reset", "x");
        setSpawnHandler(handler);
    }

    it("lists group members by account name", async () => {
        await resetCaches();
        const teachers = (await listGroups()).find(g => g.name === "Teachers");
        assert.deepEqual(teachers?.members, ["mrossi", "PC01"]);
        assert.equal((await listGroups()).find(g => g.name === "Domain Users")?.memberCount, 1);
    });

    it("lists user groups by account name", async () => {
        await resetCaches();
        const [u] = await listUsers();
        assert.deepEqual(u.groups, ["Teachers", "Domain Users"]);
    });
});

describe("renames", () => {
    function handler(call: SpawnCall): string {
        if (isCmd(call, "addcctl")) return JSON.stringify({ changed: true, shares: ["docs"], commands: [], check: false });
        if (isCmd(call, "ldbsearch")) return call.args.includes("defaultNamingContext") ? ROOT_DSE : "";
        return "";
    }
    const renameInput = () => JSON.parse(calls.find(c => isCmd(c, "addcctl", "share", "rename-principal"))?.input ?? "null");

    it("renaming a user updates the shares that list it", async () => {
        setSpawnHandler(handler);
        await modifyUser("mrossi", { newUsername: "mario.rossi" });
        assert.deepEqual(renameInput(), { kind: "user", old: "mrossi", new: "mario.rossi" });
    });

    it("renaming a group updates the shares that list it", async () => {
        setSpawnHandler(handler);
        await renameGroup("Teachers", "Docenti");
        assert.deepEqual(renameInput(), { kind: "group", old: "Teachers", new: "Docenti" });
        // Samba 4.22 takes the new name as an option, not a second argument
        assert.deepEqual(calls.find(c => isCmd(c, "samba-tool", "group", "rename"))?.args,
            ["samba-tool", "group", "rename", "Teachers", "--samaccountname=Docenti"]);
    });

    it("other edits leave the shares alone", async () => {
        setSpawnHandler(handler);
        await modifyUser("mrossi", { email: "m@school.internal" });
        assert.ok(!calls.some(c => isCmd(c, "addcctl")));
    });

    it("reports a share update failure as happening after the rename", async () => {
        setSpawnHandler(call => {
            if (isCmd(call, "addcctl")) throw new Error("registry locked");
            return handler(call);
        });
        await assert.rejects(renameGroup("Teachers", "Docenti"), /Renamed "Teachers" to "Docenti", but updating its shared folders failed: registry locked/);
        assert.ok(calls.some(c => isCmd(c, "samba-tool", "group", "rename")));
    });
});

describe("lockout and expiry", () => {
    // Verbatim shape of "samba-tool user show --attributes=*,msDS-User-Account-Control-Computed"
    // on Samba 4.22 for an account locked out and expired
    const show = [
        "dn: CN=student2,CN=Users,DC=school,DC=internal",
        "sAMAccountName: student2",
        "userAccountControl: 512",
        "accountExpires: 134000000000000000",
        "lockoutTime: 134372390602576080",
        "badPwdCount: 3",
        "objectSid: S-1-5-21-1-2-3-1105",
        "primaryGroupID: 513",
        "msDS-User-Account-Control-Computed: 16",
        "",
    ].join("\n");
    function handler(call: SpawnCall): string {
        if (isCmd(call, "samba-tool", "user", "show")) return show;
        if (isCmd(call, "ldbsearch")) return ldbHandler(call);
        return "";
    }

    it("reads the lock and the expiry date", async () => {
        setSpawnHandler(handler);
        const u = await getUserDetails("student2");
        assert.equal(u.lockedOut, true);
        assert.equal(u.expired, true);
        assert.equal(new Date(u.accountExpires!).toISOString(), "2025-08-18T14:13:20.000Z");
        assert.deepEqual(calls.find(c => isCmd(c, "samba-tool", "user", "show"))?.args,
            ["samba-tool", "user", "show", "student2", "--attributes=*,msDS-User-Account-Control-Computed"]);
    });

    it("drops the cached detail after an unlock", async () => {
        setSpawnHandler(handler);
        await getUserDetails("student2");
        await unlockUser("student2");
        calls.length = 0;
        await getUserDetails("student2");
        assert.equal(calls.filter(c => isCmd(c, "samba-tool", "user", "show")).length, 1);
    });

    it("unlocks with samba-tool", async () => {
        setSpawnHandler(handler);
        await unlockUser("student2");
        assert.deepEqual(calls.map(c => c.args), [["samba-tool", "user", "unlock", "student2"]]);
    });

    it("writes accountExpires alone, leaving userAccountControl as it is", async () => {
        setSpawnHandler(handler);
        await setAccountExpiry("student2", new Date(Date.UTC(2027, 5, 30, 22, 0, 0)));
        const modify = calls.find(c => isCmd(c, "ldbmodify"));
        assert.equal(modify?.input, [
            "dn: CN=student2,CN=Users,DC=school,DC=internal",
            "changetype: modify",
            "replace: accountExpires",
            "accountExpires: 134588664000000000",
            "-",
            "",
        ].join("\n"));
        assert.ok(!calls.some(c => isCmd(c, "samba-tool", "user", "setexpiry")));
    });

    it("writes the never-expires value", async () => {
        setSpawnHandler(handler);
        await setAccountExpiry("student2", null);
        assert.ok(calls.find(c => isCmd(c, "ldbmodify"))?.input?.includes("accountExpires: 9223372036854775807\n"));
    });

    it("rejects an invalid date before any command runs", async () => {
        setSpawnHandler(handler);
        await assert.rejects(setAccountExpiry("student2", new Date(NaN)), /Invalid account expiry date/);
        await assert.rejects(unlockUser("-x"), /Invalid account name/);
        assert.equal(calls.length, 0);
    });
});
