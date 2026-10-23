export interface User {
    username: string;
    fullName: string;
    givenName: string;
    surname: string;
    email: string;
    id: string;
    status: "Active" | "Disabled" | "Unknown";
    lastActivity: string;
    groups: string[];
    primaryGroup: string;
    isAdmin: boolean;
    isProtected: boolean;
    isStatusLocked: boolean;
    homeDrive: string;
    homeDirectory: string;
    // Locked out after too many failed logons
    lockedOut: boolean;
    // Unix milliseconds, null if the account never expires
    accountExpires: number | null;
    expired: boolean;
}

export interface Group {
    name: string;
    description: string;
    id: string;
    memberCount: number;
    members: string[];
    isCriticalSystemObject: boolean;
    isProtected: boolean;
    groupType: "Security" | "Distribution";
}

export interface Computer {
    name: string;
    dn: string;
    id: string;
    os: string;
    lastLogon: string;
}

export interface PasswordPolicy {
    complexityRequired: boolean;
    minLength: number;
    historyLength: number;
}

export type LdapFields = Record<string, string | string[]>;

export type ShareAccessLevel = "read" | "write";

// A user or group granted access to a shared folder, by sAMAccountName
// (without the "DOMAIN\" prefix).
export interface ShareAccess {
    name: string;
    kind: "user" | "group";
    level: ShareAccessLevel;
}

// Network drive mapped at logon for the users and groups with access
export interface DriveMapping {
    letter: string;
    label: string;
}

export interface SharedFolder {
    name: string;
    path: string;
    comment: string;
    browseable: boolean;
    access: ShareAccess[];
    automount: DriveMapping | null;
}
