import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

from portal.server import make_server
from portal.session import SessionConfig

HERE = Path(__file__).parent


class FakeTaskz:
    def __init__(self):
        self.calls = []

    def check(self, token):
        return {"ok": True, "id": "inv123456", "label": "Sam", "attempts_left": 3} if token == "good" else {"ok": False}

    def __getattr__(self, name):
        def rec(*a):
            self.calls.append((name, a))
            return {"status": "ok"}
        return rec


class Server(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp())
        tpl = root / "t.toml"
        tpl.write_text('[device]\nname = "x"\nserial = "y"\n')
        os.environ["FAKE_SCENARIO"] = "ok"
        os.environ["FAKE_ITEMS"] = json.dumps([{"name": "Case", "identifier": "2006~#a~#S"}])
        cfg = SessionConfig([sys.executable, str(HERE / "fake_exporter.py")], tpl, root / "shared", root / "work",
                            silence_timeout=10)
        self.taskz = FakeTaskz()
        self.httpd = make_server(cfg, self.taskz, port=0, secure_cookie=False)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def tearDown(self):
        self.httpd.shutdown()

    def get(self, path):
        return self.opener.open(self.base + path)

    def post(self, path, body=None):
        req = urllib.request.Request(self.base + path, data=json.dumps(body or {}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        return json.loads(self.opener.open(req).read())

    def state(self):
        return json.loads(self.get("/api/state").read())

    def test_bad_link_shows_expired(self):
        self.get("/i/bad")
        self.assertEqual(self.state()["step"], "expired")

    def test_full_flow_over_http(self):
        r = self.get("/i/good")
        self.assertIn("no-store", r.headers["Cache-Control"])
        self.assertEqual(self.state()["step"], "intro")
        self.assertEqual(self.post("/api/start", {"email": "sam@example.com"})["step"], "need_password")
        self.post("/api/answer", {"value": "pw"})
        self.post("/api/answer", {"value": "0"})
        self.post("/api/answer", {"value": "123456"})
        st = self.post("/api/answer", {"value": "1234"})
        self.assertEqual(st["step"], "choose")
        st = self.post("/api/save", {"files": [st["items"][0]["file"]]})
        self.assertEqual(st["step"], "done")

    def test_second_visitor_is_told_busy(self):
        self.get("/i/good")
        self.post("/api/start", {"email": "a@example.com"})
        other = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        other.open(self.base + "/i/good")
        req = urllib.request.Request(self.base + "/api/start", data=b'{"email":"b@example.com"}',
                                     headers={"Content-Type": "application/json"}, method="POST")
        self.assertEqual(json.loads(other.open(req).read())["step"], "busy")

    def test_no_cookie_no_session(self):
        req = urllib.request.Request(self.base + "/api/start", data=b'{"email":"x@y.z"}',
                                     headers={"Content-Type": "application/json"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req)
        self.assertEqual(e.exception.code, 403)

    def test_healthz(self):
        self.assertEqual(json.loads(self.get("/healthz").read())["ok"], True)


if __name__ == "__main__":
    unittest.main()


class Unreachable(unittest.TestCase):
    """taskz.id refusing or not answering must not drop the phone's request."""

    def serve(self, exc):
        root = Path(tempfile.mkdtemp())
        tpl = root / "t.toml"
        tpl.write_text('[device]\nname = "x"\nserial = "y"\n')
        cfg = SessionConfig([sys.executable, str(HERE / "fake_exporter.py")], tpl, root / "shared", root / "work")

        class Failing(FakeTaskz):
            def check(self, token):
                raise exc

        httpd = make_server(cfg, Failing(), port=0, secure_cookie=False)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        return f"http://127.0.0.1:{httpd.server_address[1]}"

    def open_link(self, base, token):
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            opener.open(f"{base}/i/{token}")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Location")
        self.fail("expected a redirect")

    def test_wrong_key_gives_a_page_and_a_clear_log(self):
        err = urllib.error.HTTPError("https://taskz.id", 401, "Unauthorized", {}, None)
        base = self.serve(err)
        with self.assertLogs("portal", level="ERROR") as logs:
            code, loc = self.open_link(base, "tok-123")
        self.assertEqual((code, loc), (303, "/?unavailable=1#tok-123"))
        self.assertIn("TRACKER_INGEST_KEY", "\n".join(logs.output))
        # Still serving afterwards.
        self.assertEqual(json.loads(urllib.request.urlopen(base + "/healthz").read())["ok"], True)

    def test_network_failure_gives_a_page(self):
        base = self.serve(urllib.error.URLError("timed out"))
        with self.assertLogs("portal", level="ERROR") as logs:
            code, loc = self.open_link(base, "abc")
        self.assertEqual((code, loc), (303, "/?unavailable=1#abc"))
        self.assertIn("could not reach taskz.id", "\n".join(logs.output))
