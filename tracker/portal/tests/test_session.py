import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from portal.session import ExportSession, SessionConfig, slugify

HERE = Path(__file__).parent
FAKE = [sys.executable, str(HERE / "fake_exporter.py")]
ITEMS = [
    {"name": "Drone case", "identifier": "2006~#aa~#SER1", "emoji": "🧳"},
    {"name": "Sam's iPhone", "model": "iPhone13,4", "identifier": "me:/x"},
]


class FakeClient:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        def rec(*a):
            self.calls.append((name, a))
            return {"status": "ok"}
        return rec


class Session(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        tpl = self.root / "device-profile.template.toml"
        tpl.write_text('[device]\nname = "FindMy Export"\nserial = "F2LZN0FAKE00"\n')
        os.environ["FAKE_ITEMS"] = json.dumps(ITEMS)
        os.environ["FAKE_SCENARIO"] = "ok"
        self.client = FakeClient()
        self.cfg = SessionConfig(exporter_argv=FAKE, template_profile=tpl,
                                 shared_root=self.root / "shared", work_root=self.root / "work",
                                 silence_timeout=10)
        self.s = ExportSession({"id": "inv123456", "label": "Sam – WA"}, "sam@example.com", self.cfg, self.client)

    def run_to_choose(self):
        self.assertEqual(self.s.start()["step"], "need_password")
        self.s.answer("pw"); self.s.answer("0"); self.s.answer("123456")
        return self.s.answer("1234")

    def test_slug(self):
        self.assertEqual(slugify("Sam – WA!", "inv123456"), "sam-wa-inv123")

    def test_profile_has_unique_serial_and_clear_name(self):
        self.s.start()
        text = (self.s.tmp / "profile.toml").read_text()
        self.assertIn('name = "Taskz Tag Export"', text)
        self.assertNotIn("F2LZN0FAKE00", text)
        self.assertIn(f'serial = "{self.s.serial}"', text)
        self.assertEqual(oct(self.s.tmp.stat().st_mode & 0o777), "0o700")

    def test_choose_defaults_tags_on_devices_off(self):
        st = self.run_to_choose()
        self.assertEqual(st["step"], "choose")
        by = {i["name"]: i for i in st["items"]}
        self.assertTrue(by["Drone case"]["checked"])
        self.assertEqual(by["Sam's iPhone"]["kind"], "device")
        self.assertFalse(by["Sam's iPhone"]["checked"])

    def test_save_keeps_only_ticked_and_reports_them(self):
        st = self.run_to_choose()
        keep = [i["file"] for i in st["items"] if i["name"] == "Drone case"]
        st = self.s.save(keep)
        self.assertEqual(st["step"], "done")
        self.assertEqual(st["remove_device"], "Taskz Tag Export")
        keys = self.root / "shared" / "sam-wa-inv123" / "keys"
        self.assertEqual(sorted(p.suffix for p in keys.iterdir()), [".json", ".plist"])
        self.assertEqual(oct(keys.stat().st_mode & 0o777), "0o700")
        inv = [c for c in self.client.calls if c[0] == "inventory"][0][1][0]
        self.assertEqual([r["name"] for r in inv], ["Drone case"])
        self.assertEqual(inv[0]["account"], "shared/sam-wa-inv123")
        self.assertIn(("complete", ("inv123456", 1)), self.client.calls)
        self.assertFalse(self.s.tmp.exists(), "temp dir removed")

    def test_cleanup_deletes_bottle_after_passcode(self):
        self.run_to_choose()
        os.environ["FAKE_BOTTLE_SERIALS"] = f"REAL1,{self.s.serial}"
        self.s.save([])
        self.assertFalse(any(c[0] == "cleanup_failed" for c in self.client.calls))

    def test_cleanup_failure_is_reported(self):
        self.run_to_choose()
        os.environ["FAKE_BOTTLE_SERIALS"] = "REAL1"
        self.s.save([])
        self.assertTrue(any(c[0] == "cleanup_failed" for c in self.client.calls))

    def test_one_password_retry_then_failure(self):
        os.environ["FAKE_SCENARIO"] = "bad_password"
        self.s.start()
        st = self.s.answer("pw")
        self.assertEqual((st["step"], st.get("message")), ("need_password", "Apple didn't accept that password."))
        st = self.s.answer("pw")
        self.assertEqual((st["step"], st["error"]), ("error", "bad_password"))
        self.assertIn(("failed", ("inv123456", "bad_password")), self.client.calls)
        self.assertFalse(self.s.tmp.exists())

    def test_idle_reap_cleans_up(self):
        self.s.start()
        self.assertTrue(self.s.reap(now=self.s.last_touch + 601))
        self.assertEqual(self.s.state["error"], "timeout")
        self.assertFalse(self.s.tmp.exists())

    def test_attempt_recorded_on_start(self):
        self.s.start()
        self.assertEqual(self.client.calls[0], ("attempt", ("inv123456",)))

    def test_exporter_that_cannot_start_fails_cleanly(self):
        cfg = SessionConfig(exporter_argv=["/nonexistent/export-findmy"], template_profile=self.cfg.template_profile,
                            shared_root=self.root / "shared", work_root=self.root / "work")
        s = ExportSession({"id": "inv999999", "label": "X"}, "x@example.com", cfg, self.client)
        st = s.start()
        self.assertEqual((st["step"], st["error"]), ("error", "unknown"))
        self.assertIn(("failed", ("inv999999", "unknown")), self.client.calls)
        self.assertFalse(s.tmp.exists())

    def test_taskz_outage_does_not_block_cleanup(self):
        class Down:
            def __getattr__(self, name):
                def boom(*a):
                    raise OSError("network down")
                return boom
        s = ExportSession({"id": "inv777777", "label": "Y"}, "y@example.com", self.cfg, Down())
        s.start(); s.answer("pw"); s.answer("0"); s.answer("123456")
        st = s.answer("1234")
        st = s.save([st["items"][0]["file"]])
        self.assertEqual(st["step"], "done")
        self.assertFalse(s.tmp.exists())

    def tearDown(self):
        for k in ("FAKE_BOTTLE_SERIALS",):
            os.environ.pop(k, None)


if __name__ == "__main__":
    unittest.main()
