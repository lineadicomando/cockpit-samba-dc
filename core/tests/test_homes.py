# SPDX-License-Identifier: LGPL-2.1-or-later
import os
import tempfile
import unittest
from unittest import mock

from addcctl import homes
from addcctl.errors import AddcError
from addcctl.homes import Homes

from test_accounts import FakeDirDc, FakeRunner


class FakeHomeDc(FakeDirDc):
    registry_shares = True

    def __init__(self, runner):
        super().__init__(runner)
        self.uid = os.getuid()
        self.share_params = {}

    def posix_account(self, name, sid=None):
        return self.uid, os.getgid()

    def shares(self):
        return {"home": dict(self.share_params)} if self.share_params else {}

    def update_share(self, name, set_params, delete_params=(), create=False):
        self._do("update_share", name)
        self.share_params.update(set_params)


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        patcher = mock.patch.object(homes, "HOMES_DIR", self.dir)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.runner = FakeRunner()
        self.dc = FakeHomeDc(self.runner)

    def homes(self):
        return Homes(self.dc, self.runner)

    def mrossi(self):
        return self.dc.users[2]

    def folder(self, name):
        path = os.path.join(self.dir, name)
        os.makedirs(path)
        os.chmod(path, 0o700)
        return path


class TestProvision(Base):
    def test_new_folder(self):
        result = self.homes().provision({"name": "mrossi"})
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "mrossi")))
        self.assertEqual(result["home"]["unc"], "\\\\DC\\home\\mrossi")
        self.assertEqual(self.dc.modified[-1][1], {"homeDrive": "H:", "homeDirectory": "\\\\DC\\home\\mrossi"})

    def test_refused_without_registry_shares(self):
        self.dc.registry_shares = False
        with self.assertRaisesRegex(AddcError, 'set "registry shares = yes"'):
            self.homes().provision({"name": "mrossi"})
        self.assertEqual(os.listdir(self.dir), [])

    def test_a_renamed_user_keeps_its_folder(self):
        # mrossi was "rossi.m": homeDirectory still names that folder
        self.folder("rossi.m")
        self.mrossi()["homeDirectory"] = ["\\\\DC\\home\\rossi.m"]
        self.mrossi()["homeDrive"] = ["H:"]
        result = self.homes().provision({"name": "mrossi"})
        self.assertEqual(result["home"]["path"], os.path.join(self.dir, "rossi.m"))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "mrossi")))
        self.assertEqual(self.dc.modified, [])

    def test_another_accounts_folder_is_not_taken(self):
        # Left by an account that had this name (deleted, or renamed)
        self.folder("mrossi")
        self.dc.uid = os.getuid() + 1
        with self.assertRaisesRegex(AddcError, "belongs to another account"):
            self.homes().provision({"name": "mrossi"})
        self.assertEqual(self.dc.modified, [])


class TestDelete(Base):
    def test_follows_home_directory(self):
        path = self.folder("rossi.m")
        self.mrossi()["homeDirectory"] = ["\\\\DC\\home\\rossi.m"]
        self.homes().delete({"name": "mrossi", "delete_data": True})
        self.assertIn("rm -rf --one-file-system -- %s" % path, self.runner.commands)

    def test_another_accounts_folder_is_not_deleted(self):
        self.folder("mrossi")
        self.dc.uid = os.getuid() + 1
        with self.assertRaisesRegex(AddcError, "belongs to another account"):
            self.homes().delete({"name": "mrossi", "delete_data": True})
        self.assertEqual((self.dc.modified, self.runner.commands), ([], []))

    def test_elsewhere_is_not_followed(self):
        path = self.folder("mrossi")
        self.mrossi()["homeDirectory"] = ["\\\\FILER\\home\\x"]
        self.homes().delete({"name": "mrossi", "delete_data": True})
        self.assertIn("rm -rf --one-file-system -- %s" % path, self.runner.commands)


if __name__ == "__main__":
    unittest.main()
