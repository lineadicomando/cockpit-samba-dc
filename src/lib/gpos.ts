import { cache } from "./exec.ts";
import { addcctl } from "./addcctl.ts";
import type { Gpo, GpoLink } from "./types.ts";

// The "Group Policy" tab: the GPOs and where they are linked, operations of
// addcctl, which keeps the default GPOs and the drive-mapping GPO linked
// where they are. Cached under "addcctl:gpo:": the changes of samba.ts (an
// OU renamed or deleted) and of shares.ts (the drive-mapping GPO created)
// drop these too; a change here drops only these.

const TTL_MS = 60_000;
export const GPO_PREFIX = "addcctl:gpo:";

interface CoreGpo {
    guid: string;
    name: string;
    path: string;
    version: { user: number; computer: number };
    user_enabled: boolean;
    computer_enabled: boolean;
    builtin: boolean;
    drive_mapping: boolean;
    links: GpoLink[];
}

function toGpo(g: CoreGpo): Gpo {
    return {
        guid: g.guid,
        name: g.name,
        path: g.path,
        version: g.version,
        userEnabled: g.user_enabled,
        computerEnabled: g.computer_enabled,
        builtIn: g.builtin,
        driveMapping: g.drive_mapping,
        links: g.links,
    };
}

export async function listGpos(): Promise<Gpo[]> {
    const raw = cache.get(GPO_PREFIX + "list", TTL_MS);
    if (raw !== null) return JSON.parse(raw) as Gpo[];
    const { gpos } = (await addcctl("gpo list", {})) as { gpos: CoreGpo[] };
    const value = gpos.map(toGpo);
    cache.set(GPO_PREFIX + "list", JSON.stringify(value));
    return value;
}

async function mutate(run: () => Promise<unknown>): Promise<Gpo> {
    try {
        const { gpo } = (await run()) as { gpo: CoreGpo };
        return toGpo(gpo);
    } finally {
        cache.invalidate(k => k.startsWith(GPO_PREFIX));
    }
}

// Link the GPO to container ("" for the domain), or change the flags of its
// link there; flags left out keep their value. Returns the GPO as it is now.
export async function linkGpo(guid: string, container: string,
    flags: { enforced?: boolean; disabled?: boolean } = {}): Promise<Gpo> {
    return mutate(() => addcctl("gpo link", { gpo: guid, container, ...flags }));
}

export async function unlinkGpo(guid: string, container: string): Promise<Gpo> {
    return mutate(() => addcctl("gpo unlink", { gpo: guid, container }));
}
