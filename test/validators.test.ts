import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateUsername, validateGroupName, validateMemberName, validateShareName, validateExpiryDay, expiryInstantFromDay, dayFromExpiryInstant, validatePasswordPolicy, validatePso, validateOuName, validateComputerName, validateEmail, validateDnsName, validateDnsValue, validateRealm, validateNetbiosDomain, validateForwarder, adminPasswordContainsName } from "../src/lib/validators.ts";
import type { PasswordPolicy } from "../src/lib/types.ts";

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

describe("validatePasswordPolicy", () => {
    const samba: PasswordPolicy = {
        complexityRequired: true, minLength: 7, historyLength: 24, minAgeDays: 1, maxAgeDays: 42,
        lockoutThreshold: 0, lockoutDurationMinutes: 30, lockoutWindowMinutes: 30,
    };

    it("accepts Samba's defaults and the never values", () => {
        assert.equal(validatePasswordPolicy(samba), null);
        assert.equal(validatePasswordPolicy({ ...samba, maxAgeDays: null, lockoutDurationMinutes: null,
            lockoutWindowMinutes: null }), null);
    });

    it("keeps samba-tool's ranges", () => {
        assert.equal(validatePasswordPolicy({ ...samba, minLength: 15 }), "minLength");
        assert.equal(validatePasswordPolicy({ ...samba, minLength: NaN }), "minLength");
        assert.equal(validatePasswordPolicy({ ...samba, historyLength: 2.5 }), "historyLength");
        assert.equal(validatePasswordPolicy({ ...samba, maxAgeDays: 0 }), "maxAge");
        assert.equal(validatePasswordPolicy({ ...samba, lockoutThreshold: 1000 }), "lockoutThreshold");
    });

    it("wants the maximum age above the minimum, and the reset within the lockout", () => {
        assert.equal(validatePasswordPolicy({ ...samba, minAgeDays: 42 }), "ages");
        assert.equal(validatePasswordPolicy({ ...samba, lockoutWindowMinutes: 31 }), "windowTooLong");
        assert.equal(validatePasswordPolicy({ ...samba, lockoutWindowMinutes: null }), "windowNever");
        assert.equal(validatePasswordPolicy({ ...samba, lockoutDurationMinutes: null, lockoutWindowMinutes: 600 }), null);
    });
});

describe("PSOs", () => {
    const samba: PasswordPolicy = {
        complexityRequired: true, minLength: 7, historyLength: 24, minAgeDays: 1, maxAgeDays: 42,
        lockoutThreshold: 0, lockoutDurationMinutes: 30, lockoutWindowMinutes: 30,
    };

    it("allows longer passwords and histories than the domain", () => {
        assert.equal(validatePasswordPolicy({ ...samba, minLength: 20, historyLength: 100 }), "minLength");
        assert.equal(validatePasswordPolicy({ ...samba, minLength: 20, historyLength: 100 }, true), null);
        assert.equal(validatePasswordPolicy({ ...samba, minLength: 256 }, true), "minLength");
    });

    it("checks the name and the precedence", () => {
        assert.equal(validatePso("Staff long", 10), null);
        assert.equal(validatePso("", 10), "empty");
        assert.equal(validatePso(" x", 10), "surroundingSpaces");
        assert.equal(validatePso("x".repeat(65), 10), "tooLong");
        assert.equal(validatePso("a\tb", 10), "invalidChars");
        assert.equal(validatePso("x", 0), "precedence");
        assert.equal(validatePso("x", NaN), "precedence");
    });
});

describe("validateOuName", () => {
    it("refuses what addcctl refuses", () => {
        assert.equal(validateOuName("Classe 1A, sez. B"), null);
        assert.equal(validateOuName(""), "empty");
        assert.equal(validateOuName(" x"), "surroundingSpaces");
        assert.equal(validateOuName("x".repeat(65)), "tooLong");
        assert.equal(validateOuName("a\nb"), "invalidChars");
    });
});

describe("validateComputerName", () => {
    it("accepts NetBIOS names of letters, digits and hyphens", () => {
        for (const ok of ["PC01", "lab-pc-02", "A", "a23456789012345"]) assert.equal(validateComputerName(ok), null, ok);
    });
    it("refuses what addcctl refuses", () => {
        assert.equal(validateComputerName(""), "empty");
        assert.equal(validateComputerName("a234567890123456"), "tooLong");
        assert.equal(validateComputerName("pc_01"), "invalidChars");
        assert.equal(validateComputerName("pc 01"), "invalidChars");
        assert.equal(validateComputerName("PC01$"), "invalidChars");
        assert.equal(validateComputerName("-pc"), "leadingDash");
        assert.equal(validateComputerName("1234"), "onlyDigits");
    });
});

