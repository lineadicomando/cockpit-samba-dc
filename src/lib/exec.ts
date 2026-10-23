import cockpit from "cockpit";
import { createCache } from "./cache.ts";

// Shared by samba.ts and shares.ts, so a mutation in one can invalidate the
// entries cached by the other.
export const cache = createCache();

// For the Refresh buttons: changes made outside the module (a lockout after
// failed logons, another administrator's edits) show up only after the cache
// entries expire.
export function forgetCachedData(): void {
    cache.clear();
}

// Where addcctl creates the shared folders (shown in the share dialog)
export const SHARES_DIR = "/srv/samba/shares";

// Defense in depth for names reaching addcctl: a leading "-" would be read as
// an option by the tools it passes them to. addcctl checks them too.
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
