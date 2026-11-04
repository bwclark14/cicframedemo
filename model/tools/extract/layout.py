"""Page layout stage: turn a framework PDF page into table bands and cells.

The CIC frameworks are landscape Word documents whose tables are drawn with
thin filled rectangles (one per cell edge) plus coloured shading fills. This
module recovers the grid from the thin rules only, then assigns words to
cells and groups them into lines and paragraphs.
"""
from __future__ import annotations

from dataclasses import dataclass, field

RULE_MAX = 2.0          # a rect thinner than this (pt) is a border rule, not shading
HEADER_Y = 50           # 'Return to Contents' sits above this
RULE_FOOTER = 48        # rules below height-48 are page furniture
TEXT_FOOTER = 57        # footer text ('6 | Draft Technical Framework…') starts below height-57
LEFT_COL_X = 88         # the level / 'Strand' label column ends here
ROW_COVERAGE = 0.5      # a horizontal rule row must span this share of the content width
SNAP = 2.0              # tolerance when clustering rule coordinates


@dataclass
class Line:
    top: float
    bottom: float
    x0: float
    text: str
    bold: bool          # every word bold
    bold_prefix: str    # leading run of bold words (e.g. 'Know:')


@dataclass
class Cell:
    x0: float
    x1: float
    top: float
    bottom: float
    lines: list[Line] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(l.text for l in self.lines)


@dataclass
class Band:
    page: int
    top: float
    bottom: float
    cells: list[Cell]          # content cells, left to right (excludes the left label column)
    left_label: str            # text in the left column alongside this band


@dataclass
class PageLayout:
    page: int
    bands: list[Band]
    left_cells: list[Cell]     # merged cells of the left label column


def _cluster(values, tol=SNAP):
    out = []
    for v in sorted(values):
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(c) / len(c) for c in out]


def _union_len(intervals):
    total, cur = 0.0, None
    for a, b in sorted(intervals):
        if cur is None or a > cur[1]:
            if cur:
                total += cur[1] - cur[0]
            cur = [a, b]
        else:
            cur[1] = max(cur[1], b)
    if cur:
        total += cur[1] - cur[0]
    return total


def _rules(page):
    h, v = [], []
    for r in page.rects:
        w, ht = r["x1"] - r["x0"], r["bottom"] - r["top"]
        if ht <= RULE_MAX and w > RULE_MAX:
            h.append(((r["top"] + r["bottom"]) / 2, r["x0"], r["x1"]))
        elif w <= RULE_MAX and ht > RULE_MAX:
            v.append(((r["x0"] + r["x1"]) / 2, r["top"], r["bottom"]))
    for ln in page.lines:
        if abs(ln["top"] - ln["bottom"]) <= RULE_MAX:
            h.append((ln["top"], ln["x0"], ln["x1"]))
        elif abs(ln["x0"] - ln["x1"]) <= RULE_MAX:
            v.append((ln["x0"], ln["top"], ln["bottom"]))
    limit = page.height - RULE_FOOTER
    h = [r for r in h if HEADER_Y < r[0] < limit]
    v = [r for r in v if r[2] > HEADER_Y and r[1] < limit]
    return h, v


def _words(page):
    words = page.extract_words(extra_attrs=["fontname", "size"], keep_blank_chars=False, use_text_flow=False)
    limit = page.height - TEXT_FOOTER
    return [w for w in words if HEADER_Y < w["top"] < limit]


def _lines(words) -> list[Line]:
    """Group words (already restricted to one cell) into visual lines."""
    rows: list[list[dict]] = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if rows and abs(w["top"] - rows[-1][0]["top"]) <= 2.5:
            rows[-1].append(w)
        else:
            rows.append([w])
    out = []
    for r in rows:
        r.sort(key=lambda w: w["x0"])
        bold = [("Bold" in w["fontname"]) for w in r]
        prefix = []
        for w, b in zip(r, bold):
            if not b:
                break
            prefix.append(w["text"])
        out.append(Line(top=min(w["top"] for w in r), bottom=max(w["bottom"] for w in r),
                        x0=r[0]["x0"], text=" ".join(w["text"] for w in r),
                        bold=all(bold), bold_prefix=" ".join(prefix)))
    return out


def _in(w, x0, x1, top, bottom):
    cx = (w["x0"] + w["x1"]) / 2
    cy = (w["top"] + w["bottom"]) / 2
    return x0 <= cx < x1 and top <= cy < bottom


def analyse_page(page, page_no: int) -> PageLayout | None:
    h, v = _rules(page)
    if not h or not v:
        return None
    words = _words(page)

    table_x0 = min(r[0] for r in v)
    table_x1 = max(r[0] for r in v)
    content_x0 = LEFT_COL_X
    content_w = table_x1 - content_x0

    # Row boundaries: y positions where horizontal rules cover enough of the content width.
    rows = []
    for y in _cluster([r[0] for r in h]):
        segs = [(max(a, content_x0), min(b, table_x1)) for (yy, a, b) in h if abs(yy - y) <= SNAP]
        segs = [s for s in segs if s[1] > s[0]]
        if _union_len(segs) >= ROW_COVERAGE * content_w:
            rows.append(y)
    rows = _cluster(rows, tol=4)

    # Left label column: its own horizontal rules split it into merged cells.
    left_ys = sorted(_cluster([y for (y, a, b) in h if a <= table_x0 + SNAP and b >= content_x0 - 6]))
    left_cells = []
    for top, bottom in zip(left_ys, left_ys[1:]):
        ws = [w for w in words if _in(w, table_x0 - 1, content_x0, top, bottom)]
        left_cells.append(Cell(table_x0, content_x0, top, bottom, _lines(ws)))

    bands = []
    for top, bottom in zip(rows, rows[1:]):
        height = bottom - top
        xs = _cluster([x for (x, a, b) in v
                       if x > content_x0 - 6 and min(b, bottom) - max(a, top) >= 0.5 * height])
        xs = [x for x in xs if x >= content_x0 - 6]
        cells = []
        for x0, x1 in zip(xs, xs[1:]):
            ws = [w for w in words if _in(w, x0, x1, top, bottom)]
            cells.append(Cell(x0, x1, top, bottom, _lines(ws)))
        mid = (top + bottom) / 2
        left = next((c for c in left_cells if c.top <= mid < c.bottom), None)
        label = ""
        if left is not None:
            # Only the part of the left cell beside this band, so 'Strand' / 'Sub-Strand' stay local.
            label = " ".join(l.text for l in left.lines if top - 2 <= l.top < bottom)
        bands.append(Band(page_no, top, bottom, cells, label))
    return PageLayout(page_no, bands, left_cells)


def paragraphs(lines: list[Line], gap_ratio: float = 0.55) -> list[list[Line]]:
    """Split lines into paragraphs at blank lines.

    Measured as white space between one line's bottom and the next line's top,
    relative to text height: single-spaced lines leave ~0.2x, a blank line ~1.3x.
    """
    if not lines:
        return []
    paras = [[lines[0]]]
    for prev, cur in zip(lines, lines[1:]):
        height = max(prev.bottom - prev.top, 1.0)
        if cur.top - prev.bottom > gap_ratio * height:
            paras.append([cur])
        else:
            paras[-1].append(cur)
    return paras
