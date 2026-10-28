import { cache, checkName } from "./exec.ts";
import { addcctl } from "./addcctl.ts";
import { GPO_PREFIX } from "./gpos.ts";
import type { ShareSetInput } from "./addcctl-schema.ts";
import { validateShareName } from "./validators.ts";
import type { SharedFolder, ShareAccess, ShareAccessLevel, DriveMapping } from "./types.ts";

// Shared folders are an operation of addcctl, the core on the DC: it owns
// the model (registry shares under /srv/samba/shares, POSIX ACLs, the
// drive-mapping GPO), the checks and the locking. This file translates.

// Letters offered for mapped shares: E–Z, except H (home directories).
// A, B and C are reserved on Windows, D is usually the optical drive.
export const DRIVE_LETTERS = [..."EFGIJKLMNOPQRSTUVWXYZ"];

const SHARES_KEY = "addcctl:share list";
// A change can create or link the drive-mapping GPO, listed in the "Group Policy" tab
const changed = (k: string) => k === SHARES_KEY || k.startsWith(GPO_PREFIX);

export interface ShareData {
    comment: string;
    browseable: boolean;
    access: ShareAccess[];
    automount: DriveMapping | null;
}

interface CoreShare {
    name: string;
    path: string;
    comment: string;
    browseable: boolean;
    access: ShareAccess[];
    drive: DriveMapping | null;
}

function fromCore(s: CoreShare): SharedFolder {
    return {
        name: s.name,
        path: s.path,
        comment: s.comment,
        browseable: s.browseable,
        access: s.access,
        automount: s.drive ? { letter: s.drive.letter, label: s.drive.label } : null,
    };
}

export async function listShares(): Promise<SharedFolder[]> {
    let raw = cache.get(SHARES_KEY, 30_000);
    if (raw === null) {
        raw = JSON.stringify(await addcctl("share list", {}));
        cache.set(SHARES_KEY, raw);
    }
    return (JSON.parse(raw) as { shares: CoreShare[] }).shares.map(fromCore);
}

function checkShareData(data: ShareData): void {
    // An empty "valid users" would open the share to every domain user
    if (data.access.length === 0) throw new Error("A shared folder needs at least one user or group");
    checkName(...data.access.map(a => a.name));
}

function setRequest(name: string, data: ShareData): ShareSetInput {
    return {
        name,
        access: data.access.map(a => ({ name: a.name, kind: a.kind, level: a.level })),
        comment: data.comment,
        browseable: data.browseable,
        drive: data.automount ? { letter: data.automount.letter, label: data.automount.label } : null,
    };
}

// The core creates or updates; creating a share that exists is refused here.
export async function createShare(name: string, data: ShareData): Promise<void> {
    const violation = validateShareName(name);
    if (violation) throw new Error(`Invalid share name "${name}": ${violation}`);
    checkShareData(data);
    cache.invalidate(k => k === SHARES_KEY);
    if ((await listShares()).some(s => s.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A share named "${name}" already exists`);
    }
    try {
        await addcctl("share set", setRequest(name, data));
    } finally {
        cache.invalidate(changed);
    }
}

export async function updateShare(name: string, data: ShareData): Promise<void> {
    checkShareData(data);
    try {
        await addcctl("share set", setRequest(name, data));
    } finally {
        cache.invalidate(changed);
    }
}

export async function deleteShare(name: string, deleteData: boolean): Promise<void> {
    try {
        await addcctl("share delete", { name, delete_data: deleteData });
    } finally {
        cache.invalidate(changed);
    }
}

export interface EffectiveShareAccess {
    level: ShareAccessLevel;
    // The entries that grant access: the user itself and/or its groups
    via: ShareAccess[];
}

// The user's groups plus every group that contains one of them, at any
// depth, as smbd sees them in the user's token. allGroups: the directory's
// groups with their members by account name (listGroups).
export function expandNestedGroups(groups: string[], allGroups: { name: string; members: string[] }[]): string[] {
    const parents = new Map<string, string[]>();
    for (const g of allGroups) {
        for (const m of g.members) {
            const key = m.toLowerCase();
            parents.set(key, [...(parents.get(key) ?? []), g.name]);
        }
    }
    const seen = new Map(groups.map(g => [g.toLowerCase(), g]));
    const queue = [...groups];
    while (queue.length > 0) {
        for (const parent of parents.get(queue.shift()!.toLowerCase()) ?? []) {
            if (seen.has(parent.toLowerCase())) continue; // also stops on cycles
            seen.set(parent.toLowerCase(), parent);
            queue.push(parent);
        }
    }
    return [...seen.values()];
}

// What a user gets on a share, from direct entries and the given groups
// (pass them through expandNestedGroups). Mirrors smbd: a match in
// "read list" makes the share read-only even if another entry grants write.
export function effectiveShareAccess(share: SharedFolder, username: string, groups: string[]): EffectiveShareAccess | null {
    const groupSet = new Set(groups.map(g => g.toLowerCase()));
    const via = share.access.filter(a =>
        a.kind === "user" ? a.name.toLowerCase() === username.toLowerCase() : groupSet.has(a.name.toLowerCase())
    );
    if (via.length === 0) return null;
    return { level: via.some(a => a.level === "read") ? "read" : "write", via };
}
