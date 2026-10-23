// Checks on a real DC the fixes of the October 2026 review (run with
// run-lib.sh, after "lab.sh reset", "start dc" and "deploy"). Leaves its test
// data in place for the checks on the Windows client; "lab.sh reset" removes it.
import assert from "node:assert/strict";
import cockpit from "cockpit";
import {
    createUser, createGroup, renameGroup, modifyUser, addGroupMembers,
    listGroups, listUsers, getGroupDetails,
} from "../../src/lib/samba.ts";
import { createShare, updateShare, listShares } from "../../src/lib/shares.ts";
import { getBaseDN } from "../../src/lib/exec.ts";

const run = (args: string[], input?: string): Promise<string> =>
    input === undefined ? cockpit.spawn(args) : cockpit.spawn(args).input(input);
const netbios = process.env.DOMAIN_NETBIOS!;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
    process.stdout.write(`- ${name} ... `);
    await fn();
    console.log("ok");
}

async function drivesXml(): Promise<string> {
    const out = await run(["sh", "-c", "cat /var/lib/samba/sysvol/*/Policies/*/USER/Preferences/Drives/Drives.xml"]);
    return out;
}

async function gpLink(): Promise<string> {
    const raw = await run(["ldbsearch", "-H", "/var/lib/samba/private/sam.ldb", "-s", "base", "-b", await getBaseDN(), "gPLink"]);
    return raw.replace(/\n /g, "").match(/^gPLink: (.*)$/m)?.[1] ?? "";
}

async function main(): Promise<void> {
    await step("fixtures: t-group with t-mrossi (CN \"Mario Rossi\") and student1", async () => {
        await createGroup("t-group");
        await createUser("t-mrossi", process.env.DOMAIN_TEST_PASSWORD!, "Mario", "Rossi");
        await addGroupMembers("t-group", ["t-mrossi", "student1"]);
        const cn = await run(["ldbsearch", "-H", "/var/lib/samba/private/sam.ldb", "(sAMAccountName=t-mrossi)", "cn"]);
        assert.match(cn, /^cn: Mario Rossi$/m, "samba-tool names the CN after the full name");
    });

    await step("point 3: members and groups are account names, not CNs", async () => {
        const group = (await listGroups()).find(g => g.name === "t-group");
        assert.deepEqual(group?.members.sort(), ["student1", "t-mrossi"]);
        assert.deepEqual((await getGroupDetails("t-group")).members.sort(), ["student1", "t-mrossi"]);
        const user = (await listUsers()).find(u => u.username === "t-mrossi");
        assert.ok(user?.groups.includes("t-group"), `groups: ${user?.groups}`);
        assert.equal(user?.fullName, "Mario Rossi");
    });

    await step("share t-docs: t-group read, teacher1 write, mapped as S:", async () => {
        await createShare("t-docs", {
            comment: "", browseable: true, automount: { letter: "S", label: "Docs" },
            access: [{ name: "t-group", kind: "group", level: "read" }, { name: "teacher1", kind: "user", level: "write" }],
        });
        assert.deepEqual((await listShares()).filter(s => s.automount).map(s => [s.name.toLowerCase(), s.automount]),
            [["t-docs", { letter: "S", label: "Docs" }]]);
        await run(["sh", "-c", "echo hello > /srv/samba/shares/t-docs/readme.txt && chmod 644 /srv/samba/shares/t-docs/readme.txt"]);
    });

    await step("point 4: an unlinked GPO is linked again on the next write", async () => {
        const link = await gpLink();
        const ours = /\[LDAP:\/\/CN=\{[^}]+\},CN=Policies[^\]]*;0\]$/.exec(link)?.[0];
        assert.ok(ours, `our link is the last one: ${link}`);
        const without = link.slice(0, link.length - ours.length);
        await run(["ldbmodify", "-H", "/var/lib/samba/private/sam.ldb"],
            `dn: ${await getBaseDN()}\nchangetype: modify\nreplace: gPLink\ngPLink: ${without}\n-\n`);
        assert.equal(await gpLink(), without);
        const share = (await listShares()).find(s => s.name === "t-docs")!;
        await updateShare("t-docs", { comment: share.comment, browseable: share.browseable, access: share.access, automount: { letter: "S", label: "Documents" } });
        assert.equal(await gpLink(), link);
    });

    await step("point 1: renaming the group rewrites valid users, read list and the drive filter", async () => {
        await renameGroup("t-group", "t-readers");
        const params = await run(["net", "conf", "showshare", "t-docs"]);
        assert.match(params, new RegExp(`valid users = @"${netbios}\\\\t-readers" "${netbios}\\\\teacher1"`));
        assert.match(params, new RegExp(`read list = @"${netbios}\\\\t-readers"`));
        const xml = await drivesXml();
        assert.ok(xml.includes(`name="${netbios}\\t-readers"`), xml);
        assert.ok(!xml.includes("t-group"), xml);
    });

    await step("point 1: renaming the user rewrites valid users", async () => {
        await modifyUser("teacher1", { newUsername: "t-teacher" });
        const params = await run(["net", "conf", "showshare", "t-docs"]);
        assert.match(params, new RegExp(`valid users = @"${netbios}\\\\t-readers" "${netbios}\\\\t-teacher"`));
        assert.ok((await drivesXml()).includes(`name="${netbios}\\t-teacher"`));
    });

    await step("smbd lets the renamed principals in (smbclient as student1 and t-teacher)", async () => {
        // smbclient takes the password from PASSWD, set from stdin (not argv);
        // it reports errors on stdout: move them to stderr, where a
        // failed spawn() takes its message from
        const ls = (user: string) => run(["sh", "-c", 'read -r PASSWD; export PASSWD; out=$(smbclient //localhost/t-docs -U "$1" -c "ls readme.txt" 2>&1) || { echo "$out" >&2; exit 1; }; echo "$out"',
            "sh", `${netbios}\\${user}`], `${process.env.DOMAIN_TEST_PASSWORD}\n`);
        assert.match(await ls("student1"), /readme\.txt/);
        assert.match(await ls("t-teacher"), /readme\.txt/);
        await assert.rejects(ls("student2"), /NT_STATUS_ACCESS_DENIED/);
    });

    await step("point 5: a hand-made share at the shares directory itself is not managed", async () => {
        await run(["net", "conf", "addshare", "t-root", "/srv/samba/shares/", "writeable=n", "guest_ok=n"]);
        try {
            const names = (await listShares()).map(s => s.name);
            assert.ok(!names.includes("t-root"), `listed: ${names}`);
            assert.ok(names.includes("t-docs"));
        } finally {
            await run(["net", "conf", "delshare", "t-root"]);
        }
    });

    console.log("all checks passed");
}

main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
});