describe("validateEmail", () => {
    it("allows an empty address and catches typos", () => {
        assert.equal(validateEmail(""), null);
        assert.equal(validateEmail("m.rossi@school.example"), null);
        assert.equal(validateEmail("m.rossi"), "invalid");
        assert.equal(validateEmail("m rossi@x"), "invalid");
        assert.equal(validateEmail("a@b@c"), "invalid");
        assert.equal(validateEmail("@x"), "invalid");
    });
});

describe("DNS names and values", () => {
    it("checks names as addcctl does", () => {
        for (const name of ["@", "www", "a.b", "*", "*.dev", "_sip._tcp", "host-1", "www.example.com."]) {
            assert.equal(validateDnsName(name), null, name);
        }
        assert.equal(validateDnsName(""), "empty");
        for (const name of ["a..b", "-x", "x-", "a b", "w*", "a.*", "x".repeat(64)]) {
            assert.equal(validateDnsName(name), "invalid", name);
        }
    });

    it("checks each type's notation", () => {
        assert.equal(validateDnsValue("A", "192.168.1.10"), null);
        assert.equal(validateDnsValue("A", "192.168.1.256"), "ipv4");
        assert.equal(validateDnsValue("AAAA", "2001:db8::10"), null);
        assert.equal(validateDnsValue("AAAA", "192.168.1.10"), "ipv6");
        assert.equal(validateDnsValue("AAAA", "2001::db8::1"), "ipv6");
        assert.equal(validateDnsValue("CNAME", "server.example.com."), null);
        assert.equal(validateDnsValue("PTR", "bad name"), "host");
        assert.equal(validateDnsValue("MX", "mail.example.com 10"), null);
        assert.equal(validateDnsValue("MX", "mail.example.com"), "mx");
        assert.equal(validateDnsValue("SRV", "sip.example.com 5060 0 100"), null);
        assert.equal(validateDnsValue("SRV", "sip.example.com 70000 0 100"), "srv");
        assert.equal(validateDnsValue("TXT", "v=spf1 mx -all"), null);
        assert.equal(validateDnsValue("TXT", "a\tb"), "text");
        assert.equal(validateDnsValue("A", " "), "empty");
    });
});

describe("a new domain", () => {
    it("checks the realm as addcctl does", () => {
        assert.equal(validateRealm("school.example.org", "dc"), null);
        assert.equal(validateRealm("School.Example.Org.", "dc"), null);
        assert.equal(validateRealm("", "dc"), "empty");
        for (const bad of ["school", "-a.org", "a..org", "a.b_c.org", "a.org;x"])
            assert.equal(validateRealm(bad, "dc"), "invalid", bad);
        assert.equal(validateRealm("school.123", "dc"), "numeric");
    });

    it("checks the NetBIOS name", () => {
        assert.equal(validateNetbiosDomain("school", "dc"), null);
        assert.equal(validateNetbiosDomain("dc", "dc"), "hostName");
        assert.equal(validateNetbiosDomain("SIXTEEN-LETTERS1", "dc"), "tooLong");
        assert.equal(validateNetbiosDomain("SCH.OOL", "dc"), "invalidChars");
        assert.equal(validateNetbiosDomain("-SCHOOL", "dc"), "dash");
        assert.equal(validateNetbiosDomain("123", "dc"), "onlyDigits");
    });

    it("checks the DNS forwarder", () => {
        assert.equal(validateForwarder("192.168.1.1", "192.168.1.20"), null);
        assert.equal(validateForwarder("2001:db8::1", "192.168.1.20"), null);
        assert.equal(validateForwarder("dns.example.org", null), "invalid");
        assert.equal(validateForwarder("1.1.1.1 8.8.8.8", null), "invalid");
        assert.equal(validateForwarder("239.1.1.1", null), "invalid");
        assert.equal(validateForwarder("127.0.0.1", null), "local");
        assert.equal(validateForwarder("192.168.1.20", "192.168.1.20"), "local");
    });

    it("refuses the account name in the administrator's password", () => {
        assert.equal(adminPasswordContainsName("MyAdministrator1!"), true);
        assert.equal(adminPasswordContainsName("Secret-Pass1"), false);
    });
});
