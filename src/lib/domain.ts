import { cache } from "./exec.ts";
import { addcctl } from "./addcctl.ts";
import type { DomainBackup, DomainInfo, HealthCheck, HealthCheckName } from "./types.ts";

// The "Domain" tab: the overview, the health checks and the backups, all
// operations of addcctl. The overview and the list of backups are cached
// under "domain:"; a backup drops the list, a sysvol reset changes neither.

interface CoreInfo {
    realm: string;
    dns_domain: string;
    netbios_domain: string;
    server: string;
    samba_version: string;
    domain_level: string | null;
    forest_level: string | null;
    domain_controllers: { name: string; dns_name: string; site: string | null }[];
    fsmo: { role: string; owner: string | null }[];
    processes: string | null;
}

interface CoreCheck {
    name: HealthCheckName;
    command: string;
    ok: boolean;
    exit_code: number;
    output: string;
}

interface CoreBackup {
    name: string;
    path: string;
    size: number;
    created: string;
}

const TTL_MS = 60_000;
const INFO_KEY = "domain:info";
const BACKUPS_KEY = "domain:backups";

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const raw = cache.get(key, TTL_MS);
    if (raw !== null) return JSON.parse(raw) as T;
    const value = await load();
    cache.set(key, JSON.stringify(value));
    return value;
}

function toBackup(b: CoreBackup): DomainBackup {
    return { name: b.name, path: b.path, size: b.size, created: Date.parse(b.created) };
}

export async function getDomainInfo(): Promise<DomainInfo> {
    return cached(INFO_KEY, async () => {
        const { domain: d } = (await addcctl("domain info", {})) as { domain: CoreInfo };
        return {
            realm: d.realm,
            dnsDomain: d.dns_domain,
            netbiosDomain: d.netbios_domain,
            server: d.server,
            sambaVersion: d.samba_version,
            domainLevel: d.domain_level,
            forestLevel: d.forest_level,
            domainControllers: d.domain_controllers.map(c => ({ name: c.name, dnsName: c.dns_name, site: c.site })),
            fsmo: d.fsmo.map(f => ({ role: f.role, owner: f.owner })),
            processes: d.processes,
        };
    });
}

// Not cached: run on demand, they are what the administrator asks for now
export async function runHealthChecks(checks?: HealthCheckName[]): Promise<HealthCheck[]> {
    const result = (await addcctl("domain check", checks ? { checks } : {})) as { checks: CoreCheck[] };
    return result.checks.map(c => ({
        name: c.name, command: c.command, ok: c.ok, exitCode: c.exit_code, output: c.output,
    }));
}

export async function resetSysvolAcls(): Promise<void> {
    await addcctl("domain sysvol-reset", {});
}

export async function listBackups(): Promise<DomainBackup[]> {
    return cached(BACKUPS_KEY, async () => {
        const { backups } = (await addcctl("backup list", {})) as { backups: CoreBackup[] };
        return backups.map(toBackup);
    });
}

export async function createBackup(): Promise<DomainBackup | null> {
    try {
        const { backup } = (await addcctl("backup create", {})) as { backup: CoreBackup | null };
        return backup ? toBackup(backup) : null;
    } finally {
        cache.invalidate(k => k === BACKUPS_KEY);
    }
}
