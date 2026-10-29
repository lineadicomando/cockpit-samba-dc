import { cache, forgetCachedData } from "./exec.ts";
import { addcctl } from "./addcctl.ts";
import type {
    DomainBackup, DomainInfo, HealthCheck, HealthCheckName, NewDomain, ProvisionedDomain, SetupStatus,
} from "./types.ts";

// The "Domain" tab: the overview, the health checks and the backups, all
// operations of addcctl. The overview and the list of backups are cached
// under "domain:"; a backup drops the list, a sysvol reset changes neither.
// Also the setup of a new domain, on a host with none (SetupPage).

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

// -- a new domain (domain setup-check, domain provision)

interface CoreSetup {
    provisioned: boolean;
    ready: boolean;
    checks: SetupStatus["checks"];
    host: { name: string; address: string | null; prefix_length: number | null; interface: string | null } | null;
    defaults: { realm: string | null; netbios_domain: string | null; dns_forwarder: string | null } | null;
}

interface CoreProvisioned {
    domain: { realm: string; dns_domain: string; netbios_domain: string; server: string; address: string;
        dns_forwarder: string };
    commands: string[];
    smb_conf_dist: string | null;
}

// Not cached: asked when the page opens, and again after each fix
export async function getSetupStatus(): Promise<SetupStatus> {
    const r = (await addcctl("domain setup-check", {})) as CoreSetup;
    return {
        provisioned: r.provisioned,
        ready: r.ready,
        checks: r.checks,
        host: r.host && { name: r.host.name, address: r.host.address, prefixLength: r.host.prefix_length,
            interface: r.host.interface },
        defaults: r.defaults && { realm: r.defaults.realm, netbiosDomain: r.defaults.netbios_domain,
            dnsForwarder: r.defaults.dns_forwarder },
    };
}

function provisionInput(d: NewDomain) {
    return { realm: d.realm, netbios_domain: d.netbiosDomain, admin_password: d.adminPassword,
        dns_forwarder: d.dnsForwarder };
}

// What the provisioning would change on the host (addcctl --check), for the confirmation
export async function previewProvision(d: NewDomain): Promise<string[]> {
    const r = (await addcctl("domain provision", provisionInput(d), { check: true })) as CoreProvisioned;
    return r.commands;
}

export async function provisionDomain(d: NewDomain): Promise<ProvisionedDomain> {
    try {
        const r = (await addcctl("domain provision", provisionInput(d))) as CoreProvisioned;
        return { realm: r.domain.realm, dnsDomain: r.domain.dns_domain, netbiosDomain: r.domain.netbios_domain,
            server: r.domain.server, address: r.domain.address, commands: r.commands };
    } finally {
        // Whatever was read before belongs to no domain
        forgetCachedData();
    }
}
