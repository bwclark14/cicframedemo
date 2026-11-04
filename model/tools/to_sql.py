#!/usr/bin/env python3
"""Convert an AreaDocument JSON file into SQL INSERTs for schema.sql.

Usage:  python to_sql.py data/technologies.area.json > technologies.sql

The output is one transaction that replaces the area if it already exists
(curriculum_area delete cascades to its nodes, blocks and statements).
Blocks are inserted anchors-first so the anchor trigger can resolve them.
"""
import json
import sys


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(path):
    a = json.load(open(path))
    src = a.get("source", {})
    out = ["BEGIN;",
           f"DELETE FROM curriculum_area WHERE slug = {q(a['slug'])};",
           f"INSERT INTO curriculum_area (slug, name, family, content_language, purpose_statement) VALUES "
           f"({q(a['slug'])}, {q(a['name'])}, {q(a.get('family'))}, {q(a.get('contentLanguage', 'en'))}, "
           f"{q(a.get('purposeStatement'))});"]
    area = f"(SELECT id FROM curriculum_area WHERE slug = {q(a['slug'])})"
    doc = "NULL"
    if src:
        out.append(f"INSERT INTO source_document (title, doc_type, area_id, version, published_on, status, file_name) "
                   f"VALUES ({q(src['title'])}, {q(src.get('docType', 'technical_framework'))}, {area}, "
                   f"{q(src['version'])}, {q(src.get('publishedOn'))}, {q(src.get('status', 'draft'))}, "
                   f"{q(src.get('fileName'))});")
        doc = (f"(SELECT id FROM source_document WHERE area_id = {area} AND title = {q(src['title'])} "
               f"AND version = {q(src['version'])} ORDER BY id LIMIT 1)")
    for i, b in enumerate(a.get("bigIdeas", []), 1):
        out.append(f"INSERT INTO big_idea (area_id, name, description, position) VALUES "
                   f"({area}, {q(b['name'])}, {q(b.get('description'))}, {i});")

    anchors, inheritors = [], []

    def node(n, parent_path, ntype, pos):
        path = f"{parent_path}/{n['slug']}" if parent_path else n["slug"]
        parent = (f"(SELECT id FROM structural_node WHERE area_id = {area} AND path = {q(parent_path)})"
                  if parent_path else "NULL")
        out.append(f"INSERT INTO structural_node (area_id, parent_id, node_type, slug, name, description, position) "
                   f"VALUES ({area}, {parent}, {q(ntype)}, {q(n['slug'])}, {q(n['name'])}, "
                   f"{q(n.get('description'))}, {pos});")
        nid = f"(SELECT id FROM structural_node WHERE area_id = {area} AND path = {q(path)})"
        for lvl in n["levels"]:
            out.append(f"INSERT INTO node_level (node_id, level_code) VALUES ({nid}, {q(lvl)});")
        for j, b in enumerate(n.get("blocks", []), 1):
            (anchors if "understanding" in b else inheritors).append((nid, j, b))
        child_type = {"strand": "sub_strand", "sub_strand": "sub_sub_strand"}.get(ntype)
        for k, c in enumerate(n.get("children", []), 1):
            node(c, path, child_type, k)

    for i, s in enumerate(a["strands"], 1):
        node(s, None, "strand", i)

    for nid, pos, b in anchors + inheritors:
        page = b.get("source", {}).get("page")
        anchor = (f"(SELECT id FROM content_block WHERE code = {q(b['anchor'])})" if "anchor" in b else "NULL")
        meta = json.dumps({"doQualifier": b["doQualifier"]}) if b.get("doQualifier") else "{}"
        out.append(f"INSERT INTO content_block (code, node_id, level_code, understanding, anchor_block_id, position, "
                   f"source_document_id, source_page, metadata) VALUES ({q(b['code'])}, {nid}, {q(b['level'])}, "
                   f"{q(b.get('understanding'))}, {anchor}, {pos}, {doc}, {q(page)}, {q(meta)}::jsonb);")
        blk = f"(SELECT id FROM content_block WHERE code = {q(b['code'])})"
        for k, s in enumerate(b.get("statements", []), 1):
            out.append(f"INSERT INTO statement (code, block_id, kind, phase, body, position) VALUES "
                       f"({q(s['code'])}, {blk}, {q(s['kind'])}, {q(s.get('phase'))}, {q(s['body'])}, {k});")
    out.append("COMMIT;")
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
