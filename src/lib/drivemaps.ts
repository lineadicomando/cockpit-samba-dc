// Automatic drive mapping through Group Policy Preferences: one dedicated GPO,
// linked to the domain root, holds a Drives.xml where each mapped share is a
// <Drive> item targeted (item-level targeting) at the users and groups that
// can access it. Windows clients apply it at logon.
//
// The GPO is written directly to the local sam.ldb and sysvol, as root, so no
// domain credentials are needed ("samba-tool gpo" works over SMB/LDAP and
// would require them).
import { cache, runAsRoot, runAsRootWithInput, getBaseDN, getRealm, getSysvolPath, getDCNetbiosName, getWorkgroup, SAM_LDB } from "./exec.ts";
import { parseLdapMulti, firstValue } from "./parsers.ts";
import type { ShareAccess, DriveMapping } from "./types.ts";

export const DRIVE_MAP_GPO_NAME = "Cockpit - Mapped drives";

// Letters offered for mapped shares: E–Z, except H (home directories).
// A, B and C are reserved on Windows, D is usually the optical drive.
export const DRIVE_LETTERS = [..."EFGIJKLMNOPQRSTUVWXYZ"];

const DRIVES_CLSID = "{8FDDCC1A-0C3C-43cd-A6B4-71A6DF20DA8C}";
const DRIVE_CLSID = "{935D1B74-9CB8-4e3c-9914-7DD559B7A417}";
// Client-side extensions that process Group Policy Preferences drive maps
const USER_EXTENSION_NAMES =
    "[{00000000-0000-0000-0000-000000000000}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]" +
    "[{5794DAFD-BE60-433F-88A2-1A31939AC01F}{2EA1A81B-48E5-45E9-8BB7-A6E3AC170006}]";
// versionNumber / GPT.INI "Version": user-side version in the high 16 bits.
// Clients only reapply a GPO whose version has changed.
const USER_VERSION_STEP = 65536;

const DRIVES_KEY = "gpo:drives";

interface Gpo {
    guid: string;
    dn: string;
    version: number;
}

// --- Drives.xml -------------------------------------------------------------

export interface DriveEntry {
    uid: string;
    path: string;
    letter: string;
    label: string;
    filters: string;
    xml: string;
}

function xmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
        .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlAttr(tag: string, name: string): string {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return m ? xmlUnescape(m[1]) : "";
}

export function parseDrivesXml(raw: string): DriveEntry[] {
    return [...raw.matchAll(/<Drive\s[\s\S]*?<\/Drive>/g)].map(([xml]) => {
        const driveTag = /<Drive\s[^>]*>/.exec(xml)?.[0] ?? "";
        const props = /<Properties\s[^>]*>/.exec(xml)?.[0] ?? "";
        return {
            uid: xmlAttr(driveTag, "uid"),
            path: xmlAttr(props, "path"),
            letter: xmlAttr(props, "letter").toUpperCase(),
            label: xmlAttr(props, "label"),
            filters: /<Filters>[\s\S]*?<\/Filters>/.exec(xml)?.[0] ?? "",
            xml,
        };
    });
}

export interface ResolvedPrincipal {
    name: string;
    kind: "user" | "group";
    sid: string;
}

// Any listed user or group matches ("OR"); userContext evaluates group
// membership for the logged-on user rather than the computer.
export function buildFiltersXml(principals: ResolvedPrincipal[], workgroup: string): string {
    const items = principals.map(p => {
        const name = xmlEscape(`${workgroup}\\${p.name}`);
        return p.kind === "group"
            ? `<FilterGroup bool="OR" not="0" name="${name}" sid="${p.sid}" userContext="1" primaryGroup="0" localGroup="0"/>`
            : `<FilterUser bool="OR" not="0" name="${name}" sid="${p.sid}"/>`;
    });
    return `<Filters>${items.join("")}</Filters>`;
}

export function buildDriveXml(d: { uid: string; changed: string; path: string; letter: string; label: string; filters: string }): string {
    const letter = d.letter.toUpperCase();
    return `<Drive clsid="${DRIVE_CLSID}" name="${letter}:" status="${letter}:" image="2" changed="${d.changed}" uid="${d.uid}" bypassErrors="1">` +
        `<Properties action="U" thisDrive="NOCHANGE" allDrives="NOCHANGE" userName="" path="${xmlEscape(d.path)}" ` +
        `label="${xmlEscape(d.label)}" persistent="0" useLetter="1" letter="${letter}"/>` +
        `${d.filters}</Drive>`;
}

export function buildDrivesXml(drives: string[]): string {
    return `<?xml version="1.0" encoding="utf-8"?>\r\n<Drives clsid="${DRIVES_CLSID}">${drives.join("")}</Drives>\r\n`;
}

// --- helpers ------------------------------------------------------------------

