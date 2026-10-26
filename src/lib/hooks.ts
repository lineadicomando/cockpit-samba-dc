import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import cockpit from "cockpit";
import { getPasswordPolicy, getUserPasswordPolicy, listGroups, listOus, listUsers } from "./samba.ts";
import { generatePassword } from "./passwordUtils.ts";
import { forgetCachedData } from "./exec.ts";
import type { Ou, PasswordPolicy } from "./types.ts";

export function useCockpitLocation() {
  const [location, setLocation] = useState(cockpit.location);
  useEffect(() => {
    function sync() {
      setLocation(cockpit.location);
    }
    cockpit.addEventListener("locationchanged", sync);
    return () => cockpit.removeEventListener("locationchanged", sync);
  }, []);
  return location;
}

// ---------------------------------------------------------------------------
// useSingleLoad — single-phase load (all data arrives at once)
// ---------------------------------------------------------------------------
export function useSingleLoad<T>(
    load: () => Promise<T[]>,
): {
    items: T[];
    setItems: Dispatch<SetStateAction<T[]>>;
    loading: boolean;
    error: string | null;
    reload: () => void;
    refresh: () => void;
    reloadFresh: () => void;
} {
    const [items, setItems] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const loadGenRef = useRef(0);

    // silent: keep the current items on screen (no spinner) while refetching
    const load_ = useCallback(async (silent: boolean) => {
        const gen = ++loadGenRef.current;
        if (!silent) setLoading(true);
        setError(null);
        try {
            const result = await load();
            if (gen !== loadGenRef.current) return;
            setItems(result);
        } catch (err: unknown) {
            if (gen !== loadGenRef.current) return;
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (gen === loadGenRef.current) setLoading(false);
        }
    }, [load]);

    // Wrapped so they can be passed straight to onClick (the event must not
    // be taken as the "silent" flag).
    const reload = useCallback(() => { load_(false); }, [load_]);
    const refresh = useCallback(() => { load_(true); }, [load_]);
    // Refresh button: read the system again rather than the cache
    const reloadFresh = useCallback(() => { forgetCachedData(); load_(false); }, [load_]);

    useEffect(() => {
        reload();
    }, [reload]);

    return { items, setItems, loading, error, reload, refresh, reloadFresh };
}

// ---------------------------------------------------------------------------
// usePagination
// ---------------------------------------------------------------------------
export const PER_PAGE_OPTIONS = [10, 15, 20, 25, 30, 40, 50].map((v) => ({
  title: String(v),
  value: v,
}));

// resetKey: changes whenever the filters/sort change, to go back to page 1.
// Data updates alone (e.g. toggling a user on page 3) keep the current page,
// clamped to the last page if the list shrank.
export function usePagination<T>(items: T[], resetKey = "", defaultPerPage = 10) {
  const [requestedPage, setPage] = useState(1);
  const [perPage, setPerPage] = useState(defaultPerPage);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const page = Math.min(requestedPage, lastPage);

  const paginated = useMemo(
    () => items.slice((page - 1) * perPage, page * perPage),
    [items, page, perPage],
  );

  const onSetPage = useCallback((_evt: unknown, p: number) => setPage(p), []);
  const onPerPageSelect = useCallback((_evt: unknown, pp: number) => {
    setPerPage(pp);
    setPage(1);
  }, []);

  return { page, perPage, paginated, onSetPage, onPerPageSelect };
}

// ---------------------------------------------------------------------------
// useGroupNames — sorted names of all domain groups (for pickers and filters)
// ---------------------------------------------------------------------------
export function useGroupNames(enabled = true): {
    groupNames: string[];
    loading: boolean;
    error: string | null;
} {
    const [groupNames, setGroupNames] = useState<string[]>([]);
    const [loading, setLoading] = useState(enabled);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        listGroups()
            .then(rows => { if (!cancelled) setGroupNames(rows.map(r => r.name).sort((a, b) => a.localeCompare(b))); })
            .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [enabled]);

    return { groupNames, loading, error };
}

