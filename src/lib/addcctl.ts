import { runAsRootWithInput } from "./exec.ts";

// addcctl, the core on the DC (docs/architecture.md): one operation per
// call, JSON in on stdin and JSON out on stdout. A failure rejects with the
// core's message, which it writes to stderr (English, shown as it is).
export async function addcctl<T>(object: string, action: string, input: object = {}): Promise<T> {
    const out = await runAsRootWithInput(["addcctl", object, action], JSON.stringify(input));
    try {
        return JSON.parse(out) as T;
    } catch {
        throw new Error(`addcctl ${object} ${action} returned no JSON: ${out.slice(0, 200)}`);
    }
}
