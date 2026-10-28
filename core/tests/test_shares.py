# SPDX-License-Identifier: LGPL-2.1-or-later
import io
import json
import os
import tempfile
import unittest

from addcctl import acl
from addcctl.cli import run
from addcctl.drivemaps import DriveMaps, parse_drives_xml
from addcctl.errors import AddcError
from addcctl.runner import Runner
from addcctl.shares import Shares
from addcctl.smbconf import is_managed_path, parse_user_list, share_access, share_name_violation

PRINCIPALS = {
    "staff": {"name": "Staff", "kind": "group", "sid": "S-1-5-21-1-2-3-1108"},
    "domain users": {"name": "Domain Users", "kind": "group", "sid": "S-1-5-21-1-2-3-513"},
    "mrossi": {"name": "mrossi", "kind": "user", "sid": "S-1-5-21-1-2-3-1200"},
}
POSIX = {"staff": {"u": "3000010", "g": "3000010"}, "domain users": {"g": "100"},
         "mrossi": {"u": "3000020", "g": "3000020"}}


class FakeRunner(Runner):
    """Records commands; getfacl answers from acls, files go to disk."""

    def __init__(self, check=False):
        super().__init__(check)
        self.acls = {}

    def query(self, args, input=None, ok=(0,)):
        if args[0] == "getfacl":
            return self.acls.get(args[-1], "")
        raise AssertionError("unexpected query %r" % args)

    def change(self, args, input=None):
        self.commands.append(" ".join(args))
        return ""


class FakeDc:
    workgroup = "SCHOOL"
    netbios_name = "DC"
    realm = "SCHOOL.INTERNAL"

    def __init__(self, runner, sysvol):
        self.runner = runner
        self.sysvol = sysvol
        self.registry = {}
        self.gpo = None
        self.linked = []
        self.id_lookups = []

    def shares(self):
        return {k: dict(v) for k, v in self.registry.items()}

    def update_share(self, name, set_params, delete_params=(), create=False):
        self.runner.record("registry %s %s -%s" % (name, sorted(set_params.items()), sorted(delete_params)))
        if self.runner.check:
            return
        params = self.registry.setdefault(name, {}) if create else self.registry[name]
        params.update({k.lower(): v for k, v in set_params.items()})
        for p in delete_params:
            params.pop(p, None)

    def delete_share(self, name):
        self.runner.record("registry delete %s" % name)
        if not self.runner.check:
            del self.registry[name]

    def resolve_principals(self, names):
        return {n.lower(): PRINCIPALS[n.lower()] for n in names if n.lower() in PRINCIPALS}

    def posix_ids(self, name, sid=None):
        self.id_lookups.append((name, sid))
        return POSIX.get(name.lower(), {})

    def find_gpo(self, name):
        return dict(self.gpo) if self.gpo else None

    def add_gpo(self, guid, name, cse):
        self.runner.record("add gpo %s" % guid)
        self.gpo = {"guid": guid, "dn": "CN=%s,CN=Policies,CN=System,DC=school,DC=internal" % guid, "version": 0}
        return dict(self.gpo)

    def ensure_gpo_linked(self, dn):
        if dn not in self.linked:
            self.linked.append(dn)

    def set_gpo_version(self, dn, version):
        self.runner.record("gpo version %d" % version)
        if not self.runner.check:
            self.gpo["version"] = version


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.runner = FakeRunner()
        self.dc = FakeDc(self.runner, self.tmp.name)
        # The share roots: not on disk, so ensure_root creates them
        self.shares = Shares(self.dc, self.runner, shares_dir=os.path.join(self.tmp.name, "shares"))

    def share_path(self, name):
        return os.path.join(self.tmp.name, "shares", name)

    def drives(self):
        guid = self.dc.gpo["guid"]
        path = "%s/school.internal/Policies/%s/USER/Preferences/Drives/Drives.xml" % (self.tmp.name, guid)
        with open(path) as f:
            return parse_drives_xml(f.read())

    def again(self):
        """A fresh Shares on the same DC, as a new addcctl run would be."""
        self.runner.commands.clear()
        return Shares(self.dc, self.runner, shares_dir=os.path.join(self.tmp.name, "shares"))


