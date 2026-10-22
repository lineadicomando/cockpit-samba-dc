// Set by build.js from the git tag (see scripts/version.mjs).
declare const __APP_VERSION__: string | undefined;

export const VERSION: string =
    typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
