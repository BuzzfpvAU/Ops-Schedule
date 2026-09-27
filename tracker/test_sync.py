import unittest
from unittest import mock

import sync_airtags as s


class Classify(unittest.TestCase):
    def test_tags(self):
        self.assertEqual(s.classify("", "2006~#00640403848084a0~#HGLJLL3SP0GV"), "tag")
        self.assertEqual(s.classify(None, "kmart-smart-tag-1"), "tag")

    def test_devices(self):
        self.assertEqual(s.classify("Mac17,2", "l:/00008142-001929502E22401C"), "device")
        self.assertEqual(s.classify("iPhone13,4", "me:/000332-10-abc"), "device")
        self.assertEqual(s.classify("iPad13,11", "x"), "device")
        self.assertEqual(s.classify("Watch6,1", "x"), "device")
        self.assertEqual(s.classify("AirPods3,1", "x"), "device")
        self.assertEqual(s.classify("", "l:/abc"), "device")


class InventoryRows(unittest.TestCase):
    def test_rows_carry_metadata(self):
        acc = mock.Mock(identifier="t1", model="", serial_number="SER")
        acc.name = "Grant’s Car"
        rows = s.inventory_rows("droneops", [(acc, {"emoji": "🚖"})])
        self.assertEqual(rows, [{
            "identifier": "t1", "account": "droneops", "name": "Grant’s Car", "emoji": "🚖",
            "model": "", "serial_number": "SER", "kind": "tag",
        }])


class InventoryFailure(unittest.TestCase):
    def test_failed_inventory_fetches_nothing(self):
        acc = mock.Mock(identifier="t1", model="", serial_number="")
        acc.name = "Tag"
        account = mock.Mock()
        with mock.patch.object(s, "INGEST_KEY", "k"), \
             mock.patch.object(s, "list_accounts", return_value=[mock.Mock(name_="x")]), \
             mock.patch.object(s, "load_account", return_value=(account, [(acc, {})])), \
             mock.patch.object(s, "post_inventory", return_value=None), \
             mock.patch.object(s, "push") as push:
            code = s.main([])
        account.fetch_location.assert_not_called()
        push.assert_not_called()
        self.assertEqual(code, 1)

    def test_only_included_are_fetched(self):
        a = mock.Mock(identifier="t1", model="", serial_number="")
        a.name = "A"
        b = mock.Mock(identifier="t2", model="", serial_number="")
        b.name = "B"
        account = mock.Mock()
        account.fetch_location.return_value = {}
        acct_dir = mock.Mock()
        acct_dir.name = "droneops"
        with mock.patch.object(s, "INGEST_KEY", "k"), \
             mock.patch.object(s, "list_accounts", return_value=[acct_dir]), \
             mock.patch.object(s, "load_account", return_value=(account, [(a, {}), (b, {})])), \
             mock.patch.object(s, "post_inventory", return_value={"included": {"t2"}, "remove": set()}), \
             mock.patch.object(s, "push", return_value=True):
            s.main([])
        account.fetch_location.assert_called_once_with([b])


import tempfile
from pathlib import Path


class SharedAccounts(unittest.TestCase):
    def test_shared_dirs_are_listed_with_prefix(self):
        root = Path(tempfile.mkdtemp())
        (root / "droneops").mkdir()
        (root / "shared" / "sam-wa-abc123" / "keys").mkdir(parents=True)
        with mock.patch.object(s, "ACCOUNTS_ROOT", root):
            names = [s.slug_of(p) for p in s.list_accounts()]
        self.assertEqual(names, ["droneops", "shared/sam-wa-abc123"])

    def test_portal_health_reports_down_when_unreachable(self):
        with mock.patch.object(s, "PORTAL_URL", "http://127.0.0.1:9"):
            self.assertEqual(s.portal_health(), {"ok": False, "version": ""})

class SharedSession(unittest.TestCase):
    def test_shared_fetch_never_writes_a_session_copy(self):
        account = mock.Mock()
        account.fetch_location.return_value = {}
        s.fetch_account("shared/sam-wa-abc123", account, [mock.Mock()])
        account.to_json.assert_not_called()
        s.fetch_account("droneops", account, [mock.Mock()])
        account.to_json.assert_called_once()


class RemoveKeys(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        k = self.root / "droneops" / "keys"
        k.mkdir(parents=True)
        for n in ("a", "b"):
            (k / f"{n}.json").write_text("{}")
            (k / f"{n}.plist").write_text("x")
        (self.root / "droneops" / "account.json").write_text("{}")
        self.k = k

    def test_deletes_only_that_tags_pair(self):
        with mock.patch.object(s, "ACCOUNTS_ROOT", self.root):
            self.assertTrue(s.delete_key_files(self.k / "a.json"))
        self.assertEqual(sorted(p.name for p in self.k.iterdir()), ["b.json", "b.plist"])
        self.assertTrue((self.root / "droneops" / "account.json").exists())

    def test_refuses_anything_outside_accounts_or_not_a_key(self):
        outside = Path(tempfile.mkdtemp()) / "x.json"
        outside.write_text("{}")
        with mock.patch.object(s, "ACCOUNTS_ROOT", self.root):
            self.assertFalse(s.delete_key_files(outside))
            self.assertFalse(s.delete_key_files(self.root / "droneops" / "account.json"))
        self.assertTrue(outside.exists())

    def test_empty_shared_dir_is_removed(self):
        k = self.root / "shared" / "sam-abc123" / "keys"
        k.mkdir(parents=True)
        (k / "t.json").write_text("{}")
        with mock.patch.object(s, "ACCOUNTS_ROOT", self.root):
            s.delete_key_files(k / "t.json")
        self.assertFalse((self.root / "shared" / "sam-abc123").exists())

    def test_main_deletes_removed_and_does_not_fetch_them(self):
        acc = mock.Mock(identifier="t1", model="", serial_number="")
        acc.name = "Old tag"
        account = mock.Mock()
        acct_dir = mock.Mock()
        acct_dir.name = "droneops"
        acct_dir.parent.name = "accounts"
        with mock.patch.object(s, "ACCOUNTS_ROOT", self.root), \
             mock.patch.object(s, "INGEST_KEY", "k"), \
             mock.patch.object(s, "list_accounts", return_value=[acct_dir]), \
             mock.patch.object(s, "load_account", return_value=(account, [(acc, {"_path": str(self.k / "a.json")})])), \
             mock.patch.object(s, "post_inventory", return_value={"included": set(), "remove": {"t1"}}), \
             mock.patch.object(s, "portal_health", return_value={"ok": False, "version": ""}):
            s.main([])
        account.fetch_location.assert_not_called()
        self.assertFalse((self.k / "a.json").exists())

if __name__ == "__main__":
    unittest.main()
