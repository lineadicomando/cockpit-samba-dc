import { cache, checkName } from "./exec.ts";
import { addcctl } from "./addcctl.ts";
import type { DomainSetPasswordPolicyInput, PsoCreateInput } from "./addcctl-schema.ts";
import type { User, Group, Computer, PasswordPolicy, Pso, EffectivePolicy } from "./types.ts";

// Users, groups, computers, home directories and the password policy are
// operations of addcctl, the core on the DC: it reads sam.ldb, makes the
// changes and enforces the rules on built-in accounts. This file translates
// its answers into the page's types and caches them.

const PROTECTED_USERS = new Set(["administrator", "krbtgt", "guest"]);
// Administrator and krbtgt: their status is never changed
const STATUS_LOCKED_RIDS = new Set(["500", "502"]);

interface CoreUser {
    name: string;
    cn: string;
    given_name: string;
    surname: string;
    email: string;
    uid_number: string;
    rid: string;
    enabled: boolean;
    locked_out: boolean;
    expires: string | null;
    last_logon: string | null;
    groups: string[];
    primary_group: string;
    critical: boolean;
    home_drive: string;
    home_directory: string;
}

interface CoreGroup {
    name: string;
    description: string;
    rid: string;
    members: string[];
    primary_members: string[];
    member_count: number;
    category: "security" | "distribution";
    critical: boolean;
    protected: boolean;
}

interface CoreComputer {
    name: string;
    dn: string;
    rid: string;
    os: string;
    last_logon: string | null;
}

interface CorePolicy {
    complexity: boolean;
    min_length: number;
    history_length: number;
    min_age_days: number;
    max_age_days: number | null;
    lockout_threshold: number;
    lockout_duration_minutes: number | null;
    lockout_window_minutes: number | null;
}

interface CorePso extends CorePolicy {
    name: string;
    precedence: number;
    applies_to: string[];
}

const KEY = (op: string, name = "") => `addcctl:${op}${name ? `\x1f${name.toLowerCase()}` : ""}`;

async function cached<T>(key: string, ttlMs: number, load: () => Promise<unknown>): Promise<T> {
    let raw = cache.get(key, ttlMs);
    if (raw === null) {
        raw = JSON.stringify(await load());
        cache.set(key, raw);
    }
    return JSON.parse(raw) as T;
}

// Every change can affect several answers (a rename, a membership, a share
// that lists the account): drop them all, they are cheap to read again.
function invalidateAll(): void {
    cache.invalidate(k => k.startsWith("addcctl:"));
}

async function mutate(run: () => Promise<unknown>): Promise<void> {
    try {
        await run();
    } finally {
        invalidateAll();
    }
}

// Returns "" when there was never a logon; the UI renders the translated "Never".
function localDate(iso: string | null): string {
    return iso ? new Date(iso).toLocaleDateString() : "";
}

function toUser(u: CoreUser): User {
    const accountExpires = u.expires ? Date.parse(u.expires) : null;
    return {
        username: u.name,
        fullName: u.cn || u.name,
        givenName: u.given_name,
        surname: u.surname,
        email: u.email,
        id: u.uid_number || u.rid || "-",
        status: u.enabled ? "Active" : "Disabled",
        lastActivity: localDate(u.last_logon),
        groups: u.groups,
        primaryGroup: u.primary_group,
        isAdmin: u.groups.some(g => /domain admins|administrators/i.test(g)),
        isProtected: PROTECTED_USERS.has(u.name.toLowerCase()) || u.critical,
        isStatusLocked: STATUS_LOCKED_RIDS.has(u.rid),
        homeDrive: u.home_drive,
        homeDirectory: u.home_directory,
        lockedOut: u.locked_out,
        accountExpires,
        expired: accountExpires !== null && accountExpires <= Date.now(),
    };
}

function toGroup(g: CoreGroup): Group {
    return {
        name: g.name,
        description: g.description,
        id: g.rid || "-",
        memberCount: g.member_count,
        members: g.members,
        isCriticalSystemObject: g.critical,
        isProtected: g.protected,
        groupType: g.category === "distribution" ? "Distribution" : "Security",
    };
}

function toComputer(c: CoreComputer): Computer {
    return { name: c.name, dn: c.dn, id: c.rid || "-", os: c.os || "-", lastLogon: localDate(c.last_logon) };
}

// --- lists ---

export async function listUsers(): Promise<User[]> {
    const { users } = await cached<{ users: CoreUser[] }>(KEY("user list"), 30_000, () => addcctl("user list", {}));
    return users.map(toUser);
}

