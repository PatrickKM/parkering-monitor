import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

URL = "https://www.cibos2.dk/parkeringranders"
ID_LEVEL = 3  # fixed id for "Parkering Gasværksgrunden, Jernbanegade"
THRESHOLD = int(os.environ.get("PARKING_THRESHOLD", "20"))
NTFY_TOPIC = os.environ["NTFY_TOPIC"]
STATUS_FILE = Path(__file__).resolve().parent.parent / "docs" / "status.json"

MARKER = "var parkInfo = "


def extract_park_info_array(html):
    start = html.find(MARKER)
    if start == -1:
        raise RuntimeError("'var parkInfo' declaration not found — site markup may have changed")
    start_arr = start + len(MARKER)
    depth = 0
    for i in range(start_arr, len(html)):
        c = html[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return json.loads(html[start_arr : i + 1])
    raise RuntimeError("unterminated parkInfo array")


def fetch_counts():
    resp = requests.get(URL, timeout=30)
    resp.raise_for_status()
    park_info = extract_park_info_array(resp.text)
    for entry in park_info:
        if entry.get("id_level") == ID_LEVEL:
            return int(entry["availableCount"]), int(entry["max_count"])
    raise RuntimeError(f"id_level {ID_LEVEL} not found in parkInfo array")


def send_ntfy(title, message, priority="default", tags=None):
    headers = {"Title": title, "Priority": priority}
    if tags:
        headers["Tags"] = tags
    requests.post(f"https://ntfy.sh/{NTFY_TOPIC}", data=message.encode("utf-8"), headers=headers, timeout=15)


def load_previous():
    if STATUS_FILE.exists():
        try:
            return json.loads(STATUS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
    return None


def main():
    available, max_count = fetch_counts()
    below = available <= THRESHOLD
    previous = load_previous()
    was_below = bool(previous and previous.get("below_threshold"))

    if below and not was_below:
        send_ntfy(
            "Randers P-plads lav",
            f"Gasværksgrunden, Jernbanegade: kun {available} ledige pladser (grænse {THRESHOLD}).",
            priority="urgent",
            tags="warning,parking",
        )
    elif not below and was_below:
        send_ntfy(
            "Randers P-plads normal igen",
            f"Gasværksgrunden, Jernbanegade: {available} ledige pladser igen.",
            priority="default",
            tags="white_check_mark",
        )

    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(
        json.dumps(
            {
                "available": available,
                "max": max_count,
                "threshold": THRESHOLD,
                "below_threshold": below,
                "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"available={available} max={max_count} below_threshold={below}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