class TestValues(unittest.TestCase):
    def test_managed_paths(self):
        self.assertTrue(is_managed_path("/srv/samba/shares/docs"))
        for path in ("/srv/samba/shares/", "/srv/samba/shares/.", "/srv/samba/shares/..",
                     "/srv/samba/shares/a/b", "/srv/samba/home", "/srv/samba/sharesx"):
            self.assertFalse(is_managed_path(path), path)

    def test_share_names(self):
        self.assertIsNone(share_name_violation("Progetti 2026"))
        for name in ("", "-x", "home", "a/b", " x", "a%b"):
            self.assertIsNotNone(share_name_violation(name), name)

    def test_user_lists(self):
        self.assertEqual(parse_user_list('@"SCHOOL\\Staff" "SCHOOL\\mrossi", alice'),
                         [("Staff", "group"), ("mrossi", "user"), ("alice", "user")])
        self.assertEqual(share_access({"valid users": '@"S\\Staff" "S\\mrossi"', "read list": '"S\\mrossi"',
                                       "read only": "no"}),
                         [{"name": "Staff", "kind": "group", "level": "write"},
                          {"name": "mrossi", "kind": "user", "level": "read"}])

    def test_setfacl_clears_both_tags(self):
        args = acl.setfacl_args("/p", [("g", "100", "read")], {("u", "3000020"), ("g", "3000020")})
        self.assertEqual(args, ["setfacl", "-R", "-x", "g:3000020,d:g:3000020,u:3000020,d:u:3000020",
                                "-m", "g::---,d:u::rwx,d:g::---,d:o::---,g:100:r-X,d:g:100:r-X", "/p"])


class TestShareSet(Base):
    def create(self, **extra):
        return self.shares.set(dict({"name": "Docs", "access": [{"name": "staff", "level": "write"},
                                                                 {"name": "Domain Users"}]}, **extra))

    def test_create(self):
        result = self.create(comment="Project files")
        self.assertTrue(result["changed"])
        path = self.share_path("Docs")
        self.assertEqual(self.dc.registry["Docs"], {
            "path": path, "read only": "no", "guest ok": "no", "inherit acls": "yes",
            "valid users": '@"SCHOOL\\Staff" @"SCHOOL\\Domain Users"',
            "read list": '@"SCHOOL\\Domain Users"', "comment": "Project files", "browseable": "yes",
        })
        self.assertIn("mkdir -p -- %s" % path, self.runner.commands)
        self.assertIn("chmod 2770 -- %s" % path, self.runner.commands)
        setfacl = [c for c in self.runner.commands if c.startswith("setfacl")]
        self.assertEqual(len(setfacl), 1)
        self.assertIn("g:3000010:rwX", setfacl[0])
        self.assertIn("g:100:r-X", setfacl[0])
        # Canonical names from the directory
        self.assertEqual([a["name"] for a in result["share"]["access"]], ["Staff", "Domain Users"])
        self.assertIsNone(result["diff"]["before"])
        # The ids come from the SIDs of the directory, not from the names
        self.assertIn(("Staff", "S-1-5-21-1-2-3-1108"), self.dc.id_lookups)
        self.assertNotIn(("Staff", None), self.dc.id_lookups)

    def test_no_change_on_second_run(self):
        self.create()
        path = self.share_path("Docs")
        self.runner.acls[path] = "\n".join(sorted(acl.expected_acl([("g", "3000010", "write"), ("g", "100", "read")])))
        os.makedirs(path)
        os.chmod(path, 0o2770)
        shares = self.again()
        # ensure_root sees the mode, not the owner (tests do not run as root)
        shares._ensure_root = lambda p: False
        result = shares.set({"name": "docs", "access": [{"name": "Staff", "level": "write"}, {"name": "domain users"}]})
        self.assertFalse(result["changed"], self.runner.commands)
        self.assertEqual(self.runner.commands, [])

    def test_never_empty(self):
        self.create()
        with self.assertRaisesRegex(AddcError, "at least one user or group"):
            self.again().set({"name": "Docs", "access": [{"name": "Staff"}, {"name": "Domain Users"}],
                              "access_mode": "remove"})

    def test_unknown_principal_and_wrong_kind(self):
        with self.assertRaisesRegex(AddcError, "Unknown user or group: ghost"):
            self.shares.set({"name": "Docs", "access": [{"name": "ghost"}]})
        with self.assertRaisesRegex(AddcError, "Staff is a group, not a user"):
            self.shares.set({"name": "Docs", "access": [{"name": "staff", "kind": "user"}]})
        with self.assertRaisesRegex(AddcError, "Invalid account name"):
            self.shares.set({"name": "Docs", "access": [{"name": "-x"}]})
        self.assertEqual(self.runner.commands, [])

    def test_unmanaged_share_untouched(self):
        self.dc.registry["Home"] = {"path": "/srv/samba/home"}
        self.dc.registry["Odd"] = {"path": "/data/odd"}
        with self.assertRaisesRegex(AddcError, "not managed by addcctl"):
            self.shares.set({"name": "odd", "access": [{"name": "Staff"}]})
        self.assertEqual(self.shares.list(), [])

    def test_append_and_downgrade(self):
        self.create()
        result = self.again().set({"name": "Docs", "access": [{"name": "mrossi", "level": "write"},
                                                               {"name": "Staff", "level": "read"}],
                                   "access_mode": "append"})
        self.assertEqual([(a["name"], a["level"]) for a in result["share"]["access"]],
                         [("Staff", "read"), ("Domain Users", "read"), ("mrossi", "write")])
        self.assertEqual(self.dc.registry["Docs"]["read list"], '@"SCHOOL\\Staff" @"SCHOOL\\Domain Users"')
        setfacl = [c for c in self.runner.commands if c.startswith("setfacl")][0].split()
        removed, added = setfacl[3].split(","), setfacl[5].split(",")
        # Staff's entry as a user goes, its group entry becomes read-only
        self.assertIn("u:3000010", removed)
        self.assertIn("g:3000010:r-X", added)
        self.assertNotIn("g:3000010:rwX", added)

    def test_check_mode_changes_nothing(self):
        self.runner.check = True
        result = self.create()
        self.assertTrue(result["changed"])
        self.assertEqual(self.dc.registry, {})
        self.assertTrue(any(c.startswith("setfacl") for c in self.runner.commands))


