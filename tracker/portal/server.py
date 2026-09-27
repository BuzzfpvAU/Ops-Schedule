"""Tag export portal — phone-facing HTTP on 127.0.0.1 behind Cloudflare Tunnel.

Run: cd tracker && .venv/bin/python -m portal.server
Env: API_URL, TRACKER_INGEST_KEY, EXPORTER_BIN (default ~/Dev/export-findmy/target/release/export-findmy),
     EXPORTER_TEMPLATE (default <export-findmy>/device-profile.template.toml), PORTAL_PORT (8765).
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from portal.session import ExportSession, SessionConfig
from portal.taskz_client import TaskzClient

VERSION = "1"
STATIC = Path(__file__).parent / "static" / "index.html"
COOKIE = "tz_portal"
COOKIE_AGE = 900
RATE_LIMIT = 10  # link checks per minute per client IP
log = logging.getLogger("portal")


class Portal:
    def __init__(self, cfg: SessionConfig, client, secure_cookie: bool = True):
        self.cfg = cfg
        self.client = client
        self.secure_cookie = secure_cookie
        self.visitors: dict[str, dict] = {}   # cookie -> {"invite": {...}, "session": ExportSession|None, "at": t}
        self.active: ExportSession | None = None
        self.hits: dict[str, list] = {}
        self.lock = threading.Lock()

    def rate_ok(self, ip: str) -> bool:
        now = time.monotonic()
        with self.lock:
            recent = [t for t in self.hits.get(ip, []) if now - t < 60]
            recent.append(now)
            self.hits[ip] = recent
            return len(recent) <= RATE_LIMIT

    def reap(self) -> None:
        with self.lock:
            if self.active is not None:
                self.active.reap()
                if self.active.finished:
                    self.active = None
            cutoff = time.monotonic() - COOKIE_AGE
            for k in [k for k, v in self.visitors.items() if v["at"] < cutoff]:
                del self.visitors[k]


def make_handler(portal: Portal):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # never log bodies or query strings
            log.info("%s %s", self.command, self.path.split("?")[0].split("/i/")[0] or "/i/…")

        def _headers(self, code=200, ctype="application/json", extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, obj, code=200):
            self._headers(code)
            self.wfile.write(json.dumps(obj).encode())

        def _visitor(self):
            raw = self.headers.get("Cookie", "")
            for part in raw.split(";"):
                k, _, v = part.strip().partition("=")
                if k == COOKIE:
                    return v, portal.visitors.get(v)
            return None, None

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n <= 10000 else {}

        def do_GET(self):
            portal.reap()
            if self.path == "/healthz":
                return self._json({"ok": True, "version": VERSION})
            if self.path.startswith("/i/"):
                ip = self.headers.get("CF-Connecting-IP") or self.client_address[0]
                token = self.path[3:].split("?")[0]
                res = portal.client.check(token) if portal.rate_ok(ip) else {"ok": False}
                if res.get("ok"):
                    inv = res
                    cookie = secrets.token_urlsafe(24)
                    portal.visitors[cookie] = {"invite": inv, "session": None, "at": time.monotonic()}
                    flags = f"{COOKIE}={cookie}; Path=/; Max-Age={COOKIE_AGE}; HttpOnly; SameSite=Strict"
                    if portal.secure_cookie:
                        flags += "; Secure"
                    self._headers(303, "text/plain", {"Location": "/", "Set-Cookie": flags})
                else:
                    self._headers(303, "text/plain", {"Location": "/?expired=1"})
                return
            if self.path.startswith("/api/state"):
                _, v = self._visitor()
                if not v:
                    return self._json({"step": "expired"})
                v["at"] = time.monotonic()
                if v["session"] is None:
                    return self._json({"step": "intro", "label": v["invite"]["label"]})
                return self._json(v["session"].state)
            if self.path == "/" or self.path.startswith("/?"):
                self._headers(200, "text/html; charset=utf-8")
                self.wfile.write(STATIC.read_bytes())
                return
            self._headers(404, "text/plain")

        def do_POST(self):
            portal.reap()
            _, v = self._visitor()
            if not v:
                return self._json({"error": "no session"}, 403)
            v["at"] = time.monotonic()
            body = self._body()
            if self.path == "/api/start":
                email = str(body.get("email") or "").strip()
                if "@" not in email or len(email) > 200:
                    return self._json({"step": "intro", "label": v["invite"]["label"], "message": "Enter your Apple ID email."})
                with portal.lock:
                    if portal.active is not None and not portal.active.finished and portal.active is not v["session"]:
                        return self._json({"step": "busy"})
                    s = ExportSession(v["invite"], email, portal.cfg, portal.client)
                    v["session"] = s
                    portal.active = s
                return self._json(s.start())
            s = v["session"]
            if s is None:
                return self._json({"error": "not started"}, 409)
            if self.path == "/api/answer":
                return self._json(s.answer(str(body.get("value") or "")))
            if self.path == "/api/save":
                return self._json(s.save([str(f) for f in body.get("files") or []]))
            if self.path == "/api/cancel":
                return self._json(s.cancel())
            self._json({"error": "not found"}, 404)

    return Handler


def make_server(cfg: SessionConfig, client, host: str = "127.0.0.1", port: int = 8765,
                secure_cookie: bool = True) -> ThreadingHTTPServer:
    portal = Portal(cfg, client, secure_cookie=secure_cookie)
    return ThreadingHTTPServer((host, port), make_handler(portal))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    tracker = Path(__file__).resolve().parent.parent
    exporter = os.environ.get("EXPORTER_BIN", str(Path.home() / "Dev/export-findmy/target/release/export-findmy"))
    cfg = SessionConfig(
        exporter_argv=[exporter],
        template_profile=Path(os.environ.get("EXPORTER_TEMPLATE")
                              or Path(exporter).parents[2] / "device-profile.template.toml"),
        shared_root=tracker / "accounts" / "shared",
        work_root=Path.home() / "Library" / "Application Support" / "taskz-portal",
    )
    client = TaskzClient(os.environ["API_URL"], os.environ["TRACKER_INGEST_KEY"])
    httpd = make_server(cfg, client, port=int(os.environ.get("PORTAL_PORT", "8765")))
    log.info("portal listening on 127.0.0.1:%s", httpd.server_address[1])
    httpd.serve_forever()


if __name__ == "__main__":
    main()
