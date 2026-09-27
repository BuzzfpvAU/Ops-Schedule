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
             mock.patch.object(s, "post_inventory", return_value={"t2"}), \
             mock.patch.object(s, "push", return_value=True):
            s.main([])
        account.fetch_location.assert_called_once_with([b])


if __name__ == "__main__":
    unittest.main()
