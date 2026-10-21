import { cache, checkName, runAsRoot, getWorkgroup, SHARES_DIR } from "./exec.ts";
import { parseNetConf, parseSmbUserList, parseSmbBool } from "./parsers.ts";
import { validateShareName } from "./validators.ts";
import { listDriveMappings, setDriveMapping } from "./drivemaps.ts";
import type { SharedFolder, ShareAccess, ShareAccessLevel, DriveMapping } from "./types.ts";

const NET_CONF_KEY = "net:conf";

export interface ShareData {
    comment: string;
    browseable: boolean;
    access: ShareAccess[];
    automount: DriveMapping | null;
}

// Registry shares live in "net conf"; only those whose path is exactly
// SHARES_DIR/<name> (the shape createShare uses) are managed here, so the
// module never runs a recursive setfacl or rm on a path it did not create:
// the home share, hand-made shares, or SHARES_DIR itself ("…/shares/",
// "…/shares/.").
export function isManagedPath(path: string): boolean {
    if (!path.startsWith(`${SHARES_DIR}/`)) return false;
    const dir = path.slice(SHARES_DIR.length + 1);
    return dir !== "" && dir !== "." && dir !== ".." && !dir.includes("/");
}

async function loadNetConf(): Promise<Map<string, Record<string, string>>> {
    let raw = cache.get(NET_CONF_KEY, 30_000);
    if (raw === null) {
        raw = await runAsRoot(["net", "conf", "list"]);
        cache.set(NET_CONF_KEY, raw);
    }
    return parseNetConf(raw);
}

function principalKey(p: { name: string; kind: string }): string {
    return `${p.kind}:${p.name.toLowerCase()}`;
}

function buildShare(name: string, params: Record<string, string>, automount: DriveMapping | null): SharedFolder {
    const readOnly = params["read only"] !== undefined
        ? parseSmbBool(params["read only"], true)
        : !parseSmbBool(params["writeable"] ?? params["writable"] ?? params["write ok"], false);
    const readList = new Set(parseSmbUserList(params["read list"] ?? "").map(principalKey));
    const writeList = new Set(parseSmbUserList(params["write list"] ?? "").map(principalKey));
    const access: ShareAccess[] = parseSmbUserList(params["valid users"] ?? "").map(p => {
        const key = principalKey(p);
        const canWrite = !readList.has(key) && (!readOnly || writeList.has(key));
        return { ...p, level: canWrite ? "write" : "read" };
    });
    return {
        name,
        path: params["path"] ?? "",
        comment: params["comment"] ?? "",
        browseable: parseSmbBool(params["browseable"] ?? params["browsable"], true),
        access,
        automount,
    };
}

export async function listShares(): Promise<SharedFolder[]> {
    const [conf, drives] = await Promise.all([loadNetConf(), listDriveMappings()]);
    return [...conf.entries()]
        .filter(([, params]) => isManagedPath(params["path"] ?? ""))
        .map(([name, params]) => buildShare(name, params, drives.get(name.toLowerCase()) ?? null));
}

async function findShare(name: string): Promise<SharedFolder> {
    const share = (await listShares()).find(s => s.name.toLowerCase() === name.toLowerCase());
    if (!share) throw new Error(`Shared folder "${name}" not found`);
    return share;
}

function formatUserList(entries: ShareAccess[], workgroup: string): string {
    return entries.map(e => `${e.kind === "group" ? "@" : ""}"${workgroup}\\${e.name}"`).join(" ");
}

// getent resolves both users and groups here: on a DC, winbind maps each
// SID as both a uid and a gid (ID_TYPE_BOTH).
async function principalExists(workgroup: string, name: string): Promise<boolean> {
    try {
        await runAsRoot(["getent", "passwd", `${workgroup}\\${name}`]);
        return true;
    } catch {
        return false;
    }
}

// Rewrites the POSIX ACL of the whole tree: the same model as the home
// directories (no NT ACL is written; acl_xattr derives it from the POSIX ACL
// and notices when that changes).
async function applyAcl(path: string, oldAccess: ShareAccess[], newAccess: ShareAccess[]): Promise<void> {
    const workgroup = await getWorkgroup();
    const names = [...new Set([...oldAccess, ...newAccess].map(a => a.name.toLowerCase()))];
    const exists = new Map(await Promise.all(
        names.map(async n => [n, await principalExists(workgroup, n)] as const)
    ));
    const missing = newAccess.filter(a => !exists.get(a.name.toLowerCase()));
    if (missing.length > 0) {
        throw new Error(`Unknown user or group: ${missing.map(a => a.name).join(", ")}`);
    }

    // Files created over SMB carry each principal as both a "u:" and a "g:"
    // entry (see principalExists), so both are cleared before re-adding the
    // current ones: a stale "g:<user>" entry would otherwise keep granting
    // write access after a downgrade to read-only.
    const remove = names
        .filter(n => exists.get(n))
        .flatMap(n => ["u", "g", "d:u", "d:g"].map(tag => `${tag}:${workgroup}\\${n}`));
    const add = ["g::---", "d:u::rwx", "d:g::---", "d:o::---"];
    for (const a of newAccess) {
        const entry = `${a.kind === "group" ? "g" : "u"}:${workgroup}\\${a.name}:${a.level === "write" ? "rwX" : "r-X"}`;
        add.push(entry, `d:${entry}`);
    }
    const args = ["setfacl", "-R"];
    if (remove.length > 0) args.push("-x", remove.join(","));
    args.push("-m", add.join(","), path);
    await runAsRoot(args);
}

