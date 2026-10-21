// node --import: maps the bare "cockpit" module to cockpit-ssh.ts.
import { register } from "node:module";

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (specifier === "cockpit") return { url: ${JSON.stringify(new URL("./cockpit-ssh.ts", import.meta.url).href)}, shortCircuit: true };
    return next(specifier, context);
}`), import.meta.url);
