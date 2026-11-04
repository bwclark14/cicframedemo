#!/usr/bin/env python3
"""Render a side-by-side review page for an extracted curriculum area.

Usage:  python review.py CONFIG.json --pdf-dir DIR --data DIR [--coverage TEXT]

Reads <slug>.area.json and <slug>.review.json from --data and writes
<slug>.review.html there: each source page image beside the statements
extracted from it, with flagged statements highlighted.
"""
from __future__ import annotations

import argparse
import base64
import html
import io
import json
from collections import defaultdict
from pathlib import Path

import pdfplumber

KIND_LABEL = {"know": "Know", "do": "Do", "note": "Notes", "includes": "Includes",
              "excludes": "Excludes", "vocabulary": "Vocabulary", "milestone": "Milestone"}
FINDING_HELP = {
    "possible-merge": "A Do statement holds more than one sentence. The source may print two statements "
                      "without a blank line between them. Check the page and split it if needed.",
    "no-full-stop": "The statement has no closing full stop. Usually a missing full stop in the source; "
                    "occasionally a statement cut short.",
    "joined-across-page": "Text that ran over a page break was joined into one statement. Check the join.",
    "empty-heading": "An Includes/Notes/Excludes heading is printed with nothing under it. Nothing was imported.",
    "summary-mismatch": "The Understanding differs from the Summary of Progression table.",
    "summary-missing": "This Understanding is not listed in the Summary of Progression.",
    "summary-unmatched": "The Summary of Progression lists an Understanding the strand pages do not contain.",
    "orphan-text": "Text that sits outside any recognised row and was not imported.",
    "unlabelled-cell": "A cell in a Know/Do row has no Know/Do label.",
    "name-variant": "A sub-strand name is printed differently at different levels.",
    "code": "No code is configured for this node; a generated code was used.",
}
LEVEL_NAME = {"early": "Early", "first": "First", "second": "Second", "third": "Third", "fourth": "Fourth"}

CSS = """
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1f23;--muted:#666b73;--line:#e3e0da;--accent:#2f5496;
--know:#2f5496;--do:#3a7d44;--note:#7a5c99;--inc:#8a6d1f;--exc:#a33a3a;--flag:#fff3cd;--flagline:#d4a72c}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16171a;--panel:#1e2024;--ink:#e8e6e1;
--muted:#9aa0a8;--line:#33363c;--accent:#8fb0e8;--know:#8fb0e8;--do:#8ccf96;--note:#c3a6e0;--inc:#e0c46e;
--exc:#f08f8f;--flag:#3a3220;--flagline:#c9a23a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:28px 24px 8px;max-width:1500px;margin:auto}h1{margin:0 0 4px;font-size:26px}
.sub{color:var(--muted)}main{max-width:1500px;margin:auto;padding:0 24px 80px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.stat{background:var(--panel);border:1px solid var(--line);
border-radius:8px;padding:8px 14px}.stat b{display:block;font-size:20px}
section.box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin:18px 0}
h2{font-size:18px;margin:0 0 10px}h3{font-size:15px;margin:14px 0 6px}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid var(--line);padding:6px 8px;
text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:13px}
.ok{color:var(--do);font-weight:600}.bad{color:var(--exc);font-weight:600}
.page{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:20px;align-items:start;
border-top:2px solid var(--line);padding:22px 0}
.page img{width:100%;border:1px solid var(--line);border-radius:6px;background:#fff;position:sticky;top:12px;cursor:zoom-in}
.page img.zoom{position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;z-index:9;background:rgba(0,0,0,.85);cursor:zoom-out;border:0;border-radius:0}
.blk{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:12px}
.blk .meta{font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace}
.und{font-weight:600;margin:4px 0 8px}.inh{color:var(--muted);font-style:italic;margin:4px 0 8px}
ul.st{list-style:none;margin:0;padding:0}ul.st li{padding:5px 6px;border-top:1px dashed var(--line);display:flex;gap:8px}
.k{flex:0 0 74px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding-top:2px}
.k.know{color:var(--know)}.k.do{color:var(--do)}.k.note{color:var(--note)}.k.includes{color:var(--inc)}.k.excludes{color:var(--exc)}
.code{font:11px ui-monospace,Menlo,monospace;color:var(--muted);display:block}
li.flag{background:var(--flag);border-left:3px solid var(--flagline)}.why{font-size:12px;color:var(--muted);display:block}
.body{white-space:pre-wrap;flex:1}a{color:var(--accent)}
@media (max-width:900px){.page{grid-template-columns:1fr}.page img{position:static}}
"""


def page_png(page, resolution=96) -> str:
    buf = io.BytesIO()
    page.to_image(resolution=resolution).original.convert("RGB").save(buf, format="JPEG", quality=62)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def esc(s):
    return html.escape(str(s))


