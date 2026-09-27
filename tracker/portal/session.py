"""One portal export: temp workspace, exporter, choice, keep, cleanup."""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import string
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from portal.exporter_driver import ExporterDriver, delete_bottle

DEVICE_NAME = "Taskz Tag Export"
log = logging.getLogger("portal.session")
DEVICE_MODELS = ("iPhone", "iPad", "Mac", "Watch", "AirPods")
TERMINAL = {"done", "error"}


def classify(model: str, identifier: str) -> str:
    if (model or "").startswith(DEVICE_MODELS) or (identifier or "").startswith(("l:/", "me:/")):
        return "device"
    return "tag"


def slugify(label: str, invite_id: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "invite"
    return f"{base}-{invite_id[:6]}"


@dataclass
class SessionConfig:
    exporter_argv: list
    template_profile: Path
    shared_root: Path
    work_root: Path
    idle_timeout: float = 600
    silence_timeout: float = 90


class ExportSession:
    def __init__(self, invite: dict, email: str, cfg: SessionConfig, client):
        self.invite = invite
        self.email = email
        self.cfg = cfg
        self.client = client
        self.serial = "TZ" + "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(10))
        self.escrow_password = secrets.token_urlsafe(24)
        self.tmp: Path | None = None
        self.driver: ExporterDriver | None = None
        self.state: dict = {"step": "starting"}
        self.last_touch = time.monotonic()
        self._retried_password = False
        self._joined = False
        self._cleaned = False
        self._lock = threading.RLock()

    # ── lifecycle ──
    @property
    def finished(self) -> bool:
        return self.state.get("step") in TERMINAL

    def _argv(self) -> list:
        return self.cfg.exporter_argv + [
            "--apple-id", self.email,
            "--device-profile", str(self.tmp / "profile.toml"),
            "--output-dir", str(self.tmp / "keys"),
            "--auth-cache", str(self.tmp / "auth.plist"),
            "--keychain-state", str(self.tmp / "keychain.plist"),
        ]

    def _env(self) -> dict:
        return dict(os.environ, EXPORT_FINDMY_ESCROW_PASSWORD=self.escrow_password)

    def _write_profile(self) -> None:
        text = self.cfg.template_profile.read_text()
        text = re.sub(r'(?m)^name = ".*"$', f'name = "{DEVICE_NAME}"', text, count=1)
        text = re.sub(r'(?m)^serial = ".*"$', f'serial = "{self.serial}"', text, count=1)
        p = self.tmp / "profile.toml"
        p.write_text(text)
        p.chmod(0o600)

    def start(self) -> dict:
        with self._lock:
            self.cfg.work_root.mkdir(parents=True, exist_ok=True)
            self.tmp = Path(tempfile.mkdtemp(prefix="export-", dir=self.cfg.work_root))
            self.tmp.chmod(0o700)
            self._write_profile()
            self._tell("attempt", self.invite["id"])
            self._spawn()
            return self.state

    def _spawn(self) -> None:
        self.driver = ExporterDriver(self._argv(), self._env(), silence_timeout=self.cfg.silence_timeout)
        self._apply(self._guard(self.driver.start))

    def _guard(self, fn, *args):
        # Any unexpected failure ends the session through the normal failure
        # path, so the attempt is recorded and cleanup still runs.
        try:
            return fn(*args)
        except Exception as exc:  # noqa: BLE001
            log.error("export session %s: %s", self.invite["id"], type(exc).__name__)
            from portal.exporter_driver import Step
            return Step("error", error="unknown", detail=type(exc).__name__)

    def answer(self, value: str) -> dict:
        with self._lock:
            self.last_touch = time.monotonic()
            if self.finished or self.driver is None:
                return self.state
            step = self._guard(self.driver.answer, value)
            self._joined = self._joined or self.driver.passcode_sent
            if step.kind == "error" and step.error == "bad_password" and not self._retried_password:
                self._retried_password = True
                self._spawn()
                self.state["message"] = "Apple didn't accept that password."
                return self.state
            self._apply(step)
            return self.state

    def _apply(self, step) -> None:
        if step.kind == "finished":
            self.state = {"step": "choose", "items": self._items()}
        elif step.kind == "no_items":
            self._fail("no_items")
        elif step.kind == "error":
            self._fail(step.error, step.detail)
        else:
            self.state = {"step": step.kind, "options": step.options, "device": step.device}

    def _items(self) -> list:
        out = []
        for p in sorted((self.tmp / "keys").glob("*.json")):
            meta = json.loads(p.read_text())
            kind = classify(meta.get("model") or "", meta.get("identifier") or "")
            out.append({"file": p.stem, "name": meta.get("name") or p.stem, "emoji": meta.get("emoji") or "",
                        "kind": kind, "checked": kind == "tag"})
        return out

    def save(self, files: list) -> dict:
        with self._lock:
            if self.state.get("step") != "choose":
                return self.state
            slug = slugify(self.invite["label"], self.invite["id"])
            keep = {i["file"] for i in self.state["items"]} & set(files)
            rows = []
            if keep:
                dest = self.cfg.shared_root / slug / "keys"
                dest.mkdir(parents=True, exist_ok=True)
                for d in (self.cfg.shared_root, self.cfg.shared_root / slug, dest):
                    d.chmod(0o700)
                for stem in sorted(keep):
                    meta = json.loads((self.tmp / "keys" / f"{stem}.json").read_text())
                    for ext in (".json", ".plist"):
                        src = self.tmp / "keys" / f"{stem}{ext}"
                        if src.exists():
                            target = dest / src.name
                            shutil.move(str(src), target)
                            target.chmod(0o600)
                    rows.append({
                        "identifier": meta.get("identifier"), "account": f"shared/{slug}",
                        "name": meta.get("name") or "", "emoji": meta.get("emoji") or "",
                        "model": meta.get("model") or "", "serial_number": meta.get("serial_number") or "",
                        "kind": classify(meta.get("model") or "", meta.get("identifier") or ""),
                    })
                self._tell("inventory", rows)
            self._tell("complete", self.invite["id"], len(rows))
            self.state = {"step": "done", "saved": len(rows), "remove_device": DEVICE_NAME}
            self._cleanup()
            return self.state

    def cancel(self) -> dict:
        with self._lock:
            if not self.finished:
                self._fail("cancelled")
            return self.state

    def reap(self, now: float | None = None) -> bool:
        with self._lock:
            now = time.monotonic() if now is None else now
            if not self.finished and now - self.last_touch > self.cfg.idle_timeout:
                self._fail("timeout")
                return True
            return False

    def _tell(self, name: str, *args) -> None:
        # taskz.id being unreachable must never stop an export from cleaning
        # up; the sync re-reports kept keys on its next run anyway.
        try:
            getattr(self.client, name)(*args)
        except Exception as exc:  # noqa: BLE001
            log.error("taskz %s failed for %s: %s", name, self.invite["id"], type(exc).__name__)

    def _fail(self, error: str, detail: str | None = None) -> None:
        self.state = {"step": "error", "error": error, "remove_device": DEVICE_NAME if self._joined else None}
        self._tell("failed", self.invite["id"], error)
        self._cleanup()

    def _cleanup(self) -> None:
        if self._cleaned:
            return
        self._cleaned = True
        if self.driver is not None:
            self.driver.close()
        try:
            if self._joined and self.tmp is not None:
                try:
                    ok, why = delete_bottle(self._argv(), self._env(), self.serial,
                                            timeout=self.cfg.silence_timeout)
                except Exception as exc:  # noqa: BLE001
                    ok, why = False, type(exc).__name__
                if not ok:
                    self._tell("cleanup_failed", self.invite["id"], why)
        finally:
            if self.tmp is not None:
                shutil.rmtree(self.tmp, ignore_errors=True)
