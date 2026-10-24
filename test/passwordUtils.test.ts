import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePassword, checkPasswordAgainstPolicy } from "../src/lib/passwordUtils.ts";
import type { PasswordPolicy } from "../src/lib/types.ts";

const complexPolicy: Pick<PasswordPolicy, "complexityRequired" | "minLength"> = { complexityRequired: true, minLength: 10 };
const simplePolicy: Pick<PasswordPolicy, "complexityRequired" | "minLength"> = { complexityRequired: false, minLength: 6 };

describe("generatePassword", () => {
    it("respects minLength", () => {
        assert.equal(generatePassword(complexPolicy).length, 10);
    });

    it("never goes below 8 characters", () => {
        assert.equal(generatePassword(simplePolicy).length, 8);
        assert.equal(generatePassword({ ...simplePolicy, minLength: 0 }).length, 8);
    });

    it("satisfies all 4 complexity categories when required", () => {
        for (let i = 0; i < 20; i++) {
            const pwd = generatePassword(complexPolicy);
            assert.match(pwd, /[A-Z]/);
            assert.match(pwd, /[a-z]/);
            assert.match(pwd, /[0-9]/);
            assert.match(pwd, /[^A-Za-z0-9]/);
        }
    });

    it("passes its own policy check", () => {
        for (let i = 0; i < 20; i++) {
            assert.equal(checkPasswordAgainstPolicy(complexPolicy, generatePassword(complexPolicy)), null);
        }
    });
});

describe("checkPasswordAgainstPolicy", () => {
    it("flags passwords shorter than minLength", () => {
        assert.equal(checkPasswordAgainstPolicy(complexPolicy, "Ab1!x"), "minLength");
    });

    it("flags passwords with fewer than 3 of 4 categories", () => {
        assert.equal(checkPasswordAgainstPolicy(complexPolicy, "abcdefghijkl"), "complexity");
        assert.equal(checkPasswordAgainstPolicy(complexPolicy, "abcdefghijk1"), "complexity");
    });

    it("accepts 3 of 4 categories (Windows rule)", () => {
        assert.equal(checkPasswordAgainstPolicy(complexPolicy, "Abcdefghijk1"), null);
        assert.equal(checkPasswordAgainstPolicy(complexPolicy, "abcdefghij1!"), null);
    });

    it("skips complexity when not required", () => {
        assert.equal(checkPasswordAgainstPolicy(simplePolicy, "abcdef"), null);
    });
});
