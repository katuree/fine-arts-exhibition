#!/usr/bin/env python3
r"""
Fine Arts Exhibition — legacy local-PC sync.

This script reads from G:\Registered_extracted\Registered\ and is disabled
by default because that Windows Syncthing copy can be stale. The live auto-sync
runs on TrueNAS using sync_from_mega.py.

Single sheet: "Artists by Batch"
- 6 columns: S.No, Artist Name, Artist ID, Artworks, Category, Medium
- No separate Batch column
- Batch group headers, count rows, 2 blank rows between groups
"""

import json
import os
import time
import hashlib
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials

# ── Config ──────────────────────────────────────────────────────────────────

REGISTERED_ROOT = Path(r"G:\Registered_extracted\Registered")
SHEET_ID = "1ao0RZZvXaIrJCjdFe2xQGIGA7yA9TE2H-C60Z44U8eI"
KEY_FILE = r"C:\Users\Ganesh\Downloads\fine-arts-506908-a30aa490b71e.json"
POLL_INTERVAL = 30  # seconds
TARGET_SHEET = "Artists by Batch"
HEADER_COLS = 6

# ── Google Auth ─────────────────────────────────────────────────────────────

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def get_gc():
    creds = Credentials.from_service_account_file(KEY_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


# ── Data Collection ────────────────────────────────────────────────────────

def collect_registrations():
    """Read all artwork-info.json files, grouped by batch."""
    all_data = {}  # batch_label -> { artist_id -> artist_info }

    if not REGISTERED_ROOT.exists():
        print(f"WARNING: Registered root not found: {REGISTERED_ROOT}")
        return all_data

    for batch_dir in sorted(REGISTERED_ROOT.iterdir()):
        if not batch_dir.is_dir():
            continue
        batch_label = (
            batch_dir.name
            if batch_dir.name.endswith(" Batch")
            else f"{batch_dir.name} Batch"
        )
        for artist_dir in sorted(batch_dir.iterdir()):
            if not artist_dir.is_dir():
                continue
            artist_id = artist_dir.name
            artist_info = {
                "artistId": artist_id,
                "fullName": "",
                "batch": batch_label,
                "artworks": [],
            }
            for reg_dir in sorted(artist_dir.iterdir()):
                if not reg_dir.is_dir():
                    continue
                info_file = reg_dir / "artwork-info.json"
                if not info_file.is_file():
                    continue
                try:
                    with open(info_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    student = data.get("student", {})
                    artwork = data.get("artwork", {})
                    if not artist_info["fullName"] and student.get("fullName"):
                        artist_info["fullName"] = student["fullName"]
                    art_entry = {
                        "id": data.get("id", ""),
                        "title": artwork.get("title", ""),
                        "category": artwork.get("category", ""),
                        "medium": artwork.get("medium", ""),
                        "status": data.get("status", ""),
                    }
                    artist_info["artworks"].append(art_entry)
                except Exception as e:
                    print(f"  Error reading {info_file}: {e}")

            all_data.setdefault(batch_label, {})[artist_id] = artist_info

    return all_data


# ── Sheet Row Building ──────────────────────────────────────────────────────

def build_rows(all_data):
    """Build rows matching the exact format of Fine_Arts_Registrations_By_Batch.xlsx."""
    batch_names = sorted(all_data.keys())

    if not batch_names:
        return []

    total_artists = sum(len(a) for a in all_data.values())
    total_artworks = sum(
        sum(len(x["artworks"]) for x in a.values()) for a in all_data.values()
    )
    batches_range = f"{batch_names[0]}–{batch_names[-1]}"  # en-dash

    rows = []

    # Title row 1 (merged A1:F1 in Excel)
    rows.append([f"Fine Arts Exhibition \u2014 Registered Artists by Batch"] + [None] * (HEADER_COLS - 1))
    # Title row 2 (merged A2:F2)
    rows.append([f"{total_artists} Artists  |  {total_artworks} Artworks  |  Batches: {batches_range}"] + [None] * (HEADER_COLS - 1))
    # Blank row
    rows.append([None] * HEADER_COLS)

    for b_idx, batch_name in enumerate(batch_names):
        artists = all_data[batch_name]
        art_count = sum(len(x["artworks"]) for x in artists.values())

        # Batch header row (merged)
        rows.append([batch_name] + [None] * (HEADER_COLS - 1))
        # Count row (merged)
        rows.append([f"{len(artists)} Artists | {art_count} Artworks"] + [None] * (HEADER_COLS - 1))
        # Headers
        rows.append(["S.No", "Artist Name", "Artist ID", "Artworks", "Category", "Medium"])

        # Sort artists alphabetically by name (case-insensitive), fallback to artist_id
        sorted_ids = sorted(artists.keys(), key=lambda aid: (artists[aid]["fullName"] or aid).lower())
        row_num = 0
        for artist_id in sorted_ids:
            info = artists[artist_id]
            artworks_list = info["artworks"]
            count = len(artworks_list)
            categories = sorted(set(aw["category"] for aw in artworks_list if aw["category"]))
            mediums = sorted(set(aw["medium"] for aw in artworks_list if aw["medium"]))
            row_num += 1
            rows.append([
                row_num,
                info["fullName"],
                artist_id,
                count,
                ", ".join(categories),
                ", ".join(mediums),
            ])

        # 2 blank rows between batches (not after the last batch)
        if b_idx < len(batch_names) - 1:
            rows.append([None] * HEADER_COLS)
            rows.append([None] * HEADER_COLS)

    return rows


# ── Write to Google Sheet ──────────────────────────────────────────────────

def write_to_google_sheet(gc, rows):
    """Update or create the target sheet with the given rows."""
    sh = gc.open_by_key(SHEET_ID)
    all_sheets = {ws.title: ws for ws in sh.worksheets()}

    if TARGET_SHEET in all_sheets:
        ws = all_sheets[TARGET_SHEET]
    else:
        ws = sh.add_worksheet(title=TARGET_SHEET, rows=max(len(rows), 5), cols=HEADER_COLS)

    # Clear all content
    ws.clear()

    # Resize and write
    ws.resize(rows=len(rows), cols=HEADER_COLS)
    if rows:
        ws.update(rows)

    return sh


# ── Change Detection ────────────────────────────────────────────────────────

def compute_checksum(all_data):
    raw = json.dumps(all_data, sort_keys=True, default=str)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


# ── Main Loop ───────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("Fine Arts Exhibition \u2014 LOCAL PC Registration Sync to Google Sheets")
    print("=" * 60)
    print("WARNING: This legacy script reads the stale Windows Syncthing folder:")
    print(f"  {REGISTERED_ROOT}")
    print("The live auto-sync now runs on TrueNAS using sync_from_mega.py.")
    print("To prevent overwriting the sheet with stale PC data, this script is disabled by default.")
    print("Set ALLOW_LOCAL_STALE_SYNC=1 only if you intentionally want to sync from this PC folder.")
    if os.environ.get("ALLOW_LOCAL_STALE_SYNC") != "1":
        return

    gc = get_gc()
    print("Connected to Google Sheets.")

    last_checksum = None
    run_count = 0

    while True:
        run_count += 1
        print(f"\n[Run {run_count}] Checking {REGISTERED_ROOT}...")

        all_data = collect_registrations()
        checksum = compute_checksum(all_data)

        if checksum != last_checksum:
            print(f"  CHANGE DETECTED! {checksum}")
            if all_data:
                total_artists = sum(len(a) for a in all_data.values())
                total_artworks = sum(
                    sum(len(x["artworks"]) for x in a.values()) for a in all_data.values()
                )
                print(f"  Data: {total_artists} artists, {total_artworks} artworks across {len(all_data)} batches")

                rows = build_rows(all_data)
                print(f"  Built {len(rows)} rows")

                try:
                    sh = write_to_google_sheet(gc, rows)
                    print(f"  SUCCESS: Updated {TARGET_SHEET} in Google Sheet ({len(rows)} rows)")
                    last_checksum = checksum
                except Exception as e:
                    print(f"  ERROR writing to Google Sheets: {e}")
            else:
                print("  No registration data found.")
                last_checksum = checksum
        else:
            print("  No changes detected.")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nSync stopped.")
    except Exception as e:
        print(f"\nFATAL: {e}")
        import sys
        sys.exit(1)
