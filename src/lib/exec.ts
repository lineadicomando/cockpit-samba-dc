import cockpit from "cockpit";
import { createCache } from "./cache.ts";
import { parseLdapMulti, firstValue } from "./parsers.ts";

// Shared by samba.ts and shares.ts, so mutations in one module can invalidate
// entries cached by the other.
export const cache = createCache();

export function cacheKey(...args: string[]): string {
    return args.join("\x1f");
}

export const SAM_LDB = "/var/lib/samba/private/sam.ldb";

// Everything the module creates on disk lives under one base directory.
export const SAMBA_BASE = "/srv/samba";
export const HOMES_DIR = `${SAMBA_BASE}/home`;
export const SHARES_DIR = `${SAMBA_BASE}/shares`;

// Defense in depth for names reaching samba-tool/chown as positional args:
// a leading "-" would be parsed as an option. The UI validates new names, but
// existing directory objects and future callers go through here too.
export function checkName(...names: string[]): void {
    for (const name of names) {
        if (!name || name.startsWith("-")) throw new Error(`Invalid account name: "${name}"`);
    }
}

export function runAsRoot(args: string[]): Promise<string> {
    return cockpit.spawn(args, { superuser: "require", err: "message" });
}

export function runAsRootWithInput(args: string[], input: string): Promise<string> {
    return cockpit.spawn(args, { superuser: "require", err: "message" }).input(input);
}

// Read from the local config rather than "samba-tool domain info", which is a
// CLDAP network query and fails when Samba does not listen on loopback.
const smbConfParams = new Map<string, string>();

async function getSmbConfParam(name: string, section = "global"): Promise<string> {
    const key = `${section}\x1f${name}`;
    const known = smbConfParams.get(key);
    if (known) return known;
    const args = ["testparm", "-s", `--parameter-name=${name}`];
    if (section !== "global") args.push(`--section-name=${section}`);
    const value = (await runAsRoot(args)).trim();
    if (!value) throw new Error(`Cannot determine "${name}" from smb.conf`);
    smbConfParams.set(key, value);
    return value;
}

export function getDCNetbiosName(): Promise<string> {
    return getSmbConfParam("netbios name");
}

// NetBIOS domain name, the prefix winbind expects in "DOMAIN\name".
export function getWorkgroup(): Promise<string> {
    return getSmbConfParam("workgroup");
}

// Kerberos realm (e.g. SCHOOL.INTERNAL); its lowercase form is the DNS domain
// used in sysvol paths.
export function getRealm(): Promise<string> {
    return getSmbConfParam("realm");
}

export function getSysvolPath(): Promise<string> {
    return getSmbConfParam("path", "sysvol");
}

// Read from the local sam.ldb rootDSE rather than "samba-tool domain info
// 127.0.0.1", which is a CLDAP network query and fails when Samba does not
// listen on loopback (e.g. "bind interfaces only").
const ROOT_DSE_KEY = "ldb:rootdse";

export async function getBaseDN(): Promise<string> {
    let raw = cache.get(ROOT_DSE_KEY, 3_600_000);
    if (raw === null) {
        raw = await runAsRoot(["ldbsearch", "-H", SAM_LDB, "-s", "base", "-b", "", "defaultNamingContext"]);
        cache.set(ROOT_DSE_KEY, raw);
    }
    const dn = parseLdapMulti(raw).map(f => firstValue(f, "defaultNamingContext")).find(Boolean);
    if (!dn) throw new Error("Cannot determine the domain naming context from sam.ldb");
    return dn;
}
