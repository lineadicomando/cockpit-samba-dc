import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateUsername, validateGroupName, validateMemberName, validateShareName, validateExpiryDay, expiryInstantFromDay, dayFromExpiryInstant } from "../src/lib/validators.ts";

describe("validateUsername", () => {
    it("accepts typical usernames", () => {
        assert.equal(validateUsername("mario.rossi"), null);
        assert.equal(validateUsername("Studente01"), null);
        assert.equal(validateUsername("a"), null);
        assert.equal(validateUsername("user_name-x"), null);
        assert.equal(validateUsername("nome cognome"), null);
    });

    it("rejects the empty string", () => {
        assert.equal(validateUsername(""), "empty");
    });

    it("rejects names longer than 20 characters", () => {
        assert.equal(validateUsername("a".repeat(20)), null);
        assert.equal(validateUsername("a".repeat(21)), "tooLong");
    });

    it("rejects AD-invalid characters", () => {
        for (const c of '"/\\[]:;|=,+*?<>') {
            assert.equal(validateUsername(`user${c}x`), "invalidChars", `expected '${c}' to be rejected`);
        }
    });

    it("rejects control characters", () => {
        assert.equal(validateUsername("user\u0000x"), "invalidChars");
        assert.equal(validateUsername("user\tx"), "invalidChars");
        assert.equal(validateUsername("user\nx"), "invalidChars");
    });

    it("rejects a leading dash (would be parsed as a CLI option)", () => {
        assert.equal(validateUsername("-admin"), "leadingDash");
        assert.equal(validateUsername("--random-password"), "leadingDash");
        assert.equal(validateUsername("ad-min"), null);
    });

    it("rejects a trailing period", () => {
        assert.equal(validateUsername("user."), "trailingPeriod");
        assert.equal(validateUsername("user.name"), null);
    });
});

describe("validateGroupName", () => {
    it("accepts typical group names, including ones longer than 20 characters", () => {
        assert.equal(validateGroupName("2C"), null);
        assert.equal(validateGroupName("Docenti scuola primaria plesso nord"), null);
    });

    it("rejects the empty string and names longer than 256 characters", () => {
        assert.equal(validateGroupName(""), "empty");
        assert.equal(validateGroupName("g".repeat(256)), null);
        assert.equal(validateGroupName("g".repeat(257)), "tooLong");
    });

    it("rejects a leading dash (would be parsed as a samba-tool option)", () => {
        assert.equal(validateGroupName("-H"), "leadingDash");
        assert.equal(validateGroupName("--help"), "leadingDash");
    });

    it("rejects AD-invalid characters and a trailing period", () => {
        assert.equal(validateGroupName("a,b"), "invalidChars");
        assert.equal(validateGroupName("grp."), "trailingPeriod");
    });
});

describe("validateMemberName", () => {
    it("accepts users, computer accounts and nested groups", () => {
        assert.equal(validateMemberName("student-alice"), null);
        assert.equal(validateMemberName("PC00$"), null);
        assert.equal(validateMemberName("Docenti scuola primaria plesso nord"), null);
    });

    it("rejects option-like names", () => {
        assert.equal(validateMemberName("-x"), "leadingDash");
    });
});

describe("validateShareName", () => {
    it("accepts typical share names", () => {
        assert.equal(validateShareName("Docenti"), null);
        assert.equal(validateShareName("progetti 2026"), null);
        assert.equal(validateShareName("a".repeat(80)), null);
    });

    it("rejects empty and too long names", () => {
        assert.equal(validateShareName(""), "empty");
        assert.equal(validateShareName("a".repeat(81)), "tooLong");
    });

    it("rejects characters invalid in share names or paths", () => {
        for (const c of '"/\\[]:;|=,+*?<>%') {
            assert.equal(validateShareName(`x${c}y`), "invalidChars", `expected '${c}' to be rejected`);
        }
        assert.equal(validateShareName("x\u0007y"), "invalidChars");
    });

    it("rejects leading/trailing spaces and a leading dash", () => {
        assert.equal(validateShareName(" docs"), "surroundingSpaces");
        assert.equal(validateShareName("docs "), "surroundingSpaces");
        assert.equal(validateShareName("-docs"), "leadingDash");
    });

    it("rejects reserved names case-insensitively", () => {
        for (const n of ["global", "HOMES", "SysVol", "netlogon", "home", "IPC$", ".", ".."]) {
            assert.equal(validateShareName(n), "reserved", `expected '${n}' to be reserved`);
        }
    });
});

describe("account expiry day", () => {
    it("expires at the start of the following day, local time", () => {
        const instant = expiryInstantFromDay("2027-06-30");
        assert.deepEqual(instant, new Date(2027, 6, 1));
        assert.deepEqual(expiryInstantFromDay("2026-12-31"), new Date(2027, 0, 1));
    });

    it("shows the day an instant ends", () => {
        assert.equal(dayFromExpiryInstant(new Date(2027, 6, 1).getTime()), "2027-06-30");
        assert.equal(dayFromExpiryInstant(new Date(2027, 6, 1, 15, 30).getTime()), "2027-07-01");
    });

    it("rejects what is not a calendar day", () => {
        assert.equal(validateExpiryDay(""), "empty");
        assert.equal(validateExpiryDay("2026-02-30"), "invalid");
        assert.equal(validateExpiryDay("2026-13-01"), "invalid");
        assert.equal(validateExpiryDay("30/06/2027"), "invalid");
        assert.equal(validateExpiryDay("1960-01-01"), "invalid");
        assert.equal(validateExpiryDay("2028-02-29"), null);
    });
});
