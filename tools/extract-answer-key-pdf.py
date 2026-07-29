#!/usr/bin/env python3
"""
Extract the official GATE answer key from the published PDF.

    python3 tools/extract-answer-key-pdf.py DA_Keys.pdf -o data/import/gate-da-2026-key.json

The key is a table: Q.No | Session | Question Type | Section | Key/Range | Marks.
Its numbering follows the MASTER QUESTION PAPER, which is not the numbering on
any individual candidate's response sheet — GATE shuffles question order per
candidate. Joining the two is the importer's job (see apply-answer-key.ts); it
uses the response sheet's question IDs, not position.

NAT keys are published as ranges ("8.90 to 9.10"), which become a midpoint and
a tolerance. A NAT scored without its tolerance manufactures false wrongs.
"""

import argparse
import json
import re
import sys
from collections import Counter

try:
    from pypdf import PdfReader
except ImportError:
    sys.exit("pypdf is required:  pip install pypdf")

ROW = re.compile(
    r"^\s*(\d{1,3})\s+(\d+)\s+(MCQ|MSQ|NAT)\s+(GA|DA)\s+(.+?)\s+(1|2)\s*$", re.M
)
RANGE = re.compile(r"^\s*(-?[\d.]+)\s+to\s+(-?[\d.]+)\s*$")


def parse_nat(key: str) -> tuple[float, float]:
    """'8.90 to 9.10' -> (midpoint, tolerance). Exact for symmetric ranges."""
    m = RANGE.match(re.sub(r"\s+", " ", key))
    if not m:
        raise ValueError(f"unparseable NAT range: {key!r}")
    lo, hi = float(m.group(1)), float(m.group(2))
    if hi < lo:
        lo, hi = hi, lo
    # Round away binary noise: (8.90 + 9.10)/2 - 8.90 gives 0.09999999999999964,
    # a tolerance fractionally NARROWER than published, which would reject an
    # answer sitting exactly on the range boundary. GATE keys never carry more
    # than a few decimals, so 6 is far more precision than the data has.
    return round((lo + hi) / 2, 6), round((hi - lo) / 2, 6)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--label", default="GATE DA 2026")
    ap.add_argument("--year", type=int, default=2026)
    args = ap.parse_args()

    reader = PdfReader(args.pdf)
    text = "\n".join((p.extract_text() or "") for p in reader.pages)

    entries = []
    for qno, session, qtype, section, key, marks in ROW.findall(text):
        e = {
            "paper_q_no": int(qno),
            "session": int(session),
            "qtype": qtype,
            "section": "GA" if section == "GA" else "SUBJECT",
            "marks": int(marks),
            "key_raw": key.strip(),
        }
        if qtype == "NAT":
            mid, tol = parse_nat(key)
            e["answer"] = f"{mid:g}"
            e["tolerance"] = tol
        elif qtype == "MSQ":
            e["answer"] = ",".join(sorted(s for s in re.split(r"[;,]", key.upper()) if s.strip()))
            e["tolerance"] = None
        else:
            e["answer"] = key.strip().upper()
            e["tolerance"] = None
        entries.append(e)

    entries.sort(key=lambda e: e["paper_q_no"])
    total = sum(e["marks"] for e in entries)
    ga = sum(e["marks"] for e in entries if e["section"] == "GA")
    sessions = sorted({e["session"] for e in entries})

    print(f"parsed {len(entries)} key rows, sessions {sessions}")
    print(f"types {dict(Counter(e['qtype'] for e in entries))}")
    print(f"marks total={total} (GA {ga} + subject {total - ga})")

    problems = []
    if len(entries) != 65:
        problems.append(f"expected 65 rows, parsed {len(entries)}")
    if [e["paper_q_no"] for e in entries] != list(range(1, len(entries) + 1)):
        problems.append("question numbers are not contiguous 1..N")
    if total != 100:
        problems.append(f"marks total {total}, expected 100")
    if ga != 15:
        problems.append(f"GA marks {ga}, expected 15")
    if len(sessions) != 1:
        problems.append(f"key spans multiple sessions {sessions}; supply a single-session key")
    if problems:
        for p in problems:
            print(f"REFUSING TO WRITE: {p}", file=sys.stderr)
        sys.exit(1)

    bundle = {
        "format": "gate-prep-tool/answer-key",
        "version": 1,
        "label": args.label,
        "exam": "GATE DA",
        "year": args.year,
        "session": sessions[0],
        "entries": entries,
    }
    with open(args.out, "w") as f:
        json.dump(bundle, f, indent=1)
        f.write("\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
