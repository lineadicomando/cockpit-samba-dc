import { cache } from "./exec.ts";
import { addcctl } from "./addcctl.ts";
import type { DnsRecord, DnsRecordType, DnsZone } from "./types.ts";

// The "DNS" tab: zones and records, operations of addcctl, which refuses to
// change the records the domain depends on. Cached under "addcctl:dns:", so
// that the changes of samba.ts (a computer deleted with its records) drop
// them too; a change here drops only these.

const TTL_MS = 60_000;
const PREFIX = "addcctl:dns:";

interface CoreZone {
    name: string;
    partition: string;
    read_only: boolean;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const raw = cache.get(PREFIX + key, TTL_MS);
    if (raw !== null) return JSON.parse(raw) as T;
    const value = await load();
    cache.set(PREFIX + key, JSON.stringify(value));
    return value;
}

export async function listDnsZones(): Promise<DnsZone[]> {
    return cached("zones", async () => {
        const { zones } = (await addcctl("dns zones", {})) as { zones: CoreZone[] };
        return zones.map(z => ({ name: z.name, partition: z.partition, readOnly: z.read_only }));
    });
}

export async function listDnsRecords(zone: string): Promise<DnsRecord[]> {
    return cached(`records:${zone.toLowerCase()}`, async () => {
        const { records } = (await addcctl("dns list", { zone })) as { records: DnsRecord[] };
        return records;
    });
}

async function mutate(run: () => Promise<unknown>): Promise<void> {
    try {
        await run();
    } finally {
        cache.invalidate(k => k.startsWith(PREFIX));
    }
}

// The records of one type at one name become exactly these values
export async function setDnsRecords(zone: string, name: string, type: DnsRecordType, values: string[],
    ttl?: number): Promise<void> {
    await mutate(() => addcctl("dns set", { zone, name, type, values, ...(ttl !== undefined ? { ttl } : {}) }));
}

// Without values, every record of that type at that name
export async function deleteDnsRecords(zone: string, name: string, type: DnsRecordType,
    values?: string[]): Promise<void> {
    await mutate(() => addcctl("dns delete", { zone, name, type, ...(values ? { values } : {}) }));
}
