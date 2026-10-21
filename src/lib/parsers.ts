import type { LdapFields } from "./types.ts";

export function parseList(raw: string): string[] {
    return raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
}

// LDIF (RFC 2849) folds long lines: a line starting with a single space
// continues the previous one. samba-tool (python ldb) folds at 78 columns.
function unfoldLdif(raw: string): string[] {
    const lines: string[] = [];
    for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
        if (line.startsWith(" ") && lines.length > 0) {
            lines[lines.length - 1] += line.slice(1);
        } else {
            lines.push(line);
        }
    }
    return lines;
}

// ldb base64-encodes any value with non-ASCII bytes (e.g. "cn:: Tmljb2zDsg=="
// for "Nicolò"); values are UTF-8.
function decodeBase64Utf8(b64: string): string {
    try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return b64;
    }
}

export function parseLdapShow(raw: string): LdapFields {
    const fields: LdapFields = {};
    for (const line of unfoldLdif(raw)) {
        const singleSep = line.indexOf(": ");
        const doubleSep = line.indexOf(":: ");
        // Prefer :: over : when it appears first (base64-encoded values)
        const useDouble = doubleSep >= 0 && (singleSep < 0 || doubleSep < singleSep);
        const sep = useDouble ? doubleSep : singleSep;
        if (sep <= 0) continue;
        const key = line.slice(0, sep).trim();
        const rawVal = line.slice(sep + (useDouble ? 3 : 2)).trim();
        const val = useDouble ? decodeBase64Utf8(rawVal) : rawVal;
        const existing = fields[key];
        if (existing !== undefined) {
            fields[key] = Array.isArray(existing) ? [...existing, val] : [existing, val];
        } else {
            fields[key] = val;
        }
    }
    return fields;
}

export function parseLdapMulti(raw: string): LdapFields[] {
    return raw
        .split(/\n\s*\n/)
        .map(block => {
            const cleaned = block
                .split("\n")
                .filter(line => !line.trim().startsWith("#"))
                .join("\n")
                .trim();
            return cleaned;
        })
        .filter(block => block.length > 0)
        .map(block => parseLdapShow(block));
}

export function firstValue(fields: LdapFields, key: string): string {
    const val = fields[key];
    return Array.isArray(val) ? (val[0] ?? "") : (val ?? "");
}

export function listValue(fields: LdapFields, key: string): string[] {
    const val = fields[key];
    if (!val) return [];
    return Array.isArray(val) ? val : [val];
}

export function deriveUserStatus(uacRaw: string): "Active" | "Disabled" | "Unknown" {
    const uac = parseInt(uacRaw, 10);
    if (isNaN(uac)) return "Unknown";
    return (uac & 2) === 2 ? "Disabled" : "Active";
}

// Returns "" when there was never a logon; the UI renders the translated "Never".
export function deriveLastActivity(ticksRaw: string): string {
    // Windows FILETIME values exceed Number.MAX_SAFE_INTEGER; use BigInt to avoid precision loss.
    if (!ticksRaw || !/^\d+$/.test(ticksRaw)) return "";
    const ticks = BigInt(ticksRaw);
    if (ticks <= 0n) return "";
    const unixMs = Number(ticks / 10000n) - 11644473600000;
    if (unixMs <= 0) return "";
    const date = new Date(unixMs);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleDateString();
}

export function ridFromSid(sid: string): string {
    if (!sid) return "-";
    const parts = sid.split("-");
    return parts[parts.length - 1] ?? "-";
}

// Value of the first RDN ("CN=Rossi\\, Mario,OU=..." -> "Rossi, Mario"). This
// is the CN, which is not always the account name: prefer resolveDn() when
// the directory entries are at hand.
export function dnToName(dn: string): string {
    let end = 0;
    while (end < dn.length && dn[end] !== ",") end += dn[end] === "\\" ? 2 : 1;
    return unescapeDnValue(dn.slice(0, end).replace(/^\s*CN=/i, "")).trim();
}