class TestDrives(Base):
    def test_create_with_drive_then_update_without_reset(self):
        self.shares.set({"name": "Docs", "access": [{"name": "Staff", "level": "write"}],
                         "drive": {"letter": "p:"}})
        self.assertIn("samba-tool ntacl sysvolreset", self.runner.commands)
        [d] = self.drives()
        self.assertEqual((d["path"], d["letter"], d["label"]), ("\\\\DC\\Docs", "P", "Docs"))
        self.assertIn('sid="S-1-5-21-1-2-3-1108"', d["filters"])
        self.assertEqual(self.dc.gpo["version"], 65536)
        self.assertEqual(len(self.dc.linked), 1)

        # Access changes follow into the mapping; files exist now, no reset
        self.again().set({"name": "Docs", "access": [{"name": "mrossi"}], "access_mode": "append"})
        self.assertNotIn("samba-tool ntacl sysvolreset", self.runner.commands)
        [d] = self.drives()
        self.assertIn('sid="S-1-5-21-1-2-3-1200"', d["filters"])
        self.assertEqual(self.dc.gpo["version"], 2 * 65536)

    def test_letter_clash_before_any_change(self):
        self.shares.set({"name": "Docs", "access": [{"name": "Staff"}], "drive": {"letter": "P"}})
        shares = self.again()
        with self.assertRaisesRegex(AddcError, "already used by"):
            shares.set({"name": "Lab", "access": [{"name": "Staff"}], "drive": {"letter": "P"}})
        self.assertEqual(self.runner.commands, [])
        self.assertNotIn("Lab", self.dc.registry)
        for letter in ("H", "C", "1", ""):
            with self.assertRaisesRegex(AddcError, "Invalid drive letter"):
                shares.set({"name": "Lab", "access": [{"name": "Staff"}], "drive": {"letter": letter}})

    def test_remove_mapping_and_delete(self):
        self.shares.set({"name": "Docs", "access": [{"name": "Staff"}], "drive": {"letter": "P"}})
        self.shares.set({"name": "Lab", "access": [{"name": "Staff"}], "drive": {"letter": "L", "label": "Lab PCs"}})
        self.again().set({"name": "Docs", "drive": None})
        self.assertEqual([d["letter"] for d in self.drives()], ["L"])
        result = self.again().delete({"name": "lab", "delete_data": True})
        self.assertTrue(result["changed"])
        self.assertEqual(self.drives(), [])
        self.assertNotIn("Lab", self.dc.registry)
        # The folder is not on disk here, so rm is not needed
        self.assertEqual(self.again().delete({"name": "lab"}), {"changed": False, "diff": {"before": None, "after": None}})

    def test_rename_principal(self):
        self.shares.set({"name": "Docs", "access": [{"name": "mrossi", "level": "write"}], "drive": {"letter": "P"}})
        PRINCIPALS["mario.rossi"] = dict(PRINCIPALS["mrossi"], name="mario.rossi")
        self.addCleanup(PRINCIPALS.pop, "mario.rossi")
        result = self.again().rename_principal({"kind": "user", "old": "MROSSI", "new": "mario.rossi"})
        self.assertEqual(result, {"changed": True, "shares": ["Docs"]})
        self.assertEqual(self.dc.registry["Docs"]["valid users"], '"SCHOOL\\mario.rossi"')
        self.assertIn('name="SCHOOL\\mario.rossi"', self.drives()[0]["filters"])


