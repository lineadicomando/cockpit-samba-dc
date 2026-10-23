import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generate, tsType, typeName } from "../scripts/addcctl-types.mjs";

describe("addcctl-types", () => {
    it("names a type after its operation", () => {
        assert.equal(typeName("share rename-principal"), "ShareRenamePrincipalInput");
    });

    it("turns the schema subset into TypeScript", () => {
        assert.equal(tsType({ type: "string", enum: ["a", "b"] }), '"a" | "b"');
        assert.equal(tsType({ type: ["object", "null"], properties: { x: { type: "integer" } }, required: ["x"] }),
            "{\n    x: number;\n} | null");
        assert.equal(tsType({ type: "array", items: { type: ["string", "null"] } }), "(string | null)[]");
        assert.equal(tsType({ type: "object", properties: {} }), "Record<string, never>");
    });

    it("keeps descriptions as comments and marks optional keys", () => {
        const out = generate({ "x do": { description: "Do x", input: { type: "object",
            properties: { a: { type: "boolean", description: "The a" } } } } });
        assert.match(out, /\/\*\* x do: Do x \*\/\nexport type XDoInput = \{\n {4}\/\*\* The a \*\/\n {4}a\?: boolean;\n\};/);
        assert.match(out, /"x do": XDoInput;/);
    });
});