// ---------------------------------------------------------------------------
// useOus — the OUs and default containers, each after its parent (for
// pickers, filters and the container column); reload after a change
// ---------------------------------------------------------------------------
export function useOus(): {
    ous: Ou[];
    loading: boolean;
    error: string | null;
    reload: () => void;
} {
    const [ous, setOus] = useState<Ou[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setError(null);
        listOus()
            .then(rows => { if (!cancelled) setOus(rows); })
            .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [generation]);

    const reload = useCallback(() => setGeneration(g => g + 1), []);
    return { ous, loading, error, reload };
}

// ---------------------------------------------------------------------------
// usePrincipals — all domain users and groups (for the share access picker)
// ---------------------------------------------------------------------------
export interface Principal {
    name: string;
    kind: "user" | "group";
}

export function usePrincipals(): {
    principals: Principal[];
    loading: boolean;
    error: string | null;
} {
    const [principals, setPrincipals] = useState<Principal[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        Promise.all([listGroups(), listUsers()])
            .then(([groups, users]) => {
                if (cancelled) return;
                const byName = (a: Principal, b: Principal) => a.name.localeCompare(b.name);
                setPrincipals([
                    ...groups.map(g => ({ name: g.name, kind: "group" as const })).sort(byName),
                    ...users.map(u => ({ name: u.username, kind: "user" as const })).sort(byName),
                ]);
            })
            .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    return { principals, loading, error };
}

// ---------------------------------------------------------------------------
// usePasswordPolicy — the domain password policy, or with a username the one
// that applies to that user (a PSO's or the domain's: pso null); cached
// ---------------------------------------------------------------------------
export function usePasswordPolicy(username?: string): {
    policy: PasswordPolicy | null;
    pso: string | null;
    policyError: string | null;
} {
    const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
    const [pso, setPso] = useState<string | null>(null);
    const [policyError, setPolicyError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = username
            ? getUserPasswordPolicy(username)
            : getPasswordPolicy().then(p => ({ pso: null, policy: p }));
        load
            .then(e => { if (!cancelled) { setPolicy(e.policy); setPso(e.pso); } })
            .catch((e: unknown) => { if (!cancelled) setPolicyError(e instanceof Error ? e.message : String(e)); });
        return () => { cancelled = true; };
    }, [username]);

    return { policy, pso, policyError };
}

// ---------------------------------------------------------------------------
// usePasswordGenerator — generate + copy-to-clipboard + reveal lifecycle
// shared by AuthenticationSection and CreateUserModal
// ---------------------------------------------------------------------------
export type CopyState = "idle" | "copied" | "failed";

export function usePasswordGenerator(policy: PasswordPolicy | null): {
    generate: () => string | null;
    copyState: CopyState;
    revealCount: number;
} {
    const [copyState, setCopyState] = useState<CopyState>("idle");
    const [revealCount, setRevealCount] = useState(0);
    const resetTimerRef = useRef<number | undefined>(undefined);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            window.clearTimeout(resetTimerRef.current);
        };
    }, []);

    const generate = useCallback((): string | null => {
        if (!policy) return null;
        const pwd = generatePassword(policy);
        setRevealCount(c => c + 1);
        navigator.clipboard.writeText(pwd).then(() => {
            if (mountedRef.current) {
                setCopyState("copied");
                window.clearTimeout(resetTimerRef.current);
                resetTimerRef.current = window.setTimeout(() => {
                    if (mountedRef.current) setCopyState("idle");
                }, 3000);
            }
            // Auto-clear after 60 s for security — but only if the clipboard
            // still holds this password, so unrelated content is never wiped.
            // Intentionally not cancelled on unmount.
            // readText() is only attempted when read permission is already
            // granted: otherwise Chrome prompts and Firefox pops up a "Paste"
            // button a minute after the fact. Where the permission cannot be
            // queried (Firefox), the clipboard is left as is.
            window.setTimeout(() => {
                navigator.permissions.query({ name: "clipboard-read" as PermissionName })
                    .then(status => {
                        if (status.state !== "granted") return;
                        return navigator.clipboard.readText()
                            .then(current => (current === pwd ? navigator.clipboard.writeText("") : undefined));
                    })
                    .catch(() => { /* not queryable or read denied: do not blindly wipe */ });
            }, 60_000);
        }).catch(() => {
            if (mountedRef.current) setCopyState("failed");
        });
        return pwd;
    }, [policy]);

    return { generate, copyState, revealCount };
}
