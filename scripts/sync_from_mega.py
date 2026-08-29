#!/usr/bin/env python3
"""
Fine Arts Exhibition — TrueNAS MEGAcmd to Google Sheets sync.

Designed to run on TrueNAS, not on Ganesh's PC.

It reads registration data from the already-running `megacmd` Docker container
using `mega-find` and `mega-cat`, then updates the Google Sheet via the Google
Sheets REST API using a service account JSON key.

It does NOT modify the existing website/API container or its workflow.

Required files/env:
  GOOGLE_SERVICE_ACCOUNT_FILE=/mnt/Pool/mega/google-sheets-sync/google-service-account.json
Optional env:
  SHEET_ID=1ao0RZZvXaIrJCjdFe2xQGIGA7yA9TE2H-C60Z44U8eI
  TARGET_SHEET=Artists by Batch
  TARGET_GID=1243069756
  MEGA_ROOT=/Fine Arts Exhibition/Registered
  MEGACMD_CONTAINER=megacmd
  POLL_INTERVAL=30
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SHEET_ID = os.environ.get("SHEET_ID", "1ao0RZZvXaIrJCjdFe2xQGIGA7yA9TE2H-C60Z44U8eI")
TARGET_SHEET = os.environ.get("TARGET_SHEET", "Artists by Batch")
TARGET_GID = int(os.environ.get("TARGET_GID", "1243069756"))
MEGA_ROOT = os.environ.get("MEGA_ROOT", "/Fine Arts Exhibition/Registered").rstrip("/")
MEGACMD_CONTAINER = os.environ.get("MEGACMD_CONTAINER", "megacmd")
KEY_FILE = os.environ.get(
    "GOOGLE_SERVICE_ACCOUNT_FILE",
    "/mnt/Pool/mega/google-sheets-sync/google-service-account.json",
)
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
HEADER_COLS = 6
SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive"


def log(message: str) -> None:
    print(message, flush=True)


def run_cmd(args: list[str], timeout: int = 120) -> str:
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(args)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result.stdout


def mega_exec(*args: str, timeout: int = 120) -> str:
    return run_cmd(["docker", "exec", MEGACMD_CONTAINER, *args], timeout=timeout)


def mega_find_artwork_json() -> list[str]:
    output = mega_exec("mega-find", MEGA_ROOT, "--pattern=artwork-info.json", timeout=180)
    paths = []
    for line in output.splitlines():
        line = line.strip()
        if not line or line.startswith("["):
            continue
        if line.endswith("/artwork-info.json"):
            paths.append(line)
    return sorted(set(paths), key=str.lower)


def mega_cat_json(path: str) -> dict[str, Any]:
    # Use mega-get (downloads to temp file) instead of mega-cat (streams, unreliable)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp) / "artwork.json"
        run_cmd(["docker", "exec", MEGACMD_CONTAINER, "mega-get", "-O", str(tmp_path), path], timeout=30)
        return json.loads(tmp_path.read_text(encoding="utf-8"))


def batch_sort_key(batch: str) -> tuple[int, str]:
    first = batch.split()[0]
    try:
        return int(first), batch
    except Exception:
        return 9999, batch.lower()


def collect_registrations() -> dict[str, dict[str, Any]]:
    all_data: dict[str, dict[str, Any]] = {}
    paths = mega_find_artwork_json()
    log(f"  Found {len(paths)} artwork-info.json files in MEGA")

    # First pass: collect all artistIds -> set of fullNames found
    artist_names: dict[str, set[str]] = {}
    for path in paths:
        try:
            data = mega_cat_json(path)
        except Exception as exc:
            log(f"  WARNING: could not read {path}: {exc}")
            continue
        student = data.get("student", {}) if isinstance(data, dict) else {}
        aid = data.get("artistId", "") if isinstance(data, dict) else ""
        if not aid:
            continue
        fn = student.get("fullName", "") if isinstance(student, dict) else ""
        if fn:
            artist_names.setdefault(aid, set()).add(fn)

    # Second pass: build full data with first valid name per artist
    for path in paths:
        try:
            data = mega_cat_json(path)
        except Exception as exc:
            log(f"  WARNING: could not read {path}: {exc}")
            continue

        student = data.get("student", {}) if isinstance(data, dict) else {}
        artwork = data.get("artwork", {}) if isinstance(data, dict) else {}
        storage = data.get("storage", {}) if isinstance(data, dict) else {}
        parts = path.split("/")

        # /Fine Arts Exhibition/Registered/{Batch}/{ArtistID}/{ArtID}/artwork-info.json
        batch = storage.get("batch") or student.get("studentYear") or (parts[-4] if len(parts) >= 5 else "Unknown Batch")
        artist_id = data.get("artistId") or storage.get("artistId") or (parts[-3] if len(parts) >= 4 else "UNKNOWN")
        batch_label = batch if str(batch).endswith(" Batch") else f"{batch} Batch"

        # Pick the first valid fullName for this artist from collected names
        fn = ""
        if artist_id in artist_names and artist_names[artist_id]:
            fn = next(iter(artist_names[artist_id]))

        artist = all_data.setdefault(batch_label, {}).setdefault(
            artist_id,
            {"artistId": artist_id, "fullName": fn, "batch": batch_label, "artworks": []},
        )
        if not artist["fullName"] and fn:
            artist["fullName"] = fn
        # Always add the artwork entry regardless of name presence
        artist["artworks"].append(
            {
                "id": data.get("id", ""),
                "title": artwork.get("title", ""),
                "category": artwork.get("category", ""),
                "medium": artwork.get("medium", ""),
                "status": data.get("status", ""),
            }
        )
    return all_data


def build_rows(all_data: dict[str, dict[str, Any]]) -> list[list[Any]]:
    batch_names = sorted(all_data.keys(), key=batch_sort_key)
    if not batch_names:
        return []
    total_artists = sum(len(a) for a in all_data.values())
    total_artworks = sum(sum(len(x["artworks"]) for x in a.values()) for a in all_data.values())
    rows: list[list[Any]] = []
    rows.append(["Fine Arts Exhibition — Registered Artists by Batch"] + [""] * (HEADER_COLS - 1))
    rows.append([f"{total_artists} Artists  |  {total_artworks} Artworks  |  Batches: {batch_names[0]}–{batch_names[-1]}"] + [""] * (HEADER_COLS - 1))
    rows.append([""] * HEADER_COLS)

    for b_index, batch in enumerate(batch_names):
        artists = all_data[batch]
        art_count = sum(len(a["artworks"]) for a in artists.values())
        rows.append([batch] + [""] * (HEADER_COLS - 1))
        rows.append([f"{len(artists)} Artists | {art_count} Artworks"] + [""] * (HEADER_COLS - 1))
        rows.append(["S.No", "Artist Name", "Artist ID", "Artworks", "Category", "Medium"])
        sorted_artist_ids = sorted(artists.keys(), key=lambda aid: (artists[aid]["fullName"] or aid).lower())
        for serial, artist_id in enumerate(sorted_artist_ids, start=1):
            artist = artists[artist_id]
            artworks = artist["artworks"]
            categories = sorted({x.get("category", "") for x in artworks if x.get("category")})
            mediums = sorted({x.get("medium", "") for x in artworks if x.get("medium")})
            rows.append([
                serial,
                artist["fullName"],
                artist_id,
                len(artworks),
                ", ".join(categories),
                ", ".join(mediums),
            ])
        if b_index < len(batch_names) - 1:
            rows.append([""] * HEADER_COLS)
            rows.append([""] * HEADER_COLS)
    return rows


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def google_access_token() -> str:
    key = json.loads(Path(KEY_FILE).read_text(encoding="utf-8"))
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": key["client_email"],
        "scope": SCOPES,
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    signing_input = f"{b64url(json.dumps(header, separators=(',', ':')).encode())}.{b64url(json.dumps(claims, separators=(',', ':')).encode())}"
    with tempfile.NamedTemporaryFile("w", delete=False) as key_file:
        key_file.write(key["private_key"])
        private_key_path = key_file.name
    try:
        proc = subprocess.run(
            ["openssl", "dgst", "-sha256", "-sign", private_key_path],
            input=signing_input.encode("ascii"),
            capture_output=True,
            timeout=30,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", errors="replace"))
        assertion = signing_input + "." + b64url(proc.stdout)
    finally:
        try:
            os.unlink(private_key_path)
        except OSError:
            pass

    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=30) as resp:
        token_data = json.loads(resp.read().decode("utf-8"))
    return token_data["access_token"]


def google_request(method: str, url: str, token: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text) if text else {}


def sheet_name_for_target(token: str) -> str:
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}?fields=sheets(properties(sheetId,title))"
    meta = google_request("GET", url, token)
    sheets = meta.get("sheets", [])
    for sheet in sheets:
        props = sheet.get("properties", {})
        if props.get("sheetId") == TARGET_GID:
            return props.get("title", TARGET_SHEET)
    for sheet in sheets:
        props = sheet.get("properties", {})
        if props.get("title") == TARGET_SHEET:
            return TARGET_SHEET
    # Create if missing.
    batch_url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}:batchUpdate"
    google_request("POST", batch_url, token, {"requests": [{"addSheet": {"properties": {"title": TARGET_SHEET}}}]})
    return TARGET_SHEET


def update_sheet(rows: list[list[Any]]) -> str:
    token = google_access_token()
    title = sheet_name_for_target(token)
    encoded_title = urllib.parse.quote(title, safe="")
    clear_url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{encoded_title}!A:F:clear"
    google_request("POST", clear_url, token, {})
    update_url = f"https://sheets.googleapis.com/v4/spreadsheets/{SHEET_ID}/values/{encoded_title}!A1?valueInputOption=USER_ENTERED"
    google_request("PUT", update_url, token, {"range": f"{title}!A1", "majorDimension": "ROWS", "values": rows})
    return title


def compute_checksum(data: Any) -> str:
    return hashlib.md5(json.dumps(data, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def run_once(write: bool = True) -> tuple[dict[str, dict[str, Any]], list[list[Any]]]:
    data = collect_registrations()
    rows = build_rows(data)
    if write and rows:
        title = update_sheet(rows)
        log(f"  Updated Google Sheet tab: {title}")
    return data, rows


def main() -> int:
    log("=" * 72)
    log("Fine Arts Exhibition — TrueNAS MEGAcmd → Google Sheets sync")
    log("=" * 72)
    log(f"MEGA source: {MEGA_ROOT}")
    log(f"Sheet: {SHEET_ID} / gid {TARGET_GID} / {TARGET_SHEET}")
    log(f"Poll interval: {POLL_INTERVAL}s")
    last_checksum: str | None = None
    run_count = 0
    while True:
        run_count += 1
        log(f"\n[Run {run_count}] Checking MEGA Cloud...")
        try:
            data, rows = run_once(write=False)
            current = compute_checksum(data)
            total_artists = sum(len(a) for a in data.values())
            total_artworks = sum(sum(len(x["artworks"]) for x in a.values()) for a in data.values())
            if current != last_checksum:
                log(f"  CHANGE DETECTED: {total_artists} artists, {total_artworks} artworks, {len(rows)} rows")
                if rows:
                    title = update_sheet(rows)
                    log(f"  SUCCESS: updated {title}")
                last_checksum = current
            else:
                log(f"  No changes ({total_artists} artists, {total_artworks} artworks)")
        except Exception as exc:
            log(f"  ERROR: {exc}")
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        log("Stopped.")
        raise SystemExit(0)
    except Exception as exc:
        print(f"FATAL: {exc}", file=sys.stderr)
        raise SystemExit(1)
