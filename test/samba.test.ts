// Runs samba.ts against the spawn() test double (see cockpit-loader.mjs):
// the directory logic lives in addcctl (core/), tested there; here, what the
// page sends to it, how it reads the answers, and the cache.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSpawnHandler, calls, type SpawnCall } from "./mocks/cockpit.ts";
import {
    listUsers, listGroups, listComputers, getUserDetails, refreshUser, createUser, deleteUser,
    enableUser, disableUser, unlockUser, setAccountExpiry, modifyUser, setUserPassword, setPrimaryGroup,
    getPasswordPolicy, listGroupMembers, addGroupMembers, removeGroupMembers, renameGroup, createGroup,
    deleteComputer, provisionHomeDir, setPasswordPolicy, getUserPasswordPolicy, listPsos, createPso, updatePso,
    deletePso, listOus, createOu, updateOu, deleteOu, moveUser, moveGroup, moveComputer, containerPath,
} from "../src/lib/samba.ts";

// Verbatim shape of addcctl's answers
const USER = {
    name: "nrossi", cn: "Nicolò Rossi", given_name: "Nicolò", surname: "Rossi", email: "", description: "",
    title: "", department: "", company: "", uid_number: "", sid: "S-1-5-21-1-2-3-1112", rid: "1112",
    enabled: true, locked_out: true, expires: "2025-08-18T14:13:20Z", last_logon: "2026-10-21T18:48:20Z",
    groups: ["Domain Admins", "Domain Users"], primary_group: "Domain Users", critical: false,
    home_drive: "H:", home_directory: "\\\\DC\\home\\nrossi", container: "OU=Staff",
};
const KRBTGT = { ...USER, name: "krbtgt", cn: "krbtgt", rid: "502", enabled: false, locked_out: false, expires: null,
    last_logon: null, groups: ["Domain Users"], critical: true };
const GROUP = { name: "Teachers", description: "", email: "", sid: "S-1-5-21-1-2-3-1108", rid: "1108",
    members: ["mrossi"], primary_members: ["bianchi", "mrossi"], member_count: 2, scope: "global",
    category: "distribution", critical: false, protected: false, container: "CN=Users" };
const CORE_POLICY = { complexity: true, min_length: 7, history_length: 24, min_age_days: 1, max_age_days: null,
    lockout_threshold: 0, lockout_duration_minutes: 30, lockout_window_minutes: 30 };