// RFC 4514 escapes: "\\" followed by a special character, or by two hex
// digits encoding one UTF-8 byte.
function unescapeDnValue(value: string): string {
    if (!value.includes("\\")) return value;
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "\\" && /^[0-9a-fA-F]{2}$/.test(value.slice(i + 1, i + 3))) {
            bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            if (value[i] === "\\" && i + 1 < value.length) i++;
            const ch = String.fromCodePoint(value.codePointAt(i)!);
            bytes.push(...encoder.encode(ch));
            i += ch.length - 1;
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

// Lowercased DN -> sAMAccountName, from ldbsearch records.
export function buildDnNameMap(...recordSets: LdapFields[][]): Map<string, string> {
    const map = new Map<string, string>();
    for (const records of recordSets) {
        for (const f of records) {
            const dn = firstValue(f, "dn");
            const name = firstValue(f, "sAMAccountName");
            if (dn && name) map.set(dn.toLowerCase(), name);
        }
    }
    return map;
}

// Account name of a DN found in member/memberOf. User CNs are often the full
// name ("Mario Rossi" for mrossi), so the CN is only a fallback for entries
// outside the map (e.g. computers or foreign security principals).
export function resolveDn(dn: string, dnNames: Map<string, string>): string {
    return dnNames.get(dn.toLowerCase()) ?? dnToName(dn);
}

export function parseGroupType(raw: string): "Security" | "Distribution" {
    const val = parseInt(raw, 10);
    if (isNaN(val)) return "Security"; // default AD per nuovi gruppi
    return val < 0 ? "Security" : "Distribution";
}

export function parseDomainPasswordSettings(raw: string): { complexityRequired: boolean; minLength: number; historyLength: number } {
    let complexityRequired = true;
    let minLength = 8;
    let historyLength = 0;
    for (const line of raw.split("\n")) {
        const sep = line.indexOf(": ");
        if (sep <= 0) continue;
        const key = line.slice(0, sep).trim().toLowerCase();
        const val = line.slice(sep + 2).trim().toLowerCase();
        if (key === "password complexity") complexityRequired = val === "on";
        if (key === "minimum password length") {
            const n = parseInt(val, 10);
            // 0 is valid: it means the domain enforces no minimum
            if (isFinite(n) && n >= 0) minLength = n;
        }
        if (key === "password history length") {
            const n = parseInt(val, 10);
            if (isFinite(n) && n >= 0) historyLength = n;
        }
    }
    return { complexityRequired, minLength, historyLength };
}

// Parses "net conf list" / "net conf showshare" output: "[section]" headers
// followed by tab-indented "param = value" lines. Parameter names are
// lowercased (smb.conf treats them case-insensitively).
export function parseNetConf(raw: string): Map<string, Record<string, string>> {
    const sections = new Map<string, Record<string, string>>();
    let current: Record<string, string> | null = null;
    for (const line of raw.split("\n")) {
        const header = /^\s*\[(.+)\]\s*$/.exec(line);
        if (header) {
            current = {};
            sections.set(header[1], current);
            continue;
        }
        const sep = line.indexOf("=");
        if (!current || sep <= 0) continue;
        current[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1).trim();
    }
    return sections;
}

// Parses an smb.conf user list ("valid users", "read list", ...) such as
// `@"SCHOOL\Domain Users" "SCHOOL\mrossi" alice`. Entries are separated by
// spaces or commas unless quoted; a leading "@", "+" or "&" marks a group.
// The "DOMAIN\" prefix is stripped.
export function parseSmbUserList(value: string): { name: string; kind: "user" | "group" }[] {
    const entries: { name: string; kind: "user" | "group" }[] = [];
    const re = /([@+&]*)(?:"([^"]*)"|([^\s,"]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
        const raw = m[2] ?? m[3] ?? "";
        const name = raw.slice(raw.lastIndexOf("\\") + 1);
        if (name) entries.push({ name, kind: m[1] ? "group" : "user" });
    }
    return entries;
}

// smb.conf booleans: yes/no, true/false, 1/0 (case-insensitive).
export function parseSmbBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const v = value.trim().toLowerCase();
    if (["yes", "true", "1"].includes(v)) return true;
    if (["no", "false", "0"].includes(v)) return false;
    return fallback;
}
