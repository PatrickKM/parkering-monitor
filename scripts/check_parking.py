import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

URL = "https://www.cibos2.dk/parkeringranders"
ID_LEVEL = 3  # fixed id for "Parkering Gasværksgrunden, Jernbanegade"
THRESHOLD = int(os.environ.get("PARKING_THRESHOLD", "20"))
NTFY_TOPIC = os.environ["NTFY_TOPIC"]
STATUS_FILE = Path(__file__).resolve().parent.parent / "docs" / "status.json"

OBJ_RE = re.compile(r"\{[^{}]*\"id_level\"\s*:\s*" + str(ID_LEVEL) + r"\b[^{}]*\}")
AVAIL_RE = re.compile(r"\"availableCount\"\s*:\s*(\d+)")
MAX_RE = re.compile(r"\"max_count\"\s*:\s*(\d+)")


def fetch_counts():
    resp = requests.get(URL, timeout=30)
    resp.raise_for_status()
    match = OBJ_RE.search(resp.text)
    if not match:
        raise RuntimeError("id_level 3 block not found in page — site markup may have changed")
    chunk = match.group(0)
    avail = AVAIL_RE.search(chunk)
    mx = MAX_RE.search(chunk)
    if not avail or not mx:
        raise RuntimeError("availableCount/max_count not found in matched block")
    return int(avail.group(1)), int(mx.group(1))


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
