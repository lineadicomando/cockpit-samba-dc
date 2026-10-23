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
