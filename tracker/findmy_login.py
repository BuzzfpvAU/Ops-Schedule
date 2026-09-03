#!/usr/bin/env python3
"""One-time interactive Find My sign-in for the AirTag tracker."""

from __future__ import annotations

import getpass
from pathlib import Path

TRACKER_DIR = Path(__file__).resolve().parent
STORE = TRACKER_DIR / "account.json"
ANISETTE_LIBS = TRACKER_DIR / "ani_libs.bin"


def main() -> int:
    from findmy import (
        AppleAccount,
        LocalAnisetteProvider,
        LoginState,
        SmsSecondFactorMethod,
        TrustedDeviceSecondFactorMethod,
    )

    if STORE.exists():
        try:
            acc = AppleAccount.from_json(STORE)
            print(f"Existing session for: {acc.account_name}")
            if input("Reuse it? [Y/n] ").strip().lower() != "n":
                return 0
        except Exception:  # noqa: BLE001
            print("Stored session is invalid — signing in fresh.")

    provider = LocalAnisetteProvider(ANISETTE_LIBS)
    acc = AppleAccount(anisette=provider)

    email = input("Apple ID email: ").strip()
    password = getpass.getpass("Apple ID password (not echoed): ")

    state = acc.login(email, password)
    if state == LoginState.REQUIRE_2FA:
        methods = acc.get_2fa_methods()
        for i, method in enumerate(methods):
            if isinstance(method, TrustedDeviceSecondFactorMethod):
                print(f"{i} - Trusted Device (approve the prompt on your iPhone/Mac)")
            elif isinstance(method, SmsSecondFactorMethod):
                print(f"{i} - SMS to {method.phone_number}")
        idx = int(input("Choose a method number: "))
        method = methods[idx]
        method.request()
        code = input("Enter the 6-digit code: ").strip()
        method.submit(code)
    elif state != LoginState.LOGGED_IN:
        print(f"Login failed (state: {state})")
        return 1

    acc.to_json(STORE)
    print(f"✅ Logged in as {acc.account_name}. Session saved to {STORE.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