def render(cfg, pdf_dir: Path, data_dir: Path, coverage: str | None):
    slug = cfg["slug"]
    area = json.loads((data_dir / f"{slug}.area.json").read_text())
    review = json.loads((data_dir / f"{slug}.review.json").read_text())
    pages = review["statementPages"]
    flags = defaultdict(list)
    for f in review["findings"]:
        if f.get("code"):
            flags[f["code"]].append(f)

    # Group blocks (with breadcrumb) by the pages their content came from
    by_page = defaultdict(list)

    def walk(node, crumbs):
        crumbs = crumbs + [node["name"]]
        for b in node.get("blocks", []):
            stmt_pages = defaultdict(list)
            for s in b["statements"]:
                stmt_pages[pages.get(s["code"], b["source"]["page"])].append(s)
            if not b["statements"]:
                stmt_pages[b["source"]["page"]] = []
            for p, sts in stmt_pages.items():
                by_page[p].append((crumbs, b, sts))
        for c in node.get("children", []):
            walk(c, crumbs)

    for s in area["strands"]:
        walk(s, [])

    st = review["stats"]["statements"]
    out = [f"<!doctype html><html lang=en><head><meta charset=utf-8>"
           f"<meta name=viewport content='width=device-width,initial-scale=1'>"
           f"<title>{esc(area['name'])} extraction review</title><style>{CSS}</style></head><body>",
           f"<header><h1>{esc(area['name'])}: extraction review</h1>"
           f"<div class=sub>{esc(cfg['pdf'])} · generated from <code>data/{slug}.area.json</code></div></header><main>"]
    out.append("<div class=stats>" + "".join(
        f"<div class=stat><b>{v}</b>{esc(k)}</div>" for k, v in [
            ("strands", review["stats"]["strands"]), ("Understandings", review["stats"]["anchors"]),
            ("blocks", review["stats"]["blocks"]), ("Know", st["know"]), ("Do", st["do"]),
            ("Includes", st["includes"]), ("Excludes", st.get("excludes", 0)), ("Notes", st["note"]),
            ("findings", len(review["findings"]))]) + "</div>")

    # Checks
    summary_issues = [f for f in review["findings"] if f["kind"].startswith("summary")]
    out.append("<section class=box><h2>Automatic checks</h2><table>")
    out.append("<tr><th>Check</th><th>Result</th></tr>")
    out.append(f"<tr><td>Every Understanding matches the Summary of Progression (page {cfg['pages']['summary']})</td><td>"
               + ("<span class=ok>Pass</span>" if not summary_issues else
                  f"<span class=bad>{len(summary_issues)} issue(s)</span>") + "</td></tr>")
    if coverage:
        out.append(f"<tr><td>Every word in the strand tables appears in the extraction</td><td>{coverage}</td></tr>")
    out.append("<tr><td>JSON Schema and anchor rules (<code>tools/validate.py</code>)</td><td>Run separately</td></tr>")
    out.append("</table></section>")

    # Decisions
    out.append("<section class=box><h2>Decisions needed</h2>"
               "<p>Sub-strands are kept exactly as printed. If two names are the same sub-strand, add an entry to "
               "<code>subStrandAliases</code> in the config and re-run.</p><table>"
               "<tr><th>Strand</th><th>Sub-strand</th><th>Levels</th></tr>")
    for strand, subs in review["subStrandsByLevel"].items():
        for name, levels in subs.items():
            out.append(f"<tr><td>{esc(strand)}</td><td>{esc(name)}</td>"
                       f"<td>{', '.join(LEVEL_NAME[l] for l in levels)}</td></tr>")
    out.append("</table></section>")

    # Findings
    groups = defaultdict(list)
    for f in review["findings"]:
        groups[f["kind"]].append(f)
    out.append("<section class=box><h2>Findings to check</h2>")
    for kind, fs in groups.items():
        out.append(f"<h3>{esc(kind)} ({len(fs)})</h3><p class=sub>{esc(FINDING_HELP.get(kind, ''))}</p><table>")
        for f in fs:
            link = f"<a href='#p{f['page']}'>p{f['page']}</a>" if f["page"] else ""
            out.append(f"<tr><td>{link}</td><td><code>{esc(f.get('code', ''))}</code></td>"
                       f"<td>{esc(f.get('text') or f['message'])}</td></tr>")
        out.append("</table>")
    out.append("</section>")

    pdf = pdfplumber.open(str(pdf_dir / cfg["pdf"]))
    for p in sorted(by_page):
        out.append(f"<div class=page id=p{p}><div><img loading=lazy alt='Source page {p}' "
                   f"src='{page_png(pdf.pages[p - 1])}' onclick=\"this.classList.toggle('zoom')\"></div><div>"
                   f"<h2>PDF page {p}</h2>")
        for crumbs, b, sts in by_page[p]:
            lvl = LEVEL_NAME[b["level"]]
            out.append(f"<div class=blk><div class=meta>{esc(b['code'])} · {esc(' › '.join(crumbs))} · {lvl} Level</div>")
            if "understanding" in b:
                out.append(f"<div class=und>Understand: {esc(b['understanding'])}</div>")
            else:
                out.append(f"<div class=inh>Understanding from {esc(b['anchor'])}</div>")
            if sts:
                out.append("<ul class=st>")
                for s in sts:
                    fl = flags.get(s["code"], [])
                    why = "".join(f"<span class=why>⚑ {esc(f['kind'])}</span>" for f in fl)
                    out.append(f"<li class='{'flag' if fl else ''}'><span class='k {s['kind']}'>"
                               f"{KIND_LABEL[s['kind']]}</span><span class=body>{esc(s['body'])}"
                               f"<span class=code>{esc(s['code'])}</span>{why}</span></li>")
                out.append("</ul>")
            out.append("</div>")
        out.append("</div></div>")
    out.append("</main></body></html>")
    target = data_dir / f"{slug}.review.html"
    target.write_text("\n".join(out))
    return target


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config", type=Path)
    ap.add_argument("--pdf-dir", type=Path, required=True)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--coverage", help="coverage result text to show in the checks table")
    a = ap.parse_args()
    print(render(json.loads(a.config.read_text()), a.pdf_dir, a.data, a.coverage))


if __name__ == "__main__":
    main()