export async function listGroups(): Promise<Group[]> {
    const { groups } = await cached<{ groups: CoreGroup[] }>(KEY("group list"), 60_000, () => addcctl("group list", {}));
    return groups.map(toGroup);
}

export async function listComputers(): Promise<Computer[]> {
    const { computers } = await cached<{ computers: CoreComputer[] }>(KEY("computer list"), 60_000,
        () => addcctl("computer list", {}));
    return computers.map(toComputer);
}

// --- users ---

async function coreUser(username: string): Promise<{ user: CoreUser; password_policy?: { pso: string | null; policy: CorePolicy } }> {
    checkName(username);
    return cached(KEY("user get", username), 30_000, () => addcctl("user get", { name: username }));
}

export async function getUserDetails(username: string): Promise<User> {
    return toUser((await coreUser(username)).user);
}

// The policy that applies to the user: a PSO's, or the domain's
export async function getUserPasswordPolicy(username: string): Promise<EffectivePolicy> {
    const effective = (await coreUser(username)).password_policy;
    if (!effective) return { pso: null, policy: await getPasswordPolicy() };
    return { pso: effective.pso, policy: toPolicy(effective.policy) };
}

export async function refreshUser(username: string): Promise<User> {
    invalidateAll();
    return getUserDetails(username);
}

export async function createUser(username: string, password: string, givenName?: string, surname?: string): Promise<void> {
    checkName(username);
    // The password reaches addcctl on stdin, in its JSON input
    await mutate(() => addcctl("user create", {
        name: username, password,
        ...(givenName ? { given_name: givenName } : {}),
        ...(surname ? { surname } : {}),
    }));
}

export async function deleteUser(username: string): Promise<void> {
    checkName(username);
    await mutate(() => addcctl("user delete", { name: username }));
}

export async function enableUser(username: string): Promise<void> {
    checkName(username);
    await mutate(() => addcctl("user set", { name: username, enabled: true }));
}

export async function disableUser(username: string): Promise<void> {
    checkName(username);
    await mutate(() => addcctl("user set", { name: username, enabled: false }));
}

export async function unlockUser(username: string): Promise<void> {
    checkName(username);
    await mutate(() => addcctl("user unlock", { name: username }));
}

// expiresAt null: the account never expires
export async function setAccountExpiry(username: string, expiresAt: Date | null): Promise<void> {
    checkName(username);
    if (expiresAt !== null && isNaN(expiresAt.getTime())) throw new Error("Invalid account expiry date");
    await mutate(() => addcctl("user set", { name: username, expires: expiresAt ? expiresAt.toISOString() : null }));
}

// A new name also renames the user in the shared folders (addcctl does it)
export async function modifyUser(username: string, data: { givenName?: string; surname?: string; email?: string; newUsername?: string }): Promise<void> {
    checkName(username);
    const input = {
        name: username,
        ...(data.givenName !== undefined ? { given_name: data.givenName } : {}),
        ...(data.surname !== undefined ? { surname: data.surname } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.newUsername && data.newUsername !== username ? { new_name: data.newUsername } : {}),
    };
    if (Object.keys(input).length === 1) return;
    await mutate(() => addcctl("user set", input));
}

export async function setUserPassword(username: string, newPassword: string, mustChange: boolean): Promise<void> {
    checkName(username);
    await mutate(() => addcctl("user password", { name: username, password: newPassword, must_change: mustChange }));
}

export async function setPrimaryGroup(username: string, groupName: string): Promise<void> {
    checkName(username, groupName);
    await mutate(() => addcctl("user set", { name: username, primary_group: groupName }));
}

function toPolicy(p: CorePolicy): PasswordPolicy {
    return {
        complexityRequired: p.complexity,
        minLength: p.min_length,
        historyLength: p.history_length,
        minAgeDays: p.min_age_days,
        maxAgeDays: p.max_age_days,
        lockoutThreshold: p.lockout_threshold,
        lockoutDurationMinutes: p.lockout_duration_minutes,
        lockoutWindowMinutes: p.lockout_window_minutes,
    };
}

// The settings of wanted that differ from current, as addcctl takes them
function policyChanges(current: PasswordPolicy | null, wanted: PasswordPolicy): DomainSetPasswordPolicyInput {
    const changes: DomainSetPasswordPolicyInput = {};
    const differs = <K extends keyof PasswordPolicy>(key: K) => current === null || wanted[key] !== current[key];
    if (differs("complexityRequired")) changes.complexity = wanted.complexityRequired;
    if (differs("minLength")) changes.min_length = wanted.minLength;
    if (differs("historyLength")) changes.history_length = wanted.historyLength;
    if (differs("minAgeDays")) changes.min_age_days = wanted.minAgeDays;
    if (differs("maxAgeDays")) changes.max_age_days = wanted.maxAgeDays;
    if (differs("lockoutThreshold")) changes.lockout_threshold = wanted.lockoutThreshold;
    if (differs("lockoutDurationMinutes")) changes.lockout_duration_minutes = wanted.lockoutDurationMinutes;
    if (differs("lockoutWindowMinutes")) changes.lockout_window_minutes = wanted.lockoutWindowMinutes;
    return changes;
}

