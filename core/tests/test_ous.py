# SPDX-License-Identifier: LGPL-2.1-or-later
import unittest

from addcctl import ad
from addcctl.accounts import Computers, Groups, Users
from addcctl.cli import execute
from addcctl.errors import AddcError
from addcctl.operations import OPERATIONS
from addcctl.ous import Ous

from test_accounts import BASE, Base, user
from test_shares import FakeRunner


class TestDnHelpers(unittest.TestCase):
    def test_split_keeps_escaped_commas(self):
        self.assertEqual(ad.split_dn(r"CN=Rossi\, Mario,OU=A\\,DC=x"), [r"CN=Rossi\, Mario", "OU=A\\\\", "DC=x"])
        self.assertEqual(ad.parent_dn(r"CN=Rossi\, Mario,OU=School,DC=x"), "OU=School,DC=x")

    def test_relative(self):
        self.assertEqual(ad.relative_dn("OU=A," + BASE, BASE), "OU=A")
        self.assertEqual(ad.relative_dn(BASE.upper(), BASE), "")
        self.assertTrue(ad.is_under("OU=B,OU=A," + BASE, "ou=a," + BASE))
        self.assertFalse(ad.is_under("OU=XA," + BASE, "OU=A," + BASE))


class TestOus(Base):
    def ous(self):
        return Ous(self.dc, self.runner)

    def test_list_parents_first_with_default_containers(self):
        listed = self.ous().list()
        self.assertEqual([o["dn"] for o in listed],
                         ["CN=Computers", "OU=Domain Controllers", "OU=School", "OU=Students,OU=School", "CN=Users"])
        by_dn = {o["dn"]: o for o in listed}
        self.assertEqual(by_dn["CN=Users"]["default_for"], "users")
        self.assertTrue(by_dn["OU=Domain Controllers"]["builtin"])
        self.assertEqual(by_dn["OU=Students,OU=School"],
                         {"dn": "OU=Students,OU=School", "name": "Students", "description": "", "parent": "OU=School",
                          "kind": "ou", "builtin": False, "default_for": None})

    def test_create(self):
        result = self.ous().create({"name": "Classe 1A", "parent": "OU=Students,OU=School", "description": "x"})
        self.assertEqual(result["ou"]["dn"], "OU=Classe 1A,OU=Students,OU=School")
        self.assertEqual(result["ou"]["description"], "x")
        with self.assertRaisesRegex(AddcError, "already exists"):
            self.ous().create({"name": "School"})
        with self.assertRaisesRegex(AddcError, "cannot be put in CN=Users"):
            self.ous().create({"name": "X", "parent": "CN=Users"})
        with self.assertRaisesRegex(AddcError, "cannot be put in OU=Domain Controllers"):
            self.ous().create({"name": "X", "parent": "OU=Domain Controllers"})
        with self.assertRaisesRegex(AddcError, "not found"):
            self.ous().create({"name": "X", "parent": "OU=Ghost"})
        with self.assertRaisesRegex(AddcError, "Invalid OU name"):
            self.ous().create({"name": " X"})
        with self.assertRaisesRegex(AddcError, "Invalid DN"):
            self.ous().create({"name": "X", "parent": "DC=other"})

    def test_rename_and_move_with_contents(self):
        self.dc.users.append(user("s1", "1301"))
        self.dc.users[-1]["dn"] = ["CN=s1,OU=Students,OU=School," + BASE]
        result = self.ous().set({"dn": "OU=Students,OU=School", "new_name": "Pupils", "parent": ""})
        self.assertEqual(self.dc.calls, [("rename", "OU=Students,OU=School," + BASE, "OU=Pupils," + BASE)])
        self.assertEqual(result["ou"]["dn"], "OU=Pupils")
        self.assertEqual(Users(self.dc, self.runner).get("s1")["container"], "OU=Pupils")
        with self.assertRaisesRegex(AddcError, "into itself"):
            self.ous().set({"dn": "OU=School", "parent": "OU=School"})
        self.ous().create({"name": "Inner", "parent": "OU=School"})
        with self.assertRaisesRegex(AddcError, "into itself"):
            self.ous().set({"dn": "OU=School", "parent": "OU=Inner,OU=School"})
        with self.assertRaisesRegex(AddcError, "already exists"):
            self.ous().set({"dn": "OU=Pupils", "new_name": "School"})

    def test_description_only(self):
        result = self.ous().set({"dn": "CN=Users", "description": "Everyone"})
        self.assertTrue(result["changed"])
        self.assertEqual(self.dc.modified, [("CN=Users," + BASE, {"description": "Everyone"})])
        self.assertFalse(self.ous().set({"dn": "OU=School", "new_name": "School", "parent": ""})["changed"])

    def test_check_mode_changes_nothing(self):
        runner = FakeRunner(check=True)
        self.dc.runner = runner
        result = Ous(self.dc, runner).set({"dn": "OU=School", "new_name": "Scuola"})
        self.assertEqual(result["ou"]["dn"], "OU=Scuola")
        self.assertEqual(self.ous().get("OU=School")["name"], "School")

    def test_built_in_containers(self):
        for dn in ("CN=Users", "CN=Computers", "OU=Domain Controllers"):
            with self.assertRaisesRegex(AddcError, "built-in container"):
                self.ous().set({"dn": dn, "new_name": "X"})
            with self.assertRaisesRegex(AddcError, "built-in container"):
                self.ous().delete({"dn": dn, "recursive": True})
        with self.assertRaisesRegex(AddcError, "not found"):
            self.ous().get("CN=System")
        self.assertEqual(self.dc.calls, [])

    def test_delete(self):
        self.assertFalse(self.ous().delete({"dn": "OU=Ghost"})["changed"])
        with self.assertRaisesRegex(AddcError, r"not empty \(1 objects\)"):
            self.ous().delete({"dn": "OU=School"})
        self.dc.users.append(user("s1", "1301"))
        self.dc.users[-1]["dn"] = ["CN=s1,OU=Students,OU=School," + BASE]
        self.dc.computers[0]["dn"] = ["CN=PC01,OU=School," + BASE]
        result = self.ous().delete({"dn": "OU=School", "recursive": True})
        self.assertEqual(result["deleted_accounts"], ["PC01$", "s1"])
        # The computer with its DNS records
        self.assertEqual(self.dc.calls, [("samba-tool", "computer", "delete", "PC01"),
                                         ("delete", "OU=School," + BASE, True)])
        self.assertIsNone(self.dc.entry("CN=s1,OU=Students,OU=School," + BASE, []))

    def test_delete_refuses_protected_contents(self):
        self.dc.users[0]["dn"] = ["CN=Administrator,OU=School," + BASE]
        with self.assertRaisesRegex(AddcError, "holds CN=Administrator,OU=School"):
            self.ous().delete({"dn": "OU=School", "recursive": True})
        self.assertEqual(self.dc.calls, [])


