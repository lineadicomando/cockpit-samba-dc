import type { PasswordPolicy } from "./types.ts";

// Characters AD forbids in sAMAccountName: " / \ [ ] : ; | = , + * ? < >
const SAM_INVALID_CHARS = /["/\\[\]:;|=,+*?<>]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/;

// sAMAccountName is capped at 20 characters for users (and computers);
// the schema allows up to 256 for groups.
const USERNAME_MAX_LENGTH = 20;
const GROUP_NAME_MAX_LENGTH = 256;

export type NameViolation =
    | "empty"
    | "tooLong"
    | "invalidChars"
    | "leadingDash"
    | "trailingPeriod";

// "leadingDash" also protects against the name being parsed as a CLI option.
function validateAccountName(name: string, maxLength: number): NameViolation | null {
    if (!name) return "empty";
    if (name.length > maxLength) return "tooLong";
    if (SAM_INVALID_CHARS.test(name) || CONTROL_CHARS.test(name)) return "invalidChars";
    if (name.startsWith("-")) return "leadingDash";
    if (name.endsWith(".")) return "trailingPeriod";
    return null;
}

// Validates a candidate user sAMAccountName before it reaches samba-tool.
export function validateUsername(name: string): NameViolation | null {
    return validateAccountName(name, USERNAME_MAX_LENGTH);
}

// Validates a candidate group sAMAccountName before it reaches samba-tool.
export function validateGroupName(name: string): NameViolation | null {
    return validateAccountName(name, GROUP_NAME_MAX_LENGTH);
}

// Validates an existing account name passed as a group member (user, computer
// ending in "$", or nested group), so the widest length limit applies.
export function validateMemberName(name: string): NameViolation | null {
    return validateAccountName(name, GROUP_NAME_MAX_LENGTH);
}

// Maps a violation to a translated message. Uses literal t() calls so
// i18next-parser can extract the keys statically.
export function usernameViolationMessage(t: (key: string) => string, violation: NameViolation): string {
    switch (violation) {
        case "empty":          return t("Username is required.");
        case "tooLong":        return t("Username cannot exceed 20 characters.");
        case "invalidChars":   return t("Username contains invalid characters: \" / \\ [ ] : ; | = , + * ? < >");
        case "leadingDash":    return t("Username cannot start with a dash.");
        case "trailingPeriod": return t("Username cannot end with a period.");
    }
}

export function groupNameViolationMessage(t: (key: string) => string, violation: NameViolation): string {
    switch (violation) {
        case "empty":          return t("Group name is required.");
        case "tooLong":        return t("Group name cannot exceed 256 characters.");
        case "invalidChars":   return t("Group name contains invalid characters: \" / \\ [ ] : ; | = , + * ? < >");
        case "leadingDash":    return t("Group name cannot start with a dash.");
        case "trailingPeriod": return t("Group name cannot end with a period.");
    }
}

export type ComputerNameViolation = "empty" | "tooLong" | "invalidChars" | "leadingDash" | "onlyDigits";

// A computer's name is its NetBIOS name and the first label of its DNS name:
// up to 15 letters, digits and hyphens (addcctl's computer create checks the same)
export function validateComputerName(name: string): ComputerNameViolation | null {
    if (!name) return "empty";
    if (name.length > 15) return "tooLong";
    if (!/^[A-Za-z0-9-]+$/.test(name)) return "invalidChars";
    if (name.startsWith("-")) return "leadingDash";
    if (/^[0-9]+$/.test(name)) return "onlyDigits";
    return null;
}

export function computerNameViolationMessage(t: (key: string) => string, violation: ComputerNameViolation): string {
    switch (violation) {
        case "empty":        return t("Computer name is required.");
        case "tooLong":      return t("Computer name cannot exceed 15 characters.");
        case "invalidChars": return t("Computer name can contain only letters, digits and hyphens.");
        case "leadingDash":  return t("Computer name cannot start with a dash.");
        case "onlyDigits":   return t("Computer name cannot be made of digits only.");
    }
}

export type EmailViolation = "invalid";

// Empty is allowed (no address); otherwise one "@" with text on both sides
// and no spaces. The directory stores what it is given: this only catches typos.
export function validateEmail(email: string): EmailViolation | null {
    if (!email) return null;
    return /^[^\s@]+@[^\s@]+$/.test(email) ? null : "invalid";
}

export function emailViolationMessage(t: (key: string) => string, violation: EmailViolation): string {
    switch (violation) {
        case "invalid": return t("Enter an e-mail address such as name@example.org.");
    }
}

// Characters not allowed in share names: the smb.conf section syntax and
// Windows path rules forbid most, and "%" would trigger smb.conf variable
// substitution in the path, which is derived from the name.
const SHARE_INVALID_CHARS = /["/\\[\]:;|=,+*?<>%]/;
const SHARE_NAME_MAX_LENGTH = 80;
// Built-in smb.conf sections, the DC shares, the module's home share, and
// names that would resolve to a parent directory in the derived path.
const RESERVED_SHARE_NAMES = new Set([
    "global", "homes", "printers", "print$", "ipc$", "admin$",
    "sysvol", "netlogon", "home", ".", "..",
]);

export type ShareNameViolation =
    | "empty"
    | "tooLong"
    | "invalidChars"
    | "surroundingSpaces"
    | "leadingDash"
    | "reserved";

// Share names are case-insensitive, hence the lowercase reserved-name lookup.
export function validateShareName(name: string): ShareNameViolation | null {
    if (!name) return "empty";
    if (name.length > SHARE_NAME_MAX_LENGTH) return "tooLong";
    if (SHARE_INVALID_CHARS.test(name) || CONTROL_CHARS.test(name)) return "invalidChars";
    if (name !== name.trim()) return "surroundingSpaces";
    if (name.startsWith("-")) return "leadingDash";
    if (RESERVED_SHARE_NAMES.has(name.toLowerCase())) return "reserved";
    return null;
}

export function shareNameViolationMessage(t: (key: string) => string, violation: ShareNameViolation): string {
    switch (violation) {
        case "empty":             return t("Name is required.");
        case "tooLong":           return t("Name cannot exceed 80 characters.");
        case "invalidChars":      return t("Name contains invalid characters: \" / \\ [ ] : ; | = , + * ? < > %");
        case "surroundingSpaces": return t("Name cannot start or end with a space.");
        case "leadingDash":       return t("Name cannot start with a dash.");
        case "reserved":          return t("This name is reserved by Samba.");
    }
}

export type ExpiryDateViolation = "empty" | "invalid";

const LAST_EXPIRY_YEAR = 9999;

// Parses an expiry day as written by the date picker ("YYYY-MM-DD") into the
// instant the account expires: the start of the following day, local time, so
// the account can still be used on the day chosen (as "End of" in Windows'
// Active Directory Users and Computers). Null when the value is not a date.
export function expiryInstantFromDay(day: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
    if (!m) return null;
    const [year, month, date] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (year < 1970 || year > LAST_EXPIRY_YEAR || month < 1 || month > 12) return null;
    const instant = new Date(year, month - 1, date + 1);
    // Rejects days that roll over into the next month, such as 2026-02-30
    const lastDay = new Date(year, month - 1, date);
    if (lastDay.getMonth() !== month - 1 || lastDay.getDate() !== date) return null;
    return instant;
}

// The day an expiry instant falls at the end of, in the picker's format.
export function dayFromExpiryInstant(unixMs: number): string {
    const d = new Date(unixMs - 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function validateExpiryDay(day: string): ExpiryDateViolation | null {
    if (!day.trim()) return "empty";
    return expiryInstantFromDay(day) ? null : "invalid";
}

export function expiryDateViolationMessage(t: (key: string) => string, violation: ExpiryDateViolation): string {
    switch (violation) {
        case "empty":   return t("Choose the last day the account can be used.");
        case "invalid": return t("Enter a date as YYYY-MM-DD.");
    }
}

export type PasswordPolicyViolation =
    | "minLength"
    | "historyLength"
    | "minAge"
    | "maxAge"
    | "ages"
    | "lockoutThreshold"
    | "lockoutDuration"
    | "lockoutWindow"
    | "windowNever"
    | "windowTooLong";

function inRange(value: number, low: number, high: number): boolean {
    return Number.isInteger(value) && value >= low && value <= high;
}

// The ranges and checks of addcctl's domain set-password-policy (those of
// samba-tool domain passwordsettings set, plus the lockout window within the
// lockout duration). A PSO allows longer passwords and histories.
export function validatePasswordPolicy(p: PasswordPolicy, pso = false): PasswordPolicyViolation | null {
    if (!inRange(p.minLength, 0, pso ? 255 : 14)) return "minLength";
    if (!inRange(p.historyLength, 0, pso ? 1024 : 24)) return "historyLength";
    if (!inRange(p.minAgeDays, 0, 998)) return "minAge";
    if (p.maxAgeDays !== null && !inRange(p.maxAgeDays, 1, 999)) return "maxAge";
    if (p.maxAgeDays !== null && p.minAgeDays >= p.maxAgeDays) return "ages";
    if (!inRange(p.lockoutThreshold, 0, 999)) return "lockoutThreshold";
    if (p.lockoutDurationMinutes !== null && !inRange(p.lockoutDurationMinutes, 1, 99999)) return "lockoutDuration";
    if (p.lockoutWindowMinutes !== null && !inRange(p.lockoutWindowMinutes, 1, 99999)) return "lockoutWindow";
    if (p.lockoutDurationMinutes !== null) {
        if (p.lockoutWindowMinutes === null) return "windowNever";
        if (p.lockoutWindowMinutes > p.lockoutDurationMinutes) return "windowTooLong";
    }
    return null;
}

export function passwordPolicyViolationMessage(t: (key: string) => string, violation: PasswordPolicyViolation, pso = false): string {
    switch (violation) {
        case "minLength":        return pso
            ? t("The minimum length must be a whole number from 0 to 255.")
            : t("The minimum length must be a whole number from 0 to 14.");
        case "historyLength":    return pso
            ? t("The password history must be a whole number from 0 to 1024.")
            : t("The password history must be a whole number from 0 to 24.");
        case "minAge":           return t("The minimum age must be a whole number of days from 0 to 998.");
        case "maxAge":           return t("The maximum age must be a whole number of days from 1 to 999.");
        case "ages":             return t("The maximum age must be greater than the minimum age.");
        case "lockoutThreshold": return t("The lockout threshold must be a whole number from 0 to 999.");
        case "lockoutDuration":  return t("The lockout duration must be a whole number of minutes from 1 to 99999.");
        case "lockoutWindow":    return t("The reset time must be a whole number of minutes from 1 to 99999.");
        case "windowNever":      return t("The count of failed logons must be reset within the lockout duration.");
        case "windowTooLong":    return t("The reset time cannot be longer than the lockout duration.");
    }
}

export type PsoViolation = "empty" | "tooLong" | "surroundingSpaces" | "invalidChars" | "precedence";

// A PSO's name is the CN of its object, escaped by addcctl: control
// characters and surrounding spaces are what it refuses
export function validatePso(name: string, precedence: number): PsoViolation | null {
    if (!name) return "empty";
    if (name.length > 64) return "tooLong";
    if (name !== name.trim()) return "surroundingSpaces";
    if (CONTROL_CHARS.test(name)) return "invalidChars";
    if (!inRange(precedence, 1, 2147483647)) return "precedence";
    return null;
}

export function psoViolationMessage(t: (key: string) => string, violation: PsoViolation): string {
    switch (violation) {
        case "empty":             return t("Name is required.");
        case "tooLong":           return t("Name cannot exceed 64 characters.");
        case "surroundingSpaces": return t("Name cannot start or end with a space.");
        case "invalidChars":      return t("Name contains invalid characters.");
        case "precedence":        return t("The precedence must be a whole number of 1 or more.");
    }
}

export type OuNameViolation = "empty" | "tooLong" | "surroundingSpaces" | "invalidChars";

// An OU's name is the value of its DN's first component, escaped by addcctl:
// what it refuses are control characters and surrounding spaces
export function validateOuName(name: string): OuNameViolation | null {
    if (!name) return "empty";
    if (name.length > 64) return "tooLong";
    if (name !== name.trim()) return "surroundingSpaces";
    if (CONTROL_CHARS.test(name)) return "invalidChars";
    return null;
}

export function ouNameViolationMessage(t: (key: string) => string, violation: OuNameViolation): string {
    switch (violation) {
        case "empty":             return t("Name is required.");
        case "tooLong":           return t("Name cannot exceed 64 characters.");
        case "surroundingSpaces": return t("Name cannot start or end with a space.");
        case "invalidChars":      return t("Name contains invalid characters.");
    }
}

// DNS names and values, checked as addcctl does (core/addcctl/dns.py)
const DNS_LABEL = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

function isHostName(value: string): boolean {
    return value.length > 0 && value.length <= 253 && value.split(".").every(l => DNS_LABEL.test(l));
}

export type DnsNameViolation = "empty" | "invalid";

// Relative to the zone: "@", labels, a first label "*"; a full name ending in a dot
export function validateDnsName(name: string): DnsNameViolation | null {
    if (!name) return "empty";
    if (name === "@" || name === "*") return null;
    const labels = name.replace(/\.$/, "").split(".");
    if (labels[0] === "*") labels.shift();
    return labels.join(".").length <= 253 && labels.every(l => DNS_LABEL.test(l)) ? null : "invalid";
}

export function dnsNameViolationMessage(t: (key: string) => string, violation: DnsNameViolation): string {
    switch (violation) {
        case "empty":   return t("Name is required.");
        case "invalid": return t("Use letters, digits, hyphens and underscores, in labels separated by dots; @ for the zone itself.");
    }
}

export type DnsValueViolation = "empty" | "ipv4" | "ipv6" | "host" | "mx" | "srv" | "text";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(value: string): boolean {
    if (!/^[0-9A-Fa-f:.]+$/.test(value) || value.split("::").length > 2) return false;
    try {
        return new URL(`http://[${value}]/`).hostname.length > 2;
    } catch {
        return false;
    }
}

const isNumber = (s: string | undefined) => s !== undefined && /^\d{1,5}$/.test(s) && Number(s) <= 65535;

export function validateDnsValue(type: string, raw: string): DnsValueViolation | null {
    const value = raw.trim();
    if (!value) return "empty";
    const parts = value.split(/\s+/);
    const host = (h: string | undefined) => h !== undefined && isHostName(h.replace(/\.$/, ""));
    switch (type) {
        case "A":     return IPV4.test(value) ? null : "ipv4";
        case "AAAA":  return isIpv6(value) ? null : "ipv6";
        case "CNAME":
        case "PTR":   return host(value) ? null : "host";
        case "MX":    return parts.length === 2 && host(parts[0]) && isNumber(parts[1]) ? null : "mx";
        case "SRV":   return parts.length === 4 && host(parts[0]) && parts.slice(1).every(isNumber) ? null : "srv";
        case "TXT":   return CONTROL_CHARS.test(raw) || new TextEncoder().encode(raw).length > 4096 ? "text" : null;
        default:      return null;
    }
}

export function dnsValueViolationMessage(t: (key: string) => string, violation: DnsValueViolation): string {
    switch (violation) {
        case "empty": return t("Value is required.");
        case "ipv4":  return t("Give an IPv4 address, such as 192.168.1.10.");
        case "ipv6":  return t("Give an IPv6 address, such as 2001:db8::10.");
        case "host":  return t("Give a host name, such as server.example.com.");
        case "mx":    return t("Give the mail server and its preference, such as \"mail.example.com 10\".");
        case "srv":   return t("Give target, port, priority and weight, such as \"sip.example.com 5060 0 100\".");
        case "text":  return t("Text of at most 4096 bytes, on one line.");
    }
}
