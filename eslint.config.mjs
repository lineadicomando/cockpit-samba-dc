// SPDX-License-Identifier: LGPL-2.1-or-later
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
    { ignores: ["dist/", "build/", "debian/", "node_modules/", "ansible/", "core/", "src/lib/addcctl-schema.ts"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["src/**/*.{ts,tsx}"],
        languageOptions: { globals: globals.browser },
        plugins: { "react-hooks": reactHooks },
        rules: {
            "react-hooks/rules-of-hooks": "error",
            "react-hooks/exhaustive-deps": "warn",
        },
    },
    {
        files: ["test/**/*.{ts,mjs}", "scripts/**/*.mjs", "*.js", "*.mjs"],
        languageOptions: { globals: globals.node },
    },
);