export async function getPasswordPolicy(): Promise<PasswordPolicy> {
    const { policy } = await cached<{ policy: CorePolicy }>(KEY("domain password-policy"), 300_000,
        () => addcctl("domain password-policy", {}));
    return toPolicy(policy);
}

// Sends only the settings that differ from the current policy
export async function setPasswordPolicy(current: PasswordPolicy, wanted: PasswordPolicy): Promise<void> {
    const changes = policyChanges(current, wanted);
    if (Object.keys(changes).length === 0) return;
    await mutate(() => addcctl("domain set-password-policy", changes));
}

// --- fine-grained password policies (PSOs) ---

function toPso(p: CorePso): Pso {
    return { name: p.name, precedence: p.precedence, policy: toPolicy(p), appliesTo: p.applies_to };
}

export async function listPsos(): Promise<Pso[]> {
    const { psos } = await cached<{ psos: CorePso[] }>(KEY("pso list"), 60_000, () => addcctl("pso list", {}));
    return psos.map(toPso);
}

export async function createPso(pso: Pso): Promise<void> {
    checkName(...pso.appliesTo);
    const input: PsoCreateInput = {
        name: pso.name, precedence: pso.precedence, applies_to: pso.appliesTo, ...policyChanges(null, pso.policy),
    };
    await mutate(() => addcctl("pso create", input));
}

// Sends only what differs; the list of users and groups replaces the current one
export async function updatePso(current: Pso, wanted: Pso): Promise<void> {
    checkName(...wanted.appliesTo);
    const sameTargets = current.appliesTo.length === wanted.appliesTo.length
        && current.appliesTo.every(n => wanted.appliesTo.some(w => w.toLowerCase() === n.toLowerCase()));
    const input = {
        name: current.name,
        ...policyChanges(current.policy, wanted.policy),
        ...(wanted.precedence !== current.precedence ? { precedence: wanted.precedence } : {}),
        ...(sameTargets ? {} : { applies_to: wanted.appliesTo }),
    };
    if (Object.keys(input).length === 1) return;
    await mutate(() => addcctl("pso set", input));
}

export async function deletePso(name: string): Promise<void> {
    await mutate(() => addcctl("pso delete", { name }));
}

// --- groups ---

async function coreGroup(name: string): Promise<CoreGroup> {
    checkName(name);
    const { group } = await cached<{ group: CoreGroup }>(KEY("group get", name), 60_000,
        () => addcctl("group get", { name }));
    return group;
}

export async function getGroupDetails(name: string): Promise<Group> {
    return toGroup(await coreGroup(name));
}

export async function refreshGroup(name: string): Promise<Group> {
    invalidateAll();
    return getGroupDetails(name);
}

// Members, with the accounts whose primary group this is
export async function listGroupMembers(groupName: string): Promise<string[]> {
    const group = await coreGroup(groupName);
    return [...group.members, ...group.primary_members.filter(m => !group.members.includes(m))];
}

export async function createGroup(name: string): Promise<void> {
    checkName(name);
    await mutate(() => addcctl("group create", { name }));
}

export async function deleteGroup(name: string): Promise<void> {
    checkName(name);
    await mutate(() => addcctl("group delete", { name }));
}

// The CN follows the new name, and so do the shared folders (addcctl)
export async function renameGroup(oldName: string, newName: string): Promise<void> {
    checkName(oldName, newName);
    await mutate(() => addcctl("group set", { name: oldName, new_name: newName }));
}

export async function addGroupMembers(groupName: string, members: string[]): Promise<void> {
    checkName(groupName, ...members);
    await mutate(() => addcctl("group set", { name: groupName, members, members_mode: "append" }));
}

export async function removeGroupMembers(groupName: string, members: string[]): Promise<void> {
    checkName(groupName, ...members);
    await mutate(() => addcctl("group set", { name: groupName, members, members_mode: "remove" }));
}

// --- computers ---

export async function deleteComputer(name: string): Promise<void> {
    checkName(name);
    await mutate(() => addcctl("computer delete", { name }));
}

// --- home directories ---

export async function provisionHomeDir(username: string): Promise<void> {
    checkName(username);
    await mutate(() => addcctl("home provision", { name: username }));
}
