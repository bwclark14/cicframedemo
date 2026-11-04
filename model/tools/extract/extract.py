#!/usr/bin/env python3
"""Extract a CIC Know-Do-Understand framework PDF into an AreaDocument JSON file.

Usage:
    python extract.py CONFIG.json --pdf-dir ../../../frameworks --out ../../data

Writes  <slug>.area.json    the extracted area (validate with tools/validate.py)
        <slug>.review.json  findings for the review step (render with review.py)

Works for frameworks laid out like Technologies: a 'Strand' header row, optional
'Sub-Strand' header row, a pink 'Understand:' row, Know/Do columns, then an
Includes / Notes row, with the level named in the left-hand column.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layout import Band, Cell, Line, analyse_page, paragraphs  # noqa: E402

LEVELS = ["early", "first", "second", "third", "fourth"]
LEVEL_CODE = {"early": "E", "first": "1", "second": "2", "third": "3", "fourth": "4"}
LEVEL_RE = re.compile(r"\b(Early|First|Second|Third|Fourth)\s+Level\b", re.I)
UNDERSTAND_RE = re.compile(r"^Understand\s*:\s*", re.I)
KD_RE = re.compile(r"^(Know|Do)\b\s*:?\s*", re.I)
HEADING_RE = re.compile(r"^(Includes(,)?\s*(but\s+)?(is\s+)?not\s+limited\s+to:?|Includes:?|Excludes:?|Notes:?)$", re.I)
BULLETS = ("\u2022", "\uf0b7", "\u25aa", "\u25e6")   # •, Symbol-font bullet, ▪, ◦
STOP = {"and", "the", "of", "&", "a", "an"}


# --------------------------------------------------------------------------- text helpers

def kd_label(cell) -> str | None:
    """'know' / 'do' when the cell opens with a bold Know / Do label (colon optional)."""
    if not cell.lines:
        return None
    head = cell.lines[0].bold_prefix.replace(":", "").strip().lower()
    return head if head in ("know", "do") else None


def clean(text: str) -> str:
    text = re.sub(r"(?<=[a-z])- (?=[a-z])", "-", text)   # 'high- fidelity' -> 'high-fidelity'
    text = re.sub(r"\s+([.,;:!?)])", r"\1", text)
    text = re.sub(r"\(\s+", "(", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def join_lines(lines: list[Line]) -> str:
    out = ""
    for ln in lines:
        t = ln.text.strip()
        if not out:
            out = t
        elif out.endswith("-"):
            out += t
        else:
            out += " " + t
    return clean(out)


def is_bullet(text: str) -> bool:
    return text.lstrip().startswith(BULLETS)


def strip_bullet(text: str) -> str:
    return text.lstrip().lstrip("".join(BULLETS)).strip()


def para_markdown(lines: list[Line]) -> str:
    """Render a paragraph that may contain bullets as Markdown."""
    parts, cur, cur_bullet = [], [], False
    for ln in lines:
        if is_bullet(ln.text):
            if cur:
                parts.append(("- " if cur_bullet else "") + join_lines(cur))
            ln = Line(ln.top, ln.bottom, ln.x0, strip_bullet(ln.text), ln.bold, "")
            cur, cur_bullet = [ln], True
        else:
            cur.append(ln)
    if cur:
        parts.append(("- " if cur_bullet else "") + join_lines(cur))
    return "\n".join(parts)


def slugify(name: str) -> str:
    s = name.lower().replace("&", " and ")
    s = re.sub(r"\([^)]*\)", "", s)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def initials(name: str) -> str:
    words = [w for w in re.findall(r"[A-Za-z]+", name) if w.lower() not in STOP]
    return "".join(w[0] for w in words).upper() or "X"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


# --------------------------------------------------------------------------- model under construction

@dataclass
class Node:
    name: str
    slug: str
    code: str
    node_type: str
    children: dict = field(default_factory=dict)      # slug -> Node
    blocks: list = field(default_factory=list)
    levels: set = field(default_factory=set)
    names_seen: dict = field(default_factory=dict)   # level -> raw name as printed


@dataclass
class Anchor:
    code: str
    node: Node
    level: str
    understanding: str
    x0: float
    x1: float
    page: int


class Extractor:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.prefix = cfg["codePrefix"]
        self.strands: dict[str, Node] = {}
        self.strand: Node | None = None
        self.level: str | None = None
        self.subs: list[tuple[float, float, Node]] | None = None
        self.pending_subs: list[tuple[float, float, Node]] | None = None
        self.anchors: list[Anchor] = []
        self.blocks: dict[tuple, dict] = {}            # (node code, level, anchor code) -> block
        self.anchor_count: dict[tuple, int] = {}
        self.last_kd: dict | None = None               # x-range -> (block, kind) for page continuations
        self.findings: list[dict] = []
        self.pages: dict[str, int] = {}                # statement code -> page, for findings

    # ------------------------------------------------------------------ findings
    def note(self, kind: str, page: int, msg: str, **extra):
        self.findings.append({"kind": kind, "page": page, "message": msg, **extra})

    # ------------------------------------------------------------------ nodes
    def strand_node(self, name: str, page: int) -> Node:
        slug = slugify(name)
        if slug not in self.strands:
            code = self.cfg.get("strandCodes", {}).get(name)
            if not code:
                code = initials(name)
                self.note("code", page, f"No strand code configured for '{name}'; using '{code}'")
            self.strands[slug] = Node(name, slug, code, "strand")
        return self.strands[slug]

    def sub_node(self, raw: str, level: str, page: int) -> Node:
        name = self.cfg.get("subStrandAliases", {}).get(raw, raw)
        slug = slugify(name)
        parent = self.strand
        if slug not in parent.children:
            code = self.cfg.get("subStrandCodes", {}).get(name)
            if not code:
                code = initials(name)
                self.note("code", page, f"No sub-strand code configured for '{name}'; using '{code}'")
            taken = {c.code for c in parent.children.values()}
            if code in taken:
                raise SystemExit(f"Sub-strand code '{code}' for '{name}' clashes within '{parent.name}'; "
                                 "set subStrandCodes in the config")
            parent.children[slug] = Node(name, slug, code, "sub_strand")
        return parent.children[slug]

    # ------------------------------------------------------------------ blocks
    def anchor_block(self, a: Anchor) -> dict:
        key = (a.node.code, a.level, a.code)
        if key not in self.blocks:
            blk = {"code": a.code, "level": a.level, "understanding": a.understanding,
                   "source": {**self._src(), "page": a.page}, "statements": []}
            self.blocks[key] = blk
            a.node.blocks.append(blk)
            a.node.levels.add(a.level)
        return self.blocks[key]

    def block_for(self, node: Node, anchor: Anchor, page: int) -> dict:
        if node is anchor.node:
            return self.anchor_block(anchor)
        self.anchor_block(anchor)  # make sure the anchor exists first
        key = (node.code, anchor.level, anchor.code)
        if key not in self.blocks:
            n = anchor.code.rsplit(".", 1)[1]
            code = f"{self.prefix}.{self.strand.code}.{node.code}.{LEVEL_CODE[anchor.level]}.{n}"
            blk = {"code": code, "level": anchor.level, "anchor": anchor.code,
                   "source": {**self._src(), "page": page}, "statements": []}
            self.blocks[key] = blk
            node.blocks.append(blk)
            node.levels.add(anchor.level)
        return self.blocks[key]

    def add_statement(self, blk: dict, kind: str, body: str, page: int):
        letter = {"know": "K", "do": "D", "note": "N", "includes": "I", "excludes": "X"}[kind]
        n = sum(1 for s in blk["statements"] if s["kind"] == kind) + 1
        st = {"code": f"{blk['code']}.{letter}{n}", "kind": kind, "body": body}
        blk["statements"].append(st)
        self.pages[st["code"]] = page
        return st

    def _lint_statement(self, st: dict, page: int):
        body = st["body"]
        sentences = [s for s in re.split(r"(?<=[.!?])\s+(?=[A-Z])", body) if s]
        if st["kind"] == "do" and len(sentences) > 1:
            self.note("possible-merge", page, "Do statement contains more than one sentence; "
                      "check whether two statements ran together", code=st["code"], text=body)
        if not re.search(r"[.!?)]$", body):
            self.note("no-full-stop", page, "Statement does not end with a full stop; "
                      "check for a split or truncated statement", code=st["code"], text=body)

    def _src(self):
        s = self.cfg["source"]
        return {"title": s["title"], "version": s["version"]}

    # ------------------------------------------------------------------ geometry helpers
    def anchor_for(self, x0: float, x1: float) -> Anchor | None:
        cx = (x0 + x1) / 2
        cands = [a for a in self.anchors if a.level == self.level and a.node in self._strand_tree()]
        hits = [a for a in cands if a.x0 - 2 <= cx <= a.x1 + 2]
        return hits[-1] if hits else (cands[-1] if cands else None)

    def _strand_tree(self):
        return [self.strand, *self.strand.children.values()] if self.strand else []

    def node_for(self, x0: float, x1: float) -> Node:
        if not self.subs:
            return self.strand
        covered = [n for (a, b, n) in self.subs if x0 - 3 <= a and b <= x1 + 3]
        if len(covered) > 1:
            return self.strand
        cx = (x0 + x1) / 2
        for a, b, n in self.subs:
            if a - 2 <= cx <= b + 2:
                return n
        return self.strand

    # ------------------------------------------------------------------ band handling
    def classify(self, band: Band, next_band: Band | None) -> str:
        label = band.left_label.replace(" ", "").lower()
        texts = [c.text.strip() for c in band.cells]
        if label.startswith("strand"):
            return "strand"
        if label.startswith("sub-strand") or label.startswith("substrand"):
            return "subs"
        if not any(texts):
            return "empty"
        if any(UNDERSTAND_RE.match(t) for t in texts):
            return "understand"
        if any(kd_label(c) for c in band.cells):
            return "kd"
        if any(c.lines and HEADING_RE.match(c.lines[0].bold_prefix or c.lines[0].text) for c in band.cells):
            return "extras"
        if (next_band is not None and any(UNDERSTAND_RE.match(c.text.strip()) for c in next_band.cells)
                and all(len(c.lines) <= 2 for c in band.cells)):
            return "subs"
        return "continuation"

    def handle(self, band: Band, kind: str, level_hint: str | None):
        page = band.page
        if level_hint:
            if level_hint != self.level:
                self.subs = None
                self.last_kd = None
            self.level = level_hint

        if kind == "strand":
            name = clean(" ".join(c.text for c in band.cells))
            self.strand = self.strand_node(name, page)
            self.subs = self.pending_subs = None
            self.last_kd = None
        elif kind == "subs":
            self.pending_subs = []
            for c in band.cells:
                if c.text.strip():
                    raw = clean(c.text)
                    self.pending_subs.append((c.x0, c.x1, self.sub_node(raw, self.level, page), raw))
        elif kind == "understand":
            if self.pending_subs is not None:
                # The header row sits above the level's left-hand cell, so record names once the level is known
                for _, _, node, raw in self.pending_subs:
                    node.names_seen.setdefault(self.level, raw)
                self.subs = [(x0, x1, node) for x0, x1, node, _ in self.pending_subs]
                self.pending_subs = None
            for c in band.cells:
                t = c.text.strip()
                if not UNDERSTAND_RE.match(t):
                    continue
                text = clean(UNDERSTAND_RE.sub("", join_lines(c.lines)))
                node = self.node_for(c.x0, c.x1)
                key = (node.code, self.level)
                self.anchor_count[key] = self.anchor_count.get(key, 0) + 1
                parts = [self.prefix, self.strand.code] + ([node.code] if node is not self.strand else [])
                code = ".".join(parts + [LEVEL_CODE[self.level], str(self.anchor_count[key])])
                a = Anchor(code, node, self.level, text, c.x0, c.x1, page)
                self.anchors.append(a)
                self.anchor_block(a)
            self.last_kd = None
        elif kind == "kd":
            self.last_kd = {}
            for c in band.cells:
                kind_ = kd_label(c)
                if not kind_:
                    if c.text.strip():
                        self.note("unlabelled-cell", page, "Cell in a Know/Do row has no Know:/Do: label",
                                  text=c.text[:200])
                    continue
                self._kd_cell(c, kind_, page)
        elif kind == "continuation":
            if not self.last_kd:
                self.note("orphan-text", page, "Text outside any recognised row; not imported",
                          text=" | ".join(c.text for c in band.cells)[:300])
                return
            for c in band.cells:
                if not c.text.strip():
                    continue
                target = self._match_column(c)
                if target is None:
                    self.note("orphan-text", page, "Continuation text with no matching column above",
                              text=c.text[:200])
                    continue
                self._kd_cell(c, target["kind"], page, continuing=target)
        elif kind == "extras":
            self.last_kd = None
            for c in band.cells:
                self._extras_cell(c, page)

    def _match_column(self, cell: Cell):
        cx = (cell.x0 + cell.x1) / 2
        for (a, b), t in self.last_kd.items():
            if a - 3 <= cx <= b + 3:
                return t
        return None

    def _kd_cell(self, cell: Cell, kind: str, page: int, continuing: dict | None = None):
        anchor = self.anchor_for(cell.x0, cell.x1)
        if anchor is None:
            self.note("no-understanding", page, "Know/Do cell with no Understand row above it", text=cell.text[:200])
            return
        node = self.node_for(cell.x0, cell.x1)
        blk = self.block_for(node, anchor, page)
        lines = list(cell.lines)
        if lines and not continuing:
            first = lines[0]
            rest = KD_RE.sub("", first.text).strip()
            lines[0] = Line(first.top, first.bottom, first.x0, rest, first.bold, "")
            if not rest:
                lines = lines[1:]
        paras = paragraphs(lines)
        for i, p in enumerate(paras):
            body = para_markdown(p)
            if not body:
                continue
            if i == 0 and continuing and continuing.get("last"):
                # First paragraph on a new page continues the last statement unless it starts a new sentence
                prev = continuing["last"]
                if not re.search(r"[.!?]$", prev["body"]) or body[:1].islower():
                    prev["body"] = clean(prev["body"] + " " + body)
                    self.note("joined-across-page", page, "Joined text across a page break",
                              code=prev["code"], text=prev["body"])
                    continue
            if is_bullet(p[0].text) and blk["statements"] and blk["statements"][-1]["kind"] == kind:
                blk["statements"][-1]["body"] += "\n" + body
                continue
            st = self.add_statement(blk, kind, body, page)
            if continuing is not None:
                continuing["last"] = st
        entry = {"kind": kind, "last": blk["statements"][-1] if blk["statements"] else None}
        if continuing is None:
            self.last_kd[(cell.x0, cell.x1)] = entry
        else:
            continuing.update({k: v for k, v in entry.items() if v is not None})

    def _extras_cell(self, cell: Cell, page: int):
        sections: list[tuple[str, list[Line]]] = []
        for ln in cell.lines:
            head = ln.bold_prefix or ""
            if head and HEADING_RE.match(head):
                kind = {"note": "note", "excl": "excludes"}.get(head.lower()[:4], "includes")
                rest = ln.text[len(head):].strip()
                sections.append((kind, []))
                if rest:
                    sections[-1][1].append(Line(ln.top, ln.bottom, ln.x0, rest, False, ""))
            elif sections:
                sections[-1][1].append(ln)
            elif ln.text.strip():
                self.note("orphan-text", page, "Text before any Includes/Notes heading", text=ln.text)
        if not sections:
            return
        anchor = self.anchor_for(cell.x0, cell.x1)
        if anchor is None:
            self.note("no-understanding", page, "Includes/Notes with no Understand row above it", text=cell.text[:200])
            return
        node = self.node_for(cell.x0, cell.x1)
        for kind, lines in sections:
            if not lines:
                self.note("empty-heading", page, f"'{kind.capitalize()}' heading has "
                          f"no content in the source ({node.name}, {self.level} level)")
                continue
            body = "\n\n".join(para_markdown(p) for p in paragraphs(lines))
            blk = self.block_for(node, anchor, page)
            self.add_statement(blk, kind, body, page)


# --------------------------------------------------------------------------- front matter

def purpose_and_big_ideas(pdf, page_no: int):
    page = pdf.pages[page_no - 1]
    text = page.extract_text()
    m = re.search(r"Purpose Statement\s*\n(.*?)\n\s*Big Ideas", text, re.S)
    purpose = clean(m.group(1).replace("\n", " ")) if m else None
    ideas = []
    tables = page.find_tables()
    if tables:
        t = tables[-1]
        header = t.rows[0]
        heads = [(c, page.within_bbox(c).extract_text().strip()) for c in header.cells if c]
        heads = [(c, h) for c, h in heads if h]
        body_cells = [c for row in t.rows[1:] for c in row.cells if c]
        for (c, name) in heads:
            # The description sits in the body cell under this header (body cells are merged and
            # wider than the header cells). within_bbox keeps only characters wholly inside it.
            cx = (c[0] + c[2]) / 2
            cell = next((b for b in body_cells if b[0] <= cx < b[2]), None)
            if cell is None:
                continue
            desc = clean(page.within_bbox(cell).extract_text().replace("\n", " "))
            ideas.append({"name": name, "description": desc})
    return purpose, ideas


def summary_of_progression(pdf, page_no: int, cfg: dict):
    rows = pdf.pages[page_no - 1].extract_tables()[0]
    out = {}
    names = cfg.get("summaryStrandNames", {})
    for r in rows[2:]:
        strand = clean((r[0] or "").replace("\n", " "))
        strand = names.get(strand, strand)
        for lvl, cell in zip(LEVELS, r[1:6]):
            if cell and cell.strip():
                out[(slugify(strand), lvl)] = clean(cell.replace("\n", " "))
    return out


# --------------------------------------------------------------------------- driver

def node_json(n: Node) -> dict:
    order = {lvl: i for i, lvl in enumerate(LEVELS)}
    d = {"slug": n.slug, "name": n.name, "levels": sorted(n.levels, key=order.get)}
    if n.blocks:
        d["blocks"] = sorted(n.blocks, key=lambda b: order[b["level"]])
    if n.children:
        d["children"] = [node_json(c) for c in n.children.values()]
    return d


def run(cfg_path: Path, pdf_dir: Path, out_dir: Path):
    cfg = json.loads(cfg_path.read_text())
    pdf_path = pdf_dir / cfg["pdf"]
    pdf = pdfplumber.open(str(pdf_path))
    ex = Extractor(cfg)

    purpose, ideas = purpose_and_big_ideas(pdf, cfg["pages"]["purpose"])
    summary = summary_of_progression(pdf, cfg["pages"]["summary"], cfg)

    bands: list[tuple[Band, str | None]] = []
    for n in range(cfg["pages"]["strandsFrom"], cfg["pages"]["strandsTo"] + 1):
        page = pdf.pages[n - 1]
        lay = analyse_page(page, n)
        if not lay:
            continue
        for b in lay.bands:
            mid = (b.top + b.bottom) / 2
            left = next((c for c in lay.left_cells if c.top <= mid < c.bottom), None)
            m = LEVEL_RE.search(left.text) if left else None
            bands.append((b, m.group(1).lower() if m else None))

    for i, (b, lvl) in enumerate(bands):
        nxt = bands[i + 1][0] if i + 1 < len(bands) else None
        kind = ex.classify(b, nxt)
        ex.handle(b, kind, lvl)

    for blk in ex.blocks.values():
        for st in blk["statements"]:
            if st["kind"] in ("know", "do"):
                ex._lint_statement(st, ex.pages[st["code"]])

    # Strand levels also come from the Summary of Progression
    for (sslug, lvl) in summary:
        if sslug in ex.strands:
            ex.strands[sslug].levels.add(lvl)

    # Cross-check every anchor against the Summary of Progression
    seen = set()
    for a in ex.anchors:
        sslug = next(s for s, n in ex.strands.items() if a.node is n or a.node in n.children.values())
        expected = summary.get((sslug, a.level))
        seen.add((sslug, a.level))
        if expected is None:
            ex.note("summary-missing", a.page, f"Understanding for {sslug} at {a.level} level is not in the "
                    "Summary of Progression", code=a.code, text=a.understanding)
        elif norm(expected) != norm(a.understanding):
            ex.note("summary-mismatch", a.page, "Understanding differs from the Summary of Progression",
                    code=a.code, text=a.understanding, expected=expected)
    for key, text in summary.items():
        if key not in seen:
            ex.note("summary-unmatched", cfg["pages"]["summary"],
                    f"Summary of Progression lists an Understanding for {key[0]} at {key[1]} level "
                    "that was not found in the strand pages", text=text)

    # Sub-strand name variants across levels
    for s in ex.strands.values():
        for c in s.children.values():
            variants = sorted(set(c.names_seen.values()))
            if len(variants) > 1:
                ex.note("name-variant", 0, f"Sub-strand '{c.name}' in {s.name} printed as {variants}")
    names = {s.name: sorted(c.name for c in s.children.values()) for s in ex.strands.values()}

    area = {
        "slug": cfg["slug"],
        "name": cfg["name"],
        "purposeStatement": purpose,
        "source": {**cfg["source"], "fileName": cfg["pdf"]},
        "bigIdeas": ideas,
        "strands": [node_json(s) for s in ex.strands.values()],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{cfg['slug']}.area.json").write_text(json.dumps(area, indent=2, ensure_ascii=False) + "\n")
    stats = {
        "strands": len(ex.strands),
        "subStrands": names,
        "blocks": len(ex.blocks),
        "anchors": len(ex.anchors),
        "statements": {k: sum(1 for b in ex.blocks.values() for s in b["statements"] if s["kind"] == k)
                       for k in ("know", "do", "includes", "excludes", "note")},
    }
    review = {"area": cfg["slug"], "pdf": str(pdf_path), "stats": stats, "findings": ex.findings,
              "statementPages": ex.pages,
              "subStrandsByLevel": {s.name: {c.name: sorted(c.names_seen, key=LEVELS.index)
                                             for c in s.children.values()} for s in ex.strands.values()}}
    (out_dir / f"{cfg['slug']}.review.json").write_text(json.dumps(review, indent=2, ensure_ascii=False) + "\n")
    return area, review


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config", type=Path)
    ap.add_argument("--pdf-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    _, review = run(args.config, args.pdf_dir, args.out)
    print(json.dumps(review["stats"], indent=2))
    counts = {}
    for f in review["findings"]:
        counts[f["kind"]] = counts.get(f["kind"], 0) + 1
    print("findings:", counts)


if __name__ == "__main__":
    main()
