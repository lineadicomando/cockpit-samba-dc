import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLdapShow, parseLdapMulti, parseList, deriveUserStatus, deriveLastActivity, ridFromSid, dnToName, resolveDn, buildDnNameMap, parseGroupType, parseNetConf, parseSmbUserList, parseSmbBool } from "../src/lib/parsers.ts";

describe("parseList", () => {
    it("splits output in names", () => {
        const raw = "alice\nbob\nAdministrator\n";
        assert.deepEqual(parseList(raw), ["alice", "bob", "Administrator"]);
    });

    it("ignores empty lines", () => {
        assert.deepEqual(parseList("\n\n"), []);
    });
});

describe("parseLdapShow", () => {
    it("parses simple key: value", () => {
        const raw = "cn: alice\ndn: CN=alice,DC=acme,DC=internal\n";
        const result = parseLdapShow(raw);
        assert.equal(result["cn"], "alice");
        assert.equal(result["dn"], "CN=alice,DC=acme,DC=internal");
    });

    it("collects repeated keys into array", () => {
        const raw = "memberOf: CN=Users,DC=acme\nmemberOf: CN=Admins,DC=acme\n";
        const result = parseLdapShow(raw);
        assert.deepEqual(result["memberOf"], ["CN=Users,DC=acme", "CN=Admins,DC=acme"]);
    });

    it("ignores lines without ': ' separator", () => {
        const raw = "invalid line\ncn: valid\n";
        const result = parseLdapShow(raw);
        assert.equal(Object.keys(result).length, 1);
    });

    it("decodes base64 values with :: separator as UTF-8", () => {
        // Real ldb output for a non-ASCII cn
        const raw = "cn:: Tmljb2zDsiBSb3NzaQ==\nsAMAccountName: nrossi\n";
        const result = parseLdapShow(raw);
        assert.equal(result["cn"], "Nicolò Rossi");
        assert.equal(result["sAMAccountName"], "nrossi");
    });

    it("decodes repeated base64 values into an array", () => {
        const raw = "memberOf:: Q049w4hxdWlwZSxEQz1hY21l\nmemberOf: CN=Users,DC=acme\n";
        const result = parseLdapShow(raw);
        assert.deepEqual(result["memberOf"], ["CN=Èquipe,DC=acme", "CN=Users,DC=acme"]);
    });

    it("unfolds continuation lines (leading single space)", () => {
        // samba-tool user show folds at 78 columns
        const raw = [
            "memberOf: CN=LungoNomeGruppoLungoNomeGruppoLungoNomeGruppoLungoNomeGruppoLungo",
            " NomeGruppo,CN=Users,DC=school,DC=internal",
            "cn: alice",
        ].join("\n");
        const result = parseLdapShow(raw);
        assert.equal(result["memberOf"], "CN=LungoNomeGruppoLungoNomeGruppoLungoNomeGruppoLungoNomeGruppoLungoNomeGruppo,CN=Users,DC=school,DC=internal");
        assert.equal(result["cn"], "alice");
    });

    it("unfolds folded base64 values before decoding", () => {
        const raw = "cn:: Tmljb2zDsiBS\n b3NzaQ==\n";
        assert.equal(parseLdapShow(raw)["cn"], "Nicolò Rossi");
    });
});

describe("parseLdapMulti", () => {
    it("returns empty array for empty input", () => {
        assert.deepEqual(parseLdapMulti(""), []);
    });

    it("parses a single object block", () => {
        const raw = "dn: CN=alice,DC=acme\nsAMAccountName: alice\n";
        const result = parseLdapMulti(raw);
        assert.equal(result.length, 1);
        assert.equal(result[0]["sAMAccountName"], "alice");
    });

    it("parses multiple object blocks separated by blank lines", () => {
        const raw = "sAMAccountName: alice\ncn: Alice\n\nsAMAccountName: bob\ncn: Bob\n";
        const result = parseLdapMulti(raw);
        assert.equal(result.length, 2);
        assert.equal(result[0]["sAMAccountName"], "alice");
        assert.equal(result[1]["sAMAccountName"], "bob");
    });

    it("strips comment lines starting with # within blocks", () => {
        const raw = "# record 1\ndn: CN=alice,DC=acme\nsAMAccountName: alice\n";
        const result = parseLdapMulti(raw);
        assert.equal(result.length, 1);
        assert.equal(result[0]["sAMAccountName"], "alice");
        assert.equal(result[0]["#"], undefined);
    });

    it("filters out comment-only blocks like trailing count lines", () => {
        const raw = "sAMAccountName: alice\n\n# returned 1 records\n# 1 entries\n";
        const result = parseLdapMulti(raw);
        assert.equal(result.length, 1);
        assert.equal(result[0]["sAMAccountName"], "alice");
    });

    it("handles ldbsearch format with # record N headers", () => {
        const raw = [
            "# record 1",
            "dn: CN=alice,DC=acme",
            "sAMAccountName: alice",
            "",
            "# record 2",
            "dn: CN=bob,DC=acme",
            "sAMAccountName: bob",
            "",
            "# Returned 2 entries",
        ].join("\n");
        const result = parseLdapMulti(raw);
        assert.equal(result.length, 2);
        assert.equal(result[0]["sAMAccountName"], "alice");
        assert.equal(result[1]["sAMAccountName"], "bob");
    });
});