class TestStaleEntries(Base):
    """An account deleted after it was given access stays in the share (an
    empty list would open it to every domain user): marked, kept, removable."""

    def setUp(self):
        super().setUp()
        PRINCIPALS["gbianchi"] = {"name": "gbianchi", "kind": "user", "sid": "S-1-5-21-1-2-3-1201"}
        POSIX["gbianchi"] = {"u": "3000021", "g": "3000021"}
        self.shares.set({"name": "Docs", "access": [{"name": "Staff", "level": "write"}, {"name": "gbianchi"}],
                         "drive": {"letter": "P"}})
        del PRINCIPALS["gbianchi"], POSIX["gbianchi"]

    def test_marked_unknown(self):
        [share] = self.again().list()
        self.assertEqual(share["access"], [{"name": "Staff", "kind": "group", "level": "write"},
                                           {"name": "gbianchi", "kind": "user", "level": "read", "unknown": True}])
        self.assertEqual(self.again().get("docs")["access"], share["access"])
        self.assertEqual(self.again().listing("user", "GBIANCHI"), ["Docs"])
        self.assertEqual(self.again().listing("group", "gbianchi"), [])

    def test_kept_by_other_changes(self):
        result = self.again().set({"name": "Docs", "comment": "Files"})
        self.assertEqual(result["share"]["access"][1], {"name": "gbianchi", "kind": "user", "level": "read",
                                                        "unknown": True})
        self.assertIn('"SCHOOL\\gbianchi"', self.dc.registry["Docs"]["valid users"])
        # The full list sent back, as the page does, with the stale entry in it
        self.again().set({"name": "Docs", "access": [{"name": "Staff", "level": "write"}, {"name": "gbianchi"},
                                                     {"name": "mrossi"}]})
        self.assertIn("mrossi", self.dc.registry["Docs"]["valid users"])
        # Not in the drive mapping, whose targets need a SID
        self.assertNotIn("gbianchi", self.drives()[0]["filters"])
        # A new unknown name is still refused
        with self.assertRaisesRegex(AddcError, "Unknown user or group: ghost"):
            self.again().set({"name": "Docs", "access": [{"name": "ghost"}], "access_mode": "append"})

    def test_removed(self):
        self.again().set({"name": "Docs", "access": [{"name": "gbianchi"}], "access_mode": "remove"})
        self.assertEqual(self.dc.registry["Docs"]["valid users"], '@"SCHOOL\\Staff"')
        self.assertNotIn("read list", self.dc.registry["Docs"])

    def test_drive_needs_an_existing_target(self):
        # Only the stale entry would be left: a mapping with no target would
        # reach every user. Refused before anything changes.
        shares = self.again()
        with self.assertRaisesRegex(AddcError, "at least one existing user or group"):
            shares.set({"name": "Docs", "access": [{"name": "Staff"}], "access_mode": "remove"})
        self.assertEqual(self.runner.commands, [])
        self.again().set({"name": "Docs", "access": [{"name": "Staff"}], "access_mode": "remove", "drive": None})
        self.assertEqual(self.drives(), [])
        self.assertEqual(self.dc.registry["Docs"]["valid users"], '"SCHOOL\\gbianchi"')


