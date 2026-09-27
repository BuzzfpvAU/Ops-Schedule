"""Drive export-findmy's interactive prompts through a pty.

Answers (password, codes, passcode) are written straight to the child and
never logged: pexpect's logfile stays None and nothing here prints them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import pexpect

PROMPTS = [
    ("need_password", r"(?m)^Password: "),
    ("need_2fa_method", r"Method \[0\]: "),
    ("need_code", r"(?m)^Code: "),
    ("need_bottle", r"Choose bottle \[0\]: "),
    ("need_passcode", r"Enter the passcode of that device: "),
]
METHOD_RE = re.compile(r"^\s+(\d+) - (.+?)\s*$", re.M)
BOTTLE_RE = re.compile(r"^\s{4}\[(\d+)\] (.+?)\s*$", re.M)
USING_RE = re.compile(r"Using escrow bottle from device: (.+?) \(serial ")

ERROR_PATTERNS = [
    ("bad_code", re.compile(r"-21669|verification code", re.I)),
    ("bad_password", re.compile(r"-20101|password was incorrect|incorrect password", re.I)),
    ("hardware_key", re.compile(r"security key", re.I)),
    ("no_bottles", re.compile(r"No usable escrow bottles", re.I)),
    ("apple_unavailable", re.compile(r"\b503\b|anisette|timed out|connection", re.I)),
]


@dataclass
class Step:
    kind: str
    options: list | None = None
    device: str | None = None
    error: str | None = None
    detail: str | None = None


def classify_error(text: str) -> str:
    for kind, rx in ERROR_PATTERNS:
        if rx.search(text):
            return kind
    return "unknown"


def last_line(text: str) -> str:
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    return lines[-1][:200] if lines else ""


class ExporterDriver:
    def __init__(self, argv: list[str], env: dict, silence_timeout: float = 90):
        self.argv = argv
        self.env = env
        self.silence_timeout = silence_timeout
        self.child = None
        self.buf = ""
        self.passcode_sent = False
        self._awaiting = None

    def start(self) -> Step:
        self.child = pexpect.spawn(self.argv[0], self.argv[1:], env=self.env,
                                   encoding="utf-8", timeout=self.silence_timeout,
                                   echo=False, logfile=None)
        return self._next()

    def answer(self, value: str) -> Step:
        if self._awaiting == "need_passcode":
            self.passcode_sent = True
        self.child.sendline(value)
        return self._next()

    def close(self) -> None:
        if self.child is not None and self.child.isalive():
            self.child.terminate(force=True)

    def _next(self) -> Step:
        patterns = [p for _, p in PROMPTS] + [pexpect.EOF, pexpect.TIMEOUT]
        i = self.child.expect(patterns)
        text = self.child.before or ""
        self.buf += text
        if i < len(PROMPTS):
            kind = PROMPTS[i][0]
            self._awaiting = kind
            if kind == "need_2fa_method":
                opts = [{"index": int(n), "label": lab} for n, lab in METHOD_RE.findall(text)]
                return Step(kind, options=opts)
            if kind == "need_bottle":
                opts = [{"index": int(n), "label": lab} for n, lab in BOTTLE_RE.findall(text)]
                return Step(kind, options=opts)
            if kind == "need_passcode":
                m = USING_RE.search(text)
                return Step(kind, device=m.group(1) if m else "your iPhone")
            return Step(kind)
        if i == len(PROMPTS) + 1:  # TIMEOUT: no output for silence_timeout
            self.close()
            return Step("error", error="apple_unavailable", detail="no response")
        self.child.close()
        code = self.child.exitstatus
        if code == 0 and "No accessories found" in self.buf:
            return Step("no_items")
        if code == 0 and "Done! Exported" in self.buf:
            return Step("finished")
        return Step("error", error=classify_error(self.buf), detail=last_line(self.buf))


def delete_bottle(argv: list[str], env: dict, serial: str, timeout: float = 90) -> tuple[bool, str]:
    """Delete the escrow bottle whose serial matches this session's profile."""
    child = pexpect.spawn(argv[0], argv[1:] + ["--delete-own-escrow-bottle"], env=env,
                          encoding="utf-8", timeout=timeout, echo=False, logfile=None)
    try:
        i = child.expect([r"Choose a bottle to delete, or press Enter to cancel: ",
                          r"(?m)^Password: ", pexpect.EOF, pexpect.TIMEOUT])
        if i != 0:
            return False, "could not sign in again to delete the bottle"
        listing = child.before or ""
        index = None
        for n, s in re.findall(r"\[(\d+)\][^\n]*\n\s+serial: ([^,\s]+),", listing):
            if s == serial:
                index = n
        if index is None:
            child.sendline("")
            return False, f"bottle with serial {serial} not found"
        child.sendline(index)
        child.expect(r"Escrow password \[press Enter to use the saved profile password\]: ")
        child.sendline("")
        child.expect(rf"Type DELETE {index} to permanently delete this escrow bottle: ")
        child.sendline(f"DELETE {index}")
        child.expect(r"Final confirmation: type the device serial \S+: ")
        child.sendline(serial)
        j = child.expect([r"Deleted escrow bottle", pexpect.EOF, pexpect.TIMEOUT])
        return (j == 0), ("deleted" if j == 0 else last_line(child.before or ""))
    except (pexpect.EOF, pexpect.TIMEOUT):
        return False, last_line(child.before or "") or "exporter stopped"
    finally:
        if child.isalive():
            child.terminate(force=True)
