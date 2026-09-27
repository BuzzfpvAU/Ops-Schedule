import json
import os
import sys
import tempfile
import unittest

from portal.exporter_driver import ExporterDriver, delete_bottle

FAKE = [sys.executable, os.path.join(os.path.dirname(__file__), "fake_exporter.py")]
ITEMS = json.dumps([
    {"name": "Drone case", "identifier": "2006~#aa~#SER1", "emoji": "🧳"},
    {"name": "Sam's iPhone", "model": "iPhone13,4", "identifier": "me:/x"},
])


def driver(scenario, tmp, silence=10, items=ITEMS):
    env = dict(os.environ, FAKE_SCENARIO=scenario, FAKE_ITEMS=items)
    return ExporterDriver(FAKE + ["--output-dir", tmp], env, silence_timeout=silence)


class Driver(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_happy_path(self):
        d = driver("ok", self.tmp)
        self.assertEqual(d.start().kind, "need_password")
        s = d.answer("pw")
        self.assertEqual(s.kind, "need_2fa_method")
        self.assertEqual(s.options, [{"index": 0, "label": "Trusted Device"}])
        self.assertEqual(d.answer("0").kind, "need_code")
        s = d.answer("123456")
        self.assertEqual(s.kind, "need_passcode")
        self.assertEqual(s.device, "Sam's iPhone (iPhone)")
        self.assertFalse(d.passcode_sent)
        self.assertEqual(d.answer("1234").kind, "finished")
        self.assertTrue(d.passcode_sent)
        self.assertEqual(len([f for f in os.listdir(self.tmp) if f.endswith(".json")]), 2)

    def test_sms_and_two_bottles(self):
        d = driver("sms", self.tmp)
        d.start()
        s = d.answer("pw")
        self.assertEqual([o["label"] for o in s.options], ["Trusted Device", "SMS (•••• •••• 12)"])
        d = driver("two_bottles", self.tmp)
        d.start(); d.answer("pw"); d.answer("0")
        s = d.answer("123456")
        self.assertEqual(s.kind, "need_bottle")
        self.assertEqual(len(s.options), 2)
        self.assertEqual(d.answer("1").device, "Sam's iPad (iPad)")

    def test_errors_are_classified(self):
        cases = {"bad_password": "bad_password", "hardware_key": "hardware_key",
                 "unavailable": "apple_unavailable", "no_bottles": "no_bottles"}
        for sc, want in cases.items():
            d = driver(sc, self.tmp)
            s = d.start()
            if s.kind == "need_password":
                s = d.answer("pw")
            if s.kind == "need_2fa_method":
                s = d.answer("0"); s = d.answer("123456")
            self.assertEqual((s.kind, s.error), ("error", want), sc)

    def test_wrong_code(self):
        d = driver("ok", self.tmp)
        d.start(); d.answer("pw"); d.answer("0")
        s = d.answer("000000")
        self.assertEqual((s.kind, s.error), ("error", "bad_code"))

    def test_no_items(self):
        d = driver("no_items", self.tmp)
        d.start(); d.answer("pw"); d.answer("0"); d.answer("123456")
        self.assertEqual(d.answer("1234").kind, "no_items")

    def test_silence_is_apple_unavailable(self):
        d = driver("hang", self.tmp, silence=1)
        s = d.start()
        self.assertEqual((s.kind, s.error), ("error", "apple_unavailable"))
        d.close()

    def test_delete_bottle_by_serial(self):
        env = dict(os.environ, FAKE_BOTTLE_SERIALS="REAL1,TZSESSION1")
        ok, _ = delete_bottle(FAKE, env, "TZSESSION1")
        self.assertTrue(ok)
        ok, why = delete_bottle(FAKE, env, "NOTTHERE")
        self.assertFalse(ok)
        self.assertIn("not found", why)


if __name__ == "__main__":
    unittest.main()