class TestPosixIds(unittest.TestCase):
    """Dc resolves ids by SID through wbinfo: winbind's cache of names keeps
    the SID of a deleted account, which a new one with its name would get."""

    class Wbinfo(Runner):
        def __init__(self):
            super().__init__()
            self.ids = {("--sid-to-uid", "S-1-5-21-1-2-3-1200"): "3000020",
                        ("--sid-to-gid", "S-1-5-21-1-2-3-1200"): "3000020",
                        ("--sid-to-gid", "S-1-5-21-1-2-3-1108"): "3000010"}
            self.calls = []

        def query(self, args, input=None, ok=(0,)):
            self.calls.append(args)
            return self.ids.get((args[1], args[2]), "")

    def test_by_sid(self):
        from addcctl.dc import Dc
        runner = self.Wbinfo()
        dc = Dc(runner)
        self.assertEqual(dc.posix_ids("Staff", "S-1-5-21-1-2-3-1108"), {"g": "3000010"})
        self.assertEqual(dc.posix_ids("mrossi", "S-1-5-21-1-2-3-1200"), {"u": "3000020", "g": "3000020"})
        dc.posix_ids("staff", "S-1-5-21-1-2-3-1108")
        self.assertEqual(len(runner.calls), 4, "cached by SID")
        self.assertEqual(runner.calls[0], ["wbinfo", "--sid-to-uid", "S-1-5-21-1-2-3-1108"])

    def test_account_by_sid(self):
        from unittest import mock
        from addcctl.dc import Dc
        dc = Dc(self.Wbinfo())
        entry = mock.Mock(pw_uid=3000020, pw_gid=100)
        with mock.patch("pwd.getpwuid", return_value=entry) as getpwuid, mock.patch("pwd.getpwnam") as getpwnam:
            self.assertEqual(dc.posix_account("mrossi", "S-1-5-21-1-2-3-1200"), (3000020, 100))
            getpwuid.assert_called_once_with(3000020)
            getpwnam.assert_not_called()
            self.assertIsNone(dc.posix_account("ghost", "S-1-5-21-1-2-3-9"))


class TestWriteFile(unittest.TestCase):
    def test_keeps_attributes_of_the_old_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "GPT.INI")
            runner = Runner()
            self.assertFalse(runner.write_file(path, "v1"))
            os.chmod(path, 0o600)
            self.assertTrue(runner.write_file(path, "v2"))
            with open(path) as f:
                self.assertEqual(f.read(), "v2")
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertFalse(os.path.exists(path + ".tmp"))


class TestCli(unittest.TestCase):
    class Stdin(io.StringIO):
        def isatty(self):
            return False

    def call(self, argv, data):
        out = io.StringIO()
        import contextlib
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = run(argv, self.Stdin(data))
        return code, json.loads(out.getvalue())

    def test_schema_errors(self):
        code, out = self.call(["share", "set"], '{"access": [{"name": "a", "level": "x"}], "foo": 1}')
        self.assertEqual(code, 2)
        self.assertEqual(out["error"], "Invalid input: input.name is required; input.access[0].level must be one "
                                       "of read, write; input.foo is not a known setting")

    def test_not_json_and_unknown_operation(self):
        self.assertEqual(self.call(["share", "set"], "{")[0], 2)
        code, out = self.call(["share", "fly"], "{}")
        self.assertEqual(code, 2)
        self.assertIn("Unknown operation share fly", out["error"])

    def test_schema_lists_operations(self):
        code, out = self.call(["schema"], "")
        self.assertEqual(code, 0)
        for op in ("share set", "user create", "group set", "computer delete", "home provision",
                   "domain password-policy"):
            self.assertIn(op, out)
        self.assertTrue(out["share set"]["mutates"])
        self.assertFalse(out["user list"]["mutates"])
        # Secrets are marked, so that the interfaces can hide them
        self.assertTrue(out["user create"]["input"]["properties"]["password"]["writeOnly"])


if __name__ == "__main__":
    unittest.main()
