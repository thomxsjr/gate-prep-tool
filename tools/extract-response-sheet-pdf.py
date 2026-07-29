#!/usr/bin/env python3
"""
Extract structural metadata from a TCS-iON / digialm candidate response sheet
that has been printed to PDF.

    pip install pypdf
    python3 tools/extract-response-sheet-pdf.py sheet.pdf -o data/import/gate-da-2026-response.json

The durable import path is the HTML sheet (src/scripts/import-response-sheet.ts).
This exists because a printed PDF is sometimes the only copy available.

WHAT IT TAKES  question number, section, type, status, the option chosen or the
               value typed, and the exam's own question ID
WHAT IT DROPS  the question text and the option text — third-party content the
               spec's non-goals forbid storing. In these sheets the options are
               images anyway, so there is nothing to leak.

Marks are not printed on the sheet. They are derived from the published GATE DA
structure (65 questions / 100 marks; GA 10q/15m, subject 55q/85m) and the
convention that 1-mark questions precede 2-mark ones within a section:

    GA       Q1-Q5    1 mark    Q6-Q10   2 marks   ->  5 + 10 = 15
    subject  Q1-Q25   1 mark    Q26-Q55  2 marks   -> 25 + 60 = 85

The script asserts the derived total is 100 and refuses to write otherwise, so
a paper with a different structure fails loudly instead of seeding bad marks.
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


def squash(s: str) -> str:
    """These PDFs render with per-glyph spacing ('N o t  A n s w e re d')."""
    return re.sub(r"\s+", "", s)


def marks_for(section: str, n: int) -> int:
    if section == "GA":
        return 1 if n <= 5 else 2
    return 1 if n <= 25 else 2


def extract(path: str) -> tuple[list[dict], dict]:
    reader = PdfReader(path)
    text = "\n".join((p.extract_text() or "") for p in reader.pages)
    text = text.replace("­", "").replace("ﬁ", "fi")
    lines = [l.rstrip() for l in text.split("\n")]

    meta: dict[str, str] = {}
    for key, label in [
        ("candidate_id", "Candidate ID"),
        ("test_date", "T est Date"),
        ("test_time", "T est Time"),
    ]:
        m = re.search(rf"{re.escape(label)}\s+([^\n]+)", text)
        if m:
            meta[key] = m.group(1).strip()

    records: list[dict] = []
    cur: dict | None = None

    for i, line in enumerate(lines):
        s = squash(line)

        m = re.fullmatch(r"Q\.(\d+)", s)
        if m:
            if cur:
                records.append(cur)
            cur = {
                "number": int(m.group(1)),
                "qtype": None,
                "external_ref": None,
                "status": None,
                "given": None,
            }
            continue

        if cur is None:
            continue

        if s.startswith("QuestionType:"):
            cur["qtype"] = squash(line.split(":", 1)[1])
        elif s.startswith("QuestionID:"):
            cur["external_ref"] = squash(line.split(":", 1)[1])
        elif s.startswith("Status:"):
            cur["status"] = squash(line.split(":", 1)[1])
        elif s.startswith("ChosenOption:"):
            v = squash(line.split(":", 1)[1])
            cur["given"] = None if v in ("--", "") else v
        elif s.startswith("Answer:"):
            # NAT: "Given\nAnswer :\n<value>"
            v = squash(lines[i + 1]) if i + 1 < len(lines) else ""
            cur["given"] = v if v and v != "--" else None

    if cur:
        records.append(cur)

    # Section is inferred from the numbering restart, not from the page header:
    # the header is emitted after its questions in reading order.
    section = "GA"
    prev = 0
    for r in records:
        if r["number"] == 1 and prev != 0:
            section = "SUBJECT"
        r["section"] = section
        r["marks"] = marks_for(section, r["number"])
        prev = r["number"]

    return records, meta


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--label", default="GATE DA 2026")
    ap.add_argument("--year", type=int, default=2026)
    args = ap.parse_args()

    records, meta = extract(args.pdf)

    total = sum(r["marks"] for r in records)
    ga = sum(r["marks"] for r in records if r["section"] == "GA")
    sub = total - ga

    print(f"parsed {len(records)} questions  GA={sum(1 for r in records if r['section']=='GA')} "
          f"SUBJECT={sum(1 for r in records if r['section']=='SUBJECT')}")
    print(f"types {dict(Counter(r['qtype'] for r in records))}")
    print(f"status {dict(Counter(r['status'] for r in records))}")
    print(f"derived marks total={total} (GA {ga} + subject {sub})")

    problems = []
    if len(records) != 65:
        problems.append(f"expected 65 questions, parsed {len(records)}")
    if total != 100:
        problems.append(f"derived marks total {total}, expected 100")
    if ga != 15:
        problems.append(f"GA marks {ga}, expected 15")
    if problems:
        for p in problems:
            print(f"REFUSING TO WRITE: {p}", file=sys.stderr)
        sys.exit(1)

    blanks = [r for r in records if r["given"] is None]
    print(f"non-attempts: {len(blanks)} worth {sum(r['marks'] for r in blanks)} marks")

    bundle = {
        "format": "gate-prep-tool/response-sheet",
        "version": 1,
        "label": args.label,
        "exam": "GATE DA",
        "year": args.year,
        "source_meta": meta,
        "questions": records,
    }
    with open(args.out, "w") as f:
        json.dump(bundle, f, indent=1)
        f.write("\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
