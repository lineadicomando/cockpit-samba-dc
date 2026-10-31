import cockpit from "cockpit";
import type { SetupCheck } from "./types.ts";

// The text of a prerequisite of a new domain (domain setup-check) in the
// user's language, from its code and params; the core's English message and
// fix for a code this page does not know.

type T = (key: string, options?: Record<string, unknown>) => string;

// cockpit-networkmanager's page, listed by the shell only when installed and
// NetworkManager runs (../manifests.js fills cockpit.manifests)
export function networkingPageAvailable(): boolean {
    return Boolean(cockpit.manifests?.network);
}

interface BusyProgram {
    program: string;
    ports: { port: number; service: string }[];
}

function str(v: unknown): string {
    if (Array.isArray(v)) return v.join(", ");
    return v === undefined || v === null ? "" : String(v);
}

function gib(v: unknown): string {
    return new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
        .format(Number(v));
}

export function setupCheckText(t: T, check: SetupCheck, networkingPage: boolean): { message: string; fix?: string } {
    const p = check.params ?? {};
    const address = { address: str(p.address), prefix: str(p.prefix_length), interface: str(p.interface) };
    const staticFix = networkingPage
        ? t("Set a static address in the Networking page, then check again.")
        : t("Set a static address in /etc/network/interfaces, then check again.");
    const hostNameFix = t("Change it (hostnamectl set-hostname NAME, or Cockpit's Overview page), then check again.");
    switch (check.code) {
    case "smb_conf.leftovers":
        return { message: t("A provisioning left files behind (/var/lib/samba/private/*.ldb, sysvol) with no sam.ldb."),
            fix: t("Remove them by hand if they are not needed, then check again.") };
    case "smb_conf.missing":
        return { message: t("No smb.conf: the provisioning writes it.") };
    case "smb_conf.role":
        return { message: t("smb.conf sets \"server role = {{role}}\": Samba is set up for something else on this host.",
            { role: str(p.role) }),
        fix: t("Move /etc/samba/smb.conf aside by hand if it is not needed, then check again.") };
    case "smb_conf.shares":
        return { message: t("smb.conf has shares of its own ({{shares}}): they would stop being served.",
            { shares: str(p.shares) }),
        fix: t("Move /etc/samba/smb.conf aside by hand if they are not needed, then check again.") };
    case "smb_conf.debian":
        return { message: t("Debian's smb.conf of a standalone server: kept as smb.conf.dist, smbd and nmbd stopped.") };
    case "address.no_route":
        return { message: t("No default route: the host has no network."),
            fix: networkingPage
                ? t("Set a static address and a gateway in the Networking page, then check again.")
                : t("Set a static address and a gateway in /etc/network/interfaces, then check again.") };
    case "address.none":
        return { message: t("No IPv4 address on {{interface}}, the interface of the default route.", address),
            fix: staticFix };
    case "address.dhcp":
        return { message: t("{{address}}/{{prefix}} on {{interface}} comes from DHCP: a domain controller needs a static address.",
            address),
        fix: staticFix };
    case "address.static":
        return { message: t("Static address {{address}}/{{prefix}} on {{interface}}.", address) };
    case "host_name.localhost":
        return { message: t("The host name is \"{{name}}\": a domain controller needs a name of its own.",
            { name: str(p.name) }), fix: hostNameFix };
    case "host_name.too_long":
        return { message: t("The host name \"{{name}}\" is longer than 15 characters, the limit of a NetBIOS name.",
            { name: str(p.name) }), fix: hostNameFix };
    case "host_name.characters":
        return { message: t("The host name \"{{name}}\" must be letters, digits and hyphens, not only digits, and must not start or end with a hyphen.",
            { name: str(p.name) }), fix: hostNameFix };
    case "host_name.ok":
        return { message: t("Host name \"{{name}}\".", { name: str(p.name) }) };
    case "ports.busy": {
        const busy = (Array.isArray(p.busy) ? p.busy : []) as BusyProgram[];
        const list = busy.map(b => t("{{program}} on {{ports}}", {
            program: b.program, ports: b.ports.map(n => `${n.port} (${n.service})`).join(", "),
        })).join("; ");
        return { message: t("Ports a domain controller needs are in use: {{list}}.", { list }),
            fix: t("Stop and disable those services (for example: systemctl disable --now dnsmasq), then check again.") };
    }
    case "ports.stopped":
        return { message: t("The ports a domain controller needs are free once {{programs}} are stopped, which the provisioning does.",
            { programs: str(p.stopped) }) };
    case "ports.free":
        return { message: t("The ports a domain controller needs are free.") };
    case "time.unsynchronized":
        return { message: t("The clock is not synchronized: Kerberos refuses clients whose clock differs by more than 5 minutes."),
            fix: t("Install chrony, or enable systemd-timesyncd.") };
    case "time.no_chrony":
        return { message: t("The clock is synchronized, but without chrony the domain controller gives no time to the domain's Windows computers."),
            fix: t("Install chrony (apt install chrony) before the provisioning, which sets it up.") };
    case "time.chrony":
        return { message: t("The clock is synchronized by chrony, which the provisioning sets up to serve the domain's computers.") };
    case "disk.full":
        return { message: t("{{free}} GiB free under /var/lib/samba.", { free: gib(p.free_gib) }),
            fix: t("Free some space, then check again.") };
    case "disk.low":
        return { message: t("{{free}} GiB free under /var/lib/samba: the directory and the shared folders will need more.",
            { free: gib(p.free_gib) }) };
    case "disk.ok":
        return { message: t("{{free}} GiB free under /var/lib/samba.", { free: gib(p.free_gib) }) };
    default:
        return { message: check.message, fix: check.fix };
    }
}
