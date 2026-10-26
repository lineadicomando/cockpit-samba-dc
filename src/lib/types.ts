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
    // DN of the OU or container it is in, relative to the domain (Ou.dn)
    container: string;
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
    container: string;
}

export interface Computer {
    name: string;
    dn: string;
    id: string;
    os: string;
    lastLogon: string;
    container: string;
    isDomainController: boolean;
}

// An organizational unit, or one of the domain's default containers
// (CN=Users, CN=Computers, OU=Domain Controllers): those are built in, never
// renamed, moved or deleted.
export interface Ou {
    // Relative to the domain: "OU=Students,OU=School"; "" is the domain itself
    dn: string;
    name: string;
    description: string;
    parent: string;
    // "School/Students", from the domain down
    path: string;
    isOu: boolean;
    builtIn: boolean;
    defaultFor: "users" | "computers" | "domain_controllers" | null;
}

// null for an age or an interval: never (no maximum age, locked until an
// administrator unlocks the account, a count of failed logons that never
// starts again)
export interface PasswordPolicy {
    complexityRequired: boolean;
    minLength: number;
    historyLength: number;
    minAgeDays: number;
    maxAgeDays: number | null;
    lockoutThreshold: number;
    lockoutDurationMinutes: number | null;
    lockoutWindowMinutes: number | null;
}

// A fine-grained password policy (PSO): it applies to the users and groups
// listed, a group's to its members; the lowest precedence wins
export interface Pso {
    name: string;
    precedence: number;
    policy: PasswordPolicy;
    appliesTo: string[];
}

// The policy that applies to a user: a PSO's, or the domain's (pso null)
export interface EffectivePolicy {
    pso: string | null;
    policy: PasswordPolicy;
}

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

export interface DomainController {
    name: string;
    dnsName: string;
    site: string | null;
}

export interface FsmoRole {
    // schema, naming, pdc, rid, infrastructure, domaindns, forestdns
    role: string;
    owner: string | null;
}

export interface DomainInfo {
    realm: string;
    dnsDomain: string;
    netbiosDomain: string;
    server: string;
    sambaVersion: string;
    domainLevel: string | null;
    forestLevel: string | null;
    domainControllers: DomainController[];
    fsmo: FsmoRole[];
    // Output of samba-tool processes; null when it failed (Samba not running)
    processes: string | null;
}

export type HealthCheckName = "dbcheck" | "sysvolcheck" | "testparm";

export interface HealthCheck {
    name: HealthCheckName;
    command: string;
    ok: boolean;
    exitCode: number;
    output: string;
}

export interface DomainBackup {
    name: string;
    path: string;
    size: number;
    // Unix milliseconds
    created: number;
}
