declare module "cockpit" {
    interface CockpitLocation {
        readonly path: string[];
        readonly options: Record<string, string>;
        go(path: string | string[], options?: Record<string, string>): void;
    }

    interface CockpitSpawnOptions {
        superuser?: "require" | "try";
        err?: "message" | "out" | "ignore";
        environ?: string[];
    }

    interface SpawnProcess extends Promise<string> {
        input(data: string, stream?: boolean): SpawnProcess;
    }

    interface DBusProxy {
        readonly valid: boolean;
        // Properties of the interface, e.g. Current of cockpit.Superuser
        readonly [property: string]: unknown;
        wait(callback?: () => void): Promise<void>;
        addEventListener(event: "changed", handler: () => void): void;
        removeEventListener(event: "changed", handler: () => void): void;
    }

    interface DBusClient {
        proxy(iface: string, path: string): DBusProxy;
        close(): void;
    }

    interface Cockpit {
        // The session's internal bus (bus: "internal"), as Cockpit's own pages use it
        dbus(name: null, options: { bus: "internal" }): DBusClient;
        location: CockpitLocation;
        spawn(args: string[], options?: CockpitSpawnOptions): SpawnProcess;
        // Another page of the shell, e.g. "/network"
        jump(path: string, host?: string): void;
        // The shell's packages on this host, by name (filled by ../manifests.js)
        manifests: Record<string, unknown>;
        addEventListener(event: "locationchanged", handler: () => void): void;
        removeEventListener(event: "locationchanged", handler: () => void): void;
    }

    const cockpit: Cockpit;
    export default cockpit;
}