// crypto.randomUUID() needs a secure context; getRandomValues() does not.
function newGuid(): string {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
    return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

// RFC 4515: sAMAccountName may contain "(", ")" and "*"
function escapeLdapFilter(s: string): string {
    return s.replace(/[\\*()\0]/g, c => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function timestamp(): string {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// Written aside and renamed, so clients never read a half-written file. The
// new file takes the attributes of the one it replaces: its NT ACL (the
// security.NTACL xattr) and POSIX ACL, which a file written by root would
// lack. Returns false when there was nothing to take them from (a new file):
// the caller then resets the sysvol ACLs.
async function writeRootFile(path: string, content: string): Promise<boolean> {
    const tmp = `${path}.tmp`;
    await runAsRootWithInput(["tee", tmp], content);
    let attributesKept = true;
    try {
        await runAsRoot(["cp", "--attributes-only", "--preserve=mode,ownership,xattr", path, tmp]);
    } catch {
        attributesKept = false;
    }
    await runAsRoot(["mv", "-f", tmp, path]);
    return attributesKept;
}

// Resets the ACLs of every GPO in sysvol from their directory objects: slow
// on a large sysvol, so only for files written without an NT ACL.
async function resetSysvolAcls(): Promise<void> {
    await runAsRoot(["samba-tool", "ntacl", "sysvolreset"]);
}

function gptIni(version: number): string {
    return `[General]\r\nVersion=${version}\r\ndisplayName=${DRIVE_MAP_GPO_NAME}\r\n`;
}

async function gpoDir(guid: string): Promise<string> {
    const [sysvol, realm] = await Promise.all([getSysvolPath(), getRealm()]);
    return `${sysvol}/${realm.toLowerCase()}/Policies/${guid}`;
}

async function findGpo(): Promise<Gpo | null> {
    const baseDN = await getBaseDN();
    const raw = await runAsRoot([
        "ldbsearch", "-H", SAM_LDB, "-b", `CN=Policies,CN=System,${baseDN}`, "-s", "one",
        `(&(objectClass=groupPolicyContainer)(displayName=${escapeLdapFilter(DRIVE_MAP_GPO_NAME)}))`,
        "cn", "versionNumber",
    ]);
    const fields = parseLdapMulti(raw).find(f => firstValue(f, "cn") !== "");
    if (!fields) return null;
    return {
        guid: firstValue(fields, "cn"),
        dn: firstValue(fields, "dn"),
        version: parseInt(firstValue(fields, "versionNumber"), 10) || 0,
    };
}

// Same objects "samba-tool gpo create" writes. The domain-root link is added
// separately, by ensureGpoLinked().
async function createGpo(): Promise<Gpo> {
    const [baseDN, realm] = await Promise.all([getBaseDN(), getRealm()]);
    const domain = realm.toLowerCase();
    const guid = newGuid();
    const dn = `CN=${guid},CN=Policies,CN=System,${baseDN}`;

    const dir = await gpoDir(guid);
    await runAsRoot(["mkdir", "-p", `${dir}/MACHINE`, `${dir}/USER/Preferences/Drives`]);
    await writeRootFile(`${dir}/GPT.INI`, gptIni(0));
    await writeRootFile(`${dir}/USER/Preferences/Drives/Drives.xml`, buildDrivesXml([]));

    await runAsRootWithInput(["ldbadd", "-H", SAM_LDB], [
        `dn: ${dn}`,
        "objectClass: top",
        "objectClass: container",
        "objectClass: groupPolicyContainer",
        `displayName: ${DRIVE_MAP_GPO_NAME}`,
        `gPCFileSysPath: \\\\${domain}\\sysvol\\${domain}\\Policies\\${guid}`,
        "flags: 0",
        "versionNumber: 0",
        "gPCFunctionalityVersion: 2",
        "showInAdvancedViewOnly: TRUE",
        `gPCUserExtensionNames: ${USER_EXTENSION_NAMES}`,
        "",
        `dn: CN=User,${dn}`,
        "objectClass: top",
        "objectClass: container",
        "showInAdvancedViewOnly: TRUE",
        "",
        `dn: CN=Machine,${dn}`,
        "objectClass: top",
        "objectClass: container",
        "showInAdvancedViewOnly: TRUE",
        "",
    ].join("\n"));

    return { guid, dn, version: 0 };
}

// Checked on every write rather than only after creation: if linking failed
// once, the GPO would otherwise exist unlinked forever and never apply.
async function ensureGpoLinked(gpo: Gpo): Promise<void> {
    const baseDN = await getBaseDN();
    const linkRaw = await runAsRoot(["ldbsearch", "-H", SAM_LDB, "-s", "base", "-b", baseDN, "gPLink"]);
    const oldLink = parseLdapMulti(linkRaw).map(f => firstValue(f, "gPLink")).find(Boolean) ?? "";
    if (oldLink.toLowerCase().includes(`[ldap://${gpo.dn.toLowerCase()};`)) return;
    await runAsRootWithInput(["ldbmodify", "-H", SAM_LDB], [
        `dn: ${baseDN}`,
        "changetype: modify",
        "replace: gPLink",
        `gPLink: ${oldLink}[LDAP://${gpo.dn};0]`,
        "-",
        "",
    ].join("\n"));
}

async function readDrives(gpo: Gpo): Promise<string> {
    try {
        return await runAsRoot(["cat", `${await gpoDir(gpo.guid)}/USER/Preferences/Drives/Drives.xml`]);
    } catch {
        return "";
    }
}

async function resolvePrincipals(access: ShareAccess[]): Promise<ResolvedPrincipal[]> {
    const baseDN = await getBaseDN();
    const filter = `(|${access.map(a => `(sAMAccountName=${escapeLdapFilter(a.name)})`).join("")})`;
    const raw = await runAsRoot(["ldbsearch", "-H", SAM_LDB, "-b", baseDN, filter, "sAMAccountName", "objectSid"]);
    const sids = new Map(parseLdapMulti(raw)
        .filter(f => firstValue(f, "sAMAccountName") !== "")
        .map(f => [firstValue(f, "sAMAccountName").toLowerCase(), firstValue(f, "objectSid")]));
    return access.map(a => {
        const sid = sids.get(a.name.toLowerCase());
        if (!sid) throw new Error(`Unknown user or group: ${a.name}`);
        return { name: a.name, kind: a.kind, sid };
    });
}

// --- public API ---------------------------------------------------------------

// Mapped shares by lowercase share name; empty until the GPO is first created.
export async function listDriveMappings(): Promise<Map<string, DriveMapping>> {
    let raw = cache.get(DRIVES_KEY, 30_000);
    if (raw === null) {
        const gpo = await findGpo();
        raw = gpo ? await readDrives(gpo) : "";
        cache.set(DRIVES_KEY, raw);
    }
    const prefix = `\\\\${(await getDCNetbiosName()).toLowerCase()}\\`;
    const result = new Map<string, DriveMapping>();
    for (const d of parseDrivesXml(raw)) {
        const path = d.path.toLowerCase();
        if (path.startsWith(prefix)) result.set(path.slice(prefix.length), { letter: d.letter, label: d.label });
    }
    return result;
}

// Serializes writers: each one reads, edits and rewrites Drives.xml and
// bumps the GPO version, so concurrent calls would lose updates.
let lock: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
}

// Maps shareName for the given users/groups, or removes its mapping (null).
export function setDriveMapping(shareName: string, access: ShareAccess[], mapping: DriveMapping | null): Promise<void> {
    return serialized(async () => {
        if (mapping && !DRIVE_LETTERS.includes(mapping.letter.toUpperCase())) {
            throw new Error(`Invalid drive letter: ${mapping.letter}`);
        }
        let gpo = await findGpo();
        if (!gpo && !mapping) return;

        const netbiosName = await getDCNetbiosName();
        const path = `\\\\${netbiosName}\\${shareName}`;
        const entries = gpo ? parseDrivesXml(await readDrives(gpo)) : [];
        const current = entries.find(e => e.path.toLowerCase() === path.toLowerCase());
        const others = entries.filter(e => e !== current);

        let entry: string | null = null;
        if (mapping) {
            const letter = mapping.letter.toUpperCase();
            const clash = others.find(e => e.letter === letter);
            if (clash) throw new Error(`Drive letter ${letter}: is already used by ${clash.path}`);
            const label = mapping.label || shareName;
            const filters = buildFiltersXml(await resolvePrincipals(access), await getWorkgroup());
            if (current && current.letter === letter && current.label === label && current.filters === filters) return;
            entry = buildDriveXml({ uid: current?.uid || newGuid(), changed: timestamp(), path, letter, label, filters });
        } else if (!current) {
            return;
        }

        let aclsComplete = true;
        if (!gpo) {
            gpo = await createGpo();
            aclsComplete = false;
        }
        try {
            await ensureGpoLinked(gpo);
            const dir = await gpoDir(gpo.guid);
            const version = gpo.version + USER_VERSION_STEP;
            const drivesKept = await writeRootFile(`${dir}/USER/Preferences/Drives/Drives.xml`,
                buildDrivesXml([...others.map(e => e.xml), ...(entry ? [entry] : [])]));
            const gptKept = await writeRootFile(`${dir}/GPT.INI`, gptIni(version));
            aclsComplete = aclsComplete && drivesKept && gptKept;
            await runAsRootWithInput(["ldbmodify", "-H", SAM_LDB], [
                `dn: ${gpo.dn}`,
                "changetype: modify",
                "replace: versionNumber",
                `versionNumber: ${version}`,
                "-",
                "",
            ].join("\n"));
            // A file with no NT ACL breaks "samba-tool ntacl sysvolcheck" and
            // the ACLs clients expect.
            if (!aclsComplete) await resetSysvolAcls();
        } finally {
            cache.invalidate(k => k === DRIVES_KEY);
        }
    });
}
