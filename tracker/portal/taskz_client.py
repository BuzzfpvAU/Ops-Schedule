"""taskz.id calls for the portal (X-Ingest-Key auth)."""
from __future__ import annotations

import json
import urllib.request


class TaskzClient:
    def __init__(self, api_url: str, key: str, timeout: float = 20):
        self.api = api_url.rstrip("/") + "/api/equipment"
        self.key = key
        self.timeout = timeout

    def _post(self, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            self.api + path, data=json.dumps(body or {}).encode(), method="POST",
            headers={"Content-Type": "application/json", "X-Ingest-Key": self.key},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def check(self, token: str) -> dict:
        return self._post("/tracker/invites/check", {"token": token})

    def attempt(self, invite_id: str) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/attempt")

    def complete(self, invite_id: str, tags_saved: int) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/complete", {"tags_saved": tags_saved})

    def failed(self, invite_id: str, note: str) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/failed", {"note": note})

    def cleanup_failed(self, invite_id: str, note: str) -> dict:
        return self._post(f"/tracker/invites/{invite_id}/cleanup-failed", {"note": note})

    def inventory(self, rows: list) -> dict:
        return self._post("/tracker/inventory", {"items": rows})