describe("deriveUserStatus", () => {
    it("returns Active when UAC bit 2 is 0", () => {
        assert.equal(deriveUserStatus("512"), "Active");
    });
    it("returns Disabled when UAC bit 2 is set", () => {
        assert.equal(deriveUserStatus("514"), "Disabled");
    });
    it("returns Unknown for invalid UAC", () => {
        assert.equal(deriveUserStatus("abc"), "Unknown");
    });
});

describe("deriveLastActivity", () => {
    it("returns empty (never) for zero ticks", () => {
        assert.equal(deriveLastActivity("0"), "");
    });
    it("returns empty (never) for negative ticks", () => {
        assert.equal(deriveLastActivity("-1"), "");
    });
    it("returns a date string for valid Windows ticks", () => {
        const unixMs = new Date("2024-01-01").getTime();
        const windowsTicks = String((unixMs + 11644473600000) * 10000);
        const result = deriveLastActivity(windowsTicks);
        assert.match(result, /2024/);
    });
});

describe("ridFromSid", () => {
    it("extracts last RID from SID", () => {
        assert.equal(ridFromSid("S-1-5-21-111-222-333-1104"), "1104");
    });
    it("returns - for empty string", () => {
        assert.equal(ridFromSid(""), "-");
    });
});

describe("parseGroupType", () => {
    it("returns Security for negative groupType (Security+Global)", () => {
        assert.equal(parseGroupType("-2147483646"), "Security");
    });
    it("returns Security for negative groupType (Security+DomainLocal)", () => {
        assert.equal(parseGroupType("-2147483644"), "Security");
    });
    it("returns Distribution for positive groupType (Distribution+Global)", () => {
        assert.equal(parseGroupType("2"), "Distribution");
    });
    it("returns Distribution for positive groupType (Distribution+Universal)", () => {
        assert.equal(parseGroupType("8"), "Distribution");
    });
    it("defaults to Security for empty string", () => {
        assert.equal(parseGroupType(""), "Security");
    });
});

describe("dnToName", () => {
    it("extracts CN from DN", () => {
        assert.equal(dnToName("CN=Domain Users,DC=acme,DC=internal"), "Domain Users");
    });
    it("is case-insensitive on cn=", () => {
        assert.equal(dnToName("cn=alice,DC=acme"), "alice");
    });
    it("keeps escaped commas and decodes hex escapes (RFC 4514)", () => {
        assert.equal(dnToName("CN=Rossi\\, Mario,OU=Staff,DC=acme"), "Rossi, Mario");
        assert.equal(dnToName("CN=Nicol\\C3\\B2 \\\\ co,DC=acme"), "Nicolò \\ co");
        assert.equal(dnToName("CN=\\#tag\\+1,DC=acme"), "#tag+1");
    });
});

describe("resolveDn", () => {
    const names = buildDnNameMap([
        { dn: "CN=Mario Rossi,CN=Users,DC=acme", sAMAccountName: "mrossi" },
        { dn: "CN=No Account,DC=acme" },
    ]);
    it("returns the account name, matching the DN case-insensitively", () => {
        assert.equal(resolveDn("cn=mario rossi,cn=users,dc=acme", names), "mrossi");
    });
    it("falls back to the CN for DNs not in the map", () => {
        assert.equal(resolveDn("CN=PC01,CN=Computers,DC=acme", names), "PC01");
        assert.equal(resolveDn("CN=No Account,DC=acme", names), "No Account");
    });
});

describe("parseNetConf", () => {
    it("splits sections and lowercases parameter names", () => {
        const raw = "[home]\n\tpath = /srv/samba/home\n\tRead Only = no\n\n[docs]\n\tpath = /srv/samba/shares/docs\n\tcomment = \n";
        const conf = parseNetConf(raw);
        assert.deepEqual([...conf.keys()], ["home", "docs"]);
        assert.equal(conf.get("home")?.["read only"], "no");
        assert.equal(conf.get("docs")?.["comment"], "");
    });

    it("keeps values containing '='", () => {
        const conf = parseNetConf("[x]\n\tcomment = a = b\n");
        assert.equal(conf.get("x")?.["comment"], "a = b");
    });
});

describe("parseSmbUserList", () => {
    it("parses quoted groups and users and strips the domain", () => {
        assert.deepEqual(parseSmbUserList('@"SCHOOL\\Domain Users" "SCHOOL\\mrossi"'), [
            { name: "Domain Users", kind: "group" },
            { name: "mrossi", kind: "user" },
        ]);
    });

    it("accepts unquoted, comma-separated and +/& prefixed entries", () => {
        assert.deepEqual(parseSmbUserList("alice, +staff &SCHOOL\\teachers"), [
            { name: "alice", kind: "user" },
            { name: "staff", kind: "group" },
            { name: "teachers", kind: "group" },
        ]);
    });

    it("returns an empty list for an empty value", () => {
        assert.deepEqual(parseSmbUserList(""), []);
    });
});

describe("parseSmbBool", () => {
    it("parses smb.conf booleans with a fallback", () => {
        assert.equal(parseSmbBool("Yes", false), true);
        assert.equal(parseSmbBool("0", true), false);
        assert.equal(parseSmbBool(undefined, true), true);
        assert.equal(parseSmbBool("maybe", false), false);
    });
});