async function applyShareParams(name: string, data: ShareData): Promise<void> {
    const workgroup = await getWorkgroup();
    const readers = data.access.filter(a => a.level === "read");
    const set = (param: string, value: string) => runAsRoot(["net", "conf", "setparm", name, param, value]);
    const del = (param: string) => runAsRoot(["net", "conf", "delparm", name, param]);

    await set("valid users", formatUserList(data.access, workgroup));
    await (readers.length > 0 ? set("read list", formatUserList(readers, workgroup)) : del("read list"));
    await (data.comment ? set("comment", data.comment) : del("comment"));
    await set("browseable", data.browseable ? "yes" : "no");
}

function checkShareData(data: ShareData): void {
    // An empty "valid users" would open the share to every domain user
    if (data.access.length === 0) throw new Error("A shared folder needs at least one user or group");
    checkName(...data.access.map(a => a.name));
}

// Checked before touching anything, so a clash does not leave a share
// created without its mapping (setDriveMapping re-checks under its lock).
async function checkDriveLetterFree(name: string, automount: DriveMapping | null): Promise<void> {
    if (!automount) return;
    const letter = automount.letter.toUpperCase();
    for (const [share, mapping] of await listDriveMappings()) {
        if (share !== name.toLowerCase() && mapping.letter === letter) {
            throw new Error(`Drive letter ${letter}: is already used by "${share}"`);
        }
    }
}

export async function createShare(name: string, data: ShareData): Promise<void> {
    const violation = validateShareName(name);
    if (violation) throw new Error(`Invalid share name "${name}": ${violation}`);
    checkShareData(data);
    cache.invalidate(k => k === NET_CONF_KEY);
    const conf = await loadNetConf();
    if ([...conf.keys()].some(s => s.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A share named "${name}" already exists`);
    }
    await checkDriveLetterFree(name, data.automount);

    const path = `${SHARES_DIR}/${name}`;
    try {
        await runAsRoot(["mkdir", "-p", path]);
        await runAsRoot(["chown", "root:root", path]);
        // setgid keeps new files in the directory's group
        await runAsRoot(["chmod", "2770", path]);
        await applyAcl(path, [], data.access);
        await runAsRoot(["net", "conf", "addshare", name, path, "writeable=y", "guest_ok=n"]);
        await runAsRoot(["net", "conf", "setparm", name, "inherit acls", "yes"]);
        await applyShareParams(name, data);
        if (data.automount) await setDriveMapping(name, data.access, data.automount);
    } finally {
        cache.invalidate(k => k === NET_CONF_KEY);
    }
}

export async function updateShare(name: string, data: ShareData): Promise<void> {
    checkShareData(data);
    cache.invalidate(k => k === NET_CONF_KEY);
    const share = await findShare(name);
    await checkDriveLetterFree(share.name, data.automount);
    try {
        await applyAcl(share.path, share.access, data.access);
        await applyShareParams(share.name, data);
        // Also when only the access list changed: the mapping targets it
        if (share.automount || data.automount) await setDriveMapping(share.name, data.access, data.automount);
    } finally {
        cache.invalidate(k => k === NET_CONF_KEY);
    }
}

export async function deleteShare(name: string, deleteData: boolean): Promise<void> {
    cache.invalidate(k => k === NET_CONF_KEY);
    const share = await findShare(name);
    try {
        if (share.automount) await setDriveMapping(share.name, [], null);
        await runAsRoot(["net", "conf", "delshare", share.name]);
        if (deleteData) await runAsRoot(["rm", "-rf", "--one-file-system", "--", share.path]);
    } finally {
        cache.invalidate(k => k === NET_CONF_KEY);
    }
}

// Called after a user or group is renamed: smb.conf lists principals by
// name, so without this they would lose access to their shares. The POSIX
// ACL needs no change (it stores uid/gid, which follow the SID); the drive
// mapping is rewritten only to refresh the names next to the SIDs.
export async function renameSharePrincipal(kind: "user" | "group", oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    cache.invalidate(k => k === NET_CONF_KEY);
    try {
        for (const share of await listShares()) {
            const matches = (a: ShareAccess) => a.kind === kind && a.name.toLowerCase() === oldName.toLowerCase();
            if (!share.access.some(matches)) continue;
            const access = share.access.map(a => (matches(a) ? { ...a, name: newName } : a));
            const data = { comment: share.comment, browseable: share.browseable, access, automount: share.automount };
            await applyShareParams(share.name, data);
            if (share.automount) await setDriveMapping(share.name, access, share.automount);
        }
    } finally {
        cache.invalidate(k => k === NET_CONF_KEY);
    }
}

export interface EffectiveShareAccess {
    level: ShareAccessLevel;
    // The entries that grant access: the user itself and/or its groups
    via: ShareAccess[];
}

// What a user gets on a share, from direct entries and the groups listed on
// the user (nested groups are not expanded). Mirrors smbd: a match in
// "read list" makes the share read-only even if another entry grants write.
export function effectiveShareAccess(share: SharedFolder, username: string, groups: string[]): EffectiveShareAccess | null {
    const groupSet = new Set(groups.map(g => g.toLowerCase()));
    const via = share.access.filter(a =>
        a.kind === "user" ? a.name.toLowerCase() === username.toLowerCase() : groupSet.has(a.name.toLowerCase())
    );
    if (via.length === 0) return null;
    return { level: via.some(a => a.level === "read") ? "read" : "write", via };
}
