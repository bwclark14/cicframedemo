#!/usr/bin/env python3
"""Check that an extracted area accounts for every word in the source tables.

Usage:  python coverage.py CONFIG.json --pdf-dir DIR --area AREA.json

Compares the words inside the strand tables of the PDF (pages strandsFrom..strandsTo,
excluding the left label column and the Know/Do/Understand/Includes/Notes labels)
with the words in the extracted JSON. Prints words that were dropped or invented.
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import analyse_page  # noqa: E402
from extract import Extractor  # noqa: E402

LABEL_RE = re.compile(r"^(Understand\s*:?|Know\s*:?|Do\s*:?|Includes(,)?\s*(but\s+)?(is\s+)?not\s+limited\s+to:?|Includes:?|Excludes:?|Notes:?)\s*", re.I)


def tokens(text: str):
    return re.findall(r"[a-z0-9]+", text.lower())


def pdf_tokens(cfg, pdf_dir):
    pdf = pdfplumber.open(str(pdf_dir / cfg["pdf"]))
    out, headers = Counter(), Counter()
    bands = []
    for n in range(cfg["pages"]["strandsFrom"], cfg["pages"]["strandsTo"] + 1):
        lay = analyse_page(pdf.pages[n - 1], n)
        if lay:
            bands.extend(lay.bands)
    classify = Extractor(cfg).classify
    for i, b in enumerate(bands):
        kind = classify(b, bands[i + 1] if i + 1 < len(bands) else None)
        for c in b.cells:
            for j, ln in enumerate(c.lines):
                # labels open a cell (Know:/Do:/Understand:) or a section (Includes/Excludes/Notes)
                text = LABEL_RE.sub("", ln.text) if (j == 0 or ln.bold_prefix) else ln.text
                (headers if kind in ("strand", "subs") else out).update(tokens(text))
    return out, headers


def json_tokens(area):
    out, names = Counter(), Counter()

    def walk(node):
        names.update(tokens(node["name"]))
        for b in node.get("blocks", []):
            out.update(tokens(b.get("understanding", "")))
            for s in b.get("statements", []):
                out.update(tokens(s["body"]))
        for c in node.get("children", []):
            walk(c)

    for s in area["strands"]:
        walk(s)
    return out, names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config", type=Path)
    ap.add_argument("--pdf-dir", type=Path, required=True)
    ap.add_argument("--area", type=Path, required=True)
    a = ap.parse_args()
    cfg = json.loads(a.config.read_text())
    (src, src_heads), (got, got_names) = pdf_tokens(cfg, a.pdf_dir), json_tokens(json.loads(a.area.read_text()))
    # Node names are printed on every level's header row but stored once, so compare their vocabulary only.
    alias_words = Counter(t for k, v in cfg.get("subStrandAliases", {}).items() for t in tokens(k + " " + v))
    name_gaps = set(src_heads) - set(got_names) - set(alias_words)
    print("header words with no matching node name:", sorted(name_gaps) or "none")
    missing, extra = src - got, got - src
    print(f"source words: {sum(src.values())}, extracted words: {sum(got.values())}")
    print(f"in PDF but not extracted ({sum(missing.values())}):", dict(missing.most_common(60)))
    print(f"extracted but not in PDF ({sum(extra.values())}):", dict(extra.most_common(60)))
    return 1 if (missing or extra or name_gaps) else 0


if __name__ == "__main__":
    sys.exit(main())
