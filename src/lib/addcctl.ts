import { runAsRootWithInput } from "./exec.ts";
import type { AddcctlInputs } from "./addcctl-schema.ts";

export type AddcctlOperation = keyof AddcctlInputs;

// addcctl, the core on the DC (docs/architecture.md): one operation per
// call, JSON in on stdin and JSON out on stdout, the input typed from the
// operation's JSON Schema (addcctl-schema.ts, generated). A failure rejects
// with the core's message, which it writes to stderr (English, shown as it is).
// The result is the caller's to type: `(await addcctl(...)) as {...}`.
// check: addcctl --check, a mutation that only reports what it would do.
export async function addcctl<K extends AddcctlOperation>(
    operation: K, input: AddcctlInputs[K], options: { check?: boolean } = {},
): Promise<unknown> {
    const args = ["addcctl", ...operation.split(" "), ...(options.check ? ["--check"] : [])];
    const out = await runAsRootWithInput(args, JSON.stringify(input));
    try {
        return JSON.parse(out) as unknown;
    } catch {
        throw new Error(`addcctl ${operation} returned no JSON: ${out.slice(0, 200)}`);
    }
}