const PSO = { ...CORE_POLICY, name: "Staff long", precedence: 5, min_length: 14, applies_to: ["Teachers"] };
const ANSWERS: Record<string, unknown> = {
    "user list": { users: [USER, KRBTGT] },
    "user get": { user: USER, password_policy: { pso: "Staff long", policy: { ...CORE_POLICY, min_length: 14 } } },
    "pso list": { psos: [PSO] },
    "group list": { groups: [GROUP] },
    "group get": { group: GROUP },
    "ou list": { ous: [
        { dn: "CN=Users", name: "Users", description: "", parent: "", kind: "container", builtin: true,
            default_for: "users" },
        { dn: "OU=School", name: "School", description: "", parent: "", kind: "ou", builtin: false, default_for: null },
        { dn: "OU=Rossi\\, Mario,OU=School", name: "Rossi, Mario", description: "x", parent: "OU=School", kind: "ou",
            builtin: false, default_for: null },
    ] },
    "computer list": { computers: [{ name: "PC01", dn: "CN=PC01,CN=Computers,DC=x", sid: "", rid: "1300", os: "",
        os_version: "", dns_name: "", description: "", last_logon: null, container: "CN=Computers",
        domain_controller: false }] },
    "domain password-policy": { policy: { complexity: true, min_length: 7, history_length: 24, min_age_days: 1,
        max_age_days: null, lockout_threshold: 0, lockout_duration_minutes: 30, lockout_window_minutes: 30 } },
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

// Mutations drop the cache; one at the start of a test gives fresh reads
async function fresh() {
    core();
    await enableUser("cache-reset");
    calls.length = 0;
}

describe("users", () => {
    it("translates addcctl's users into the page's", async () => {
        await fresh();
        const [u, k] = await listUsers();
        assert.equal(u.username, "nrossi");
        assert.equal(u.fullName, "Nicolò Rossi");
        assert.equal(u.id, "1112");
        assert.equal(u.status, "Active");
        assert.ok(u.isAdmin);
        assert.ok(u.lockedOut);
        assert.equal(u.accountExpires, Date.parse("2025-08-18T14:13:20Z"));
        assert.ok(u.expired);
        assert.equal(u.lastActivity, new Date("2026-10-21T18:48:20Z").toLocaleDateString());
        assert.ok(k.isProtected && k.isStatusLocked);
        assert.equal(k.status, "Disabled");
        assert.equal(k.lastActivity, "");
        assert.equal(u.container, "OU=Staff");
    });

    it("caches reads until a mutation", async () => {
        await fresh();
        await listUsers();
        await getUserDetails("nrossi");
        await listUsers();
        await getUserDetails("NROSSI");
        assert.equal(calls.length, 2);
        await disableUser("nrossi");
        await listUsers();
        assert.equal(sent("user list").length, 2);
        await refreshUser("nrossi");
        assert.equal(sent("user get").length, 2);
    });

    it("sends the password on stdin, never in argv", async () => {
        await fresh();
        await createUser("mrossi", "S3cret!pw", "Mario", "Rossi");
        const create = calls.find(c => op(c) === "user create")!;
        assert.deepEqual(create.args, ["addcctl", "user", "create"]);
        assert.deepEqual(JSON.parse(create.input!), { name: "mrossi", password: "S3cret!pw", given_name: "Mario", surname: "Rossi" });
        await setUserPassword("mrossi", "N3w!pass", true);
        assert.deepEqual(sent("user password"), [{ name: "mrossi", password: "N3w!pass", must_change: true }]);
        assert.ok(!calls.some(c => c.args.some(a => a.includes("S3cret") || a.includes("N3w!"))));
    });

    it("maps each change to user set or its own operation", async () => {
        await fresh();
        await enableUser("a");
        await disableUser("a");
        await unlockUser("a");
        await setPrimaryGroup("a", "Teachers");
        await setAccountExpiry("a", new Date(Date.UTC(2027, 5, 30, 22)));
        await setAccountExpiry("a", null);
        assert.deepEqual(sent("user set"), [
            { name: "a", enabled: true }, { name: "a", enabled: false }, { name: "a", primary_group: "Teachers" },
            { name: "a", expires: "2027-06-30T22:00:00.000Z" }, { name: "a", expires: null },
        ]);
        assert.deepEqual(sent("user unlock"), [{ name: "a" }]);
        await assert.rejects(setAccountExpiry("a", new Date(NaN)), /Invalid account expiry date/);
    });

    it("renames through user set, which renames in the shares too", async () => {
        await fresh();
        await modifyUser("mrossi", { newUsername: "mario.rossi", email: "m@x" });
        await modifyUser("mrossi", { newUsername: "mrossi" });
        assert.deepEqual(sent("user set"), [{ name: "mrossi", email: "m@x", new_name: "mario.rossi" }]);
    });

    it("passes the core's error on as it is", async () => {
        setSpawnHandler(() => { throw new Error('Renamed "a" to "b", but updating its shared folders failed: x'); });
        await assert.rejects(modifyUser("a", { newUsername: "b" }), /^Error: Renamed "a" to "b", but updating/);
    });

    it("rejects option-like names before any command runs", async () => {
        await fresh();
        await assert.rejects(deleteUser("--help"), /Invalid account name/);
        await assert.rejects(addGroupMembers("Teachers", ["alice", "-x"]), /Invalid account name/);
        await assert.rejects(createGroup("-H"), /Invalid account name/);
        assert.equal(calls.length, 0);
    });
});

describe("groups, computers, homes, policy", () => {
    it("reads groups and lists the primary members too", async () => {
        await fresh();
        const [g] = await listGroups();
        assert.deepEqual([g.name, g.id, g.memberCount, g.groupType], ["Teachers", "1108", 2, "Distribution"]);
        assert.deepEqual(await listGroupMembers("Teachers"), ["mrossi", "bianchi"]);
    });

    it("maps members and renames to group set", async () => {
        await fresh();
        await addGroupMembers("Teachers", ["a", "b"]);
        await removeGroupMembers("Teachers", ["a"]);
        await renameGroup("Teachers", "Docenti");
        assert.deepEqual(sent("group set"), [
            { name: "Teachers", members: ["a", "b"], members_mode: "append" },
            { name: "Teachers", members: ["a"], members_mode: "remove" },
            { name: "Teachers", new_name: "Docenti" },
        ]);
    });

    it("computers, home directories and the password policy", async () => {
        await fresh();
        assert.deepEqual(await listComputers(), [{ name: "PC01", dn: "CN=PC01,CN=Computers,DC=x", id: "1300", os: "-", lastLogon: "",
            container: "CN=Computers", isDomainController: false }]);
        await deleteComputer("PC01");
        await provisionHomeDir("nrossi");
        assert.deepEqual(sent("computer delete"), [{ name: "PC01" }]);
        assert.deepEqual(sent("home provision"), [{ name: "nrossi" }]);
        assert.deepEqual(await getPasswordPolicy(), {
            complexityRequired: true, minLength: 7, historyLength: 24, minAgeDays: 1, maxAgeDays: null,
            lockoutThreshold: 0, lockoutDurationMinutes: 30, lockoutWindowMinutes: 30,
        });
    });

    it("sends only the settings of the policy that change, and drops the cached one", async () => {
        await fresh();
        const current = await getPasswordPolicy();
        await setPasswordPolicy(current, current);
        assert.deepEqual(sent("domain set-password-policy"), []);
        await setPasswordPolicy(current, { ...current, complexityRequired: false, maxAgeDays: 90, lockoutDurationMinutes: null });
        assert.deepEqual(sent("domain set-password-policy"),
            [{ complexity: false, max_age_days: 90, lockout_duration_minutes: null }]);
        calls.length = 0;
        await getPasswordPolicy();
        assert.equal(sent("domain password-policy").length, 1);
    });
});

describe("fine-grained password policies", () => {
    it("reads the policies and the one that applies to a user", async () => {
        await fresh();
        const [pso] = await listPsos();
        assert.equal(pso.name, "Staff long");
        assert.equal(pso.precedence, 5);
        assert.equal(pso.policy.minLength, 14);
        assert.equal(pso.policy.maxAgeDays, null);
        assert.deepEqual(pso.appliesTo, ["Teachers"]);
        const effective = await getUserPasswordPolicy("nrossi");
        assert.equal(effective.pso, "Staff long");
        assert.equal(effective.policy.minLength, 14);
    });

    it("creates with every setting, changes only what differs, deletes", async () => {
        await fresh();
        const [pso] = await listPsos();
        await createPso({ ...pso, name: "New" });
        assert.deepEqual(sent("pso create"), [{
            name: "New", precedence: 5, applies_to: ["Teachers"], complexity: true, min_length: 14,
            history_length: 24, min_age_days: 1, max_age_days: null, lockout_threshold: 0,
            lockout_duration_minutes: 30, lockout_window_minutes: 30,
        }]);
        await updatePso(pso, { ...pso, appliesTo: ["teachers"] });
        assert.deepEqual(sent("pso set"), [], "same users and groups, case aside: nothing to send");
        await updatePso(pso, { ...pso, precedence: 1, appliesTo: ["Teachers", "nrossi"],
            policy: { ...pso.policy, lockoutThreshold: 5 } });
        assert.deepEqual(sent("pso set"), [{ name: "Staff long", lockout_threshold: 5, precedence: 1,
            applies_to: ["Teachers", "nrossi"] }]);
        await deletePso("Staff long");
        assert.deepEqual(sent("pso delete"), [{ name: "Staff long" }]);
        calls.length = 0;
        await listPsos();
        assert.equal(sent("pso list").length, 1, "a change drops the cached list");
    });

    it("refuses a name that would read as an option", async () => {
        await fresh();
        const [pso] = await listPsos();
        await assert.rejects(createPso({ ...pso, appliesTo: ["-x"] }), /Invalid account name/);
    });
});

describe("organizational units", () => {
    it("reads the tree and the containers of accounts", async () => {
        await fresh();
        const ous = await listOus();
        assert.deepEqual(ous.map(o => o.path), ["Users", "School", "School/Rossi, Mario"]);
        assert.ok(ous[0].builtIn && !ous[0].isOu && ous[0].defaultFor === "users");
        assert.equal(containerPath("OU=Students,OU=School"), "School/Students");
        assert.equal(containerPath(""), "");
    });

    it("creates, changes only what differs, deletes", async () => {
        await fresh();
        const [, school, inner] = await listOus();
        await createOu("1A", "OU=School", "");
        assert.deepEqual(sent("ou create"), [{ name: "1A", parent: "OU=School" }]);
        await updateOu(inner, { name: inner.name, parent: "ou=school", description: "x" });
        assert.deepEqual(sent("ou set"), [], "nothing changed, case aside");
        await updateOu(inner, { name: "Bianchi", parent: "", description: "" });
        await updateOu(school, { name: "School", parent: "", description: "Main" });
        assert.deepEqual(sent("ou set"), [
            { dn: "OU=Rossi\\, Mario,OU=School", new_name: "Bianchi", parent: "", description: "" },
            { dn: "OU=School", description: "Main" },
        ]);
        setSpawnHandler(() => JSON.stringify({ changed: true, deleted_accounts: ["s1"], commands: [], check: false }));
        assert.deepEqual(await deleteOu("OU=School", true), ["s1"]);
        assert.deepEqual(JSON.parse(calls[calls.length - 1].input!), { dn: "OU=School", recursive: true });
    });

    it("creates accounts in an OU and moves them", async () => {
        await fresh();
        await createUser("s1", "S3cret!pw", undefined, undefined, "OU=School");
        await createGroup("g1", "OU=School");
        await createGroup("g2");
        assert.deepEqual(sent("user create"), [{ name: "s1", password: "S3cret!pw", ou: "OU=School" }]);
        assert.deepEqual(sent("group create"), [{ name: "g1", ou: "OU=School" }, { name: "g2" }]);
        await moveUser("s1", "CN=Users");
        await moveGroup("g1", "CN=Users");
        await moveComputer("PC01", "OU=School");
        assert.deepEqual(sent("user set"), [{ name: "s1", ou: "CN=Users" }]);
        assert.deepEqual(sent("group set"), [{ name: "g1", ou: "CN=Users" }]);
        assert.deepEqual(sent("computer set"), [{ name: "PC01", ou: "OU=School" }]);
    });

    it("drops the cached lists after a move", async () => {
        await fresh();
        await listUsers();
        await listOus();
        await moveUser("nrossi", "OU=School");
        calls.length = 0;
        await listUsers();
        await listOus();
        assert.equal(calls.length, 2);
    });
});