class TestAccountsInOus(Base):
    def test_containers_listed(self):
        self.assertEqual(Users(self.dc, self.runner).get("mrossi")["container"], "CN=Users")
        computers = {c["name"]: c for c in Computers(self.dc, self.runner).list()}
        self.assertEqual(computers["PC01"]["container"], "CN=Computers")
        self.assertTrue(computers["DC"]["domain_controller"])
        self.assertFalse(computers["PC01"]["domain_controller"])

    def test_create_in_an_ou(self):
        Users(self.dc, self.runner).create({"name": "t-new", "password": "x", "ou": "ou=students,ou=school"})
        Groups(self.dc, self.runner).create({"name": "t-g", "ou": "OU=School," + BASE})
        Computers(self.dc, self.runner).create({"name": "PC09", "ou": "CN=Computers"})
        self.assertEqual(self.dc.calls[0], ("new_user", "t-new", "OU=Students,OU=School"))
        self.assertEqual(self.dc.calls[1], ("new_group", "t-g", 2147483650, "OU=School"))
        self.assertEqual(self.dc.calls[2], ("new_computer", "PC09", "CN=Computers"))
        with self.assertRaisesRegex(AddcError, "cannot be put in OU=Domain Controllers"):
            Computers(self.dc, self.runner).create({"name": "PC10", "ou": "OU=Domain Controllers"})
        with self.assertRaisesRegex(AddcError, "not found"):
            Users(self.dc, self.runner).create({"name": "t-2", "password": "x", "ou": "OU=Ghost"})

    def test_move(self):
        result = Users(self.dc, self.runner).set({"name": "mrossi", "ou": "OU=School"})
        self.assertTrue(result["changed"])
        self.assertEqual(result["user"]["container"], "OU=School")
        self.assertEqual(self.dc.calls, [("rename", "CN=mrossi,CN=Users," + BASE, "CN=mrossi,OU=School," + BASE)])
        # Already there
        self.assertFalse(Users(self.dc, self.runner).set({"name": "mrossi", "ou": "ou=school"})["changed"])
        result = Groups(self.dc, self.runner).set({"name": "Teachers", "ou": "OU=School"})
        self.assertEqual(result["group"]["container"], "OU=School")
        result = Computers(self.dc, self.runner).set({"name": "PC01$", "ou": "OU=School", "description": "lab"})
        self.assertEqual(self.dc.modified[-1], ("CN=PC01,CN=Computers," + BASE, {"description": "lab"}))
        self.assertTrue(result["changed"])

    def test_move_with_rename(self):
        Users(self.dc, self.runner).set({"name": "mrossi", "new_name": "mario.rossi", "ou": "OU=School"})
        self.assertEqual(self.dc.calls[-1], ("rename", "CN=mrossi,CN=Users," + BASE, "CN=mrossi,OU=School," + BASE))

    def test_built_in_objects_stay(self):
        with self.assertRaisesRegex(AddcError, "built-in account"):
            Users(self.dc, self.runner).set({"name": "Administrator", "ou": "OU=School"})
        with self.assertRaisesRegex(AddcError, "built-in group"):
            Groups(self.dc, self.runner).set({"name": "Domain Users", "ou": "OU=School"})
        with self.assertRaisesRegex(AddcError, "domain controller"):
            Computers(self.dc, self.runner).set({"name": "DC", "ou": "OU=School"})
        # Where they are already: nothing to refuse
        self.assertFalse(Users(self.dc, self.runner).set({"name": "Administrator", "ou": "CN=Users"})["changed"])
        self.assertEqual(self.dc.calls, [])


class TestSchemas(unittest.TestCase):
    def test_operations_validate(self):
        with self.assertRaisesRegex(AddcError, "input.name is required"):
            execute(OPERATIONS[("ou", "create")], {}, check=True)
        with self.assertRaisesRegex(AddcError, "recursive must be boolean"):
            execute(OPERATIONS[("ou", "delete")], {"dn": "OU=A", "recursive": "yes"}, check=True)


if __name__ == "__main__":
    unittest.main()
