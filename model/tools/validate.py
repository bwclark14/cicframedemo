#!/usr/bin/env python3
"""Validate CIC curriculum interchange documents before import.

Usage:  python validate.py FILE.json [FILE.json ...]
Needs:  pip install jsonschema

Runs the JSON Schema, then the cross-reference rules a schema cannot express
(the same rules the database enforces with triggers):
  * block / statement codes are unique within the document
  * a block's level is one of its node's levels
  * an inheriting block's anchor exists, owns an Understanding, is at the same
    level, and sits on the same node or an ancestor node
"""
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "curriculum.schema.json"


def check_area(doc):
    errors, codes, blocks = [], set(), {}  # blocks: code -> (block, ancestry tuple of paths)

    def walk(node, ancestry):
        path = "/".join([*ancestry, node["slug"]]) if ancestry else node["slug"]
        chain = (*[a for a in _prefixes(ancestry)], path)
        for b in node.get("blocks", []):
            if b["level"] not in node["levels"]:
                errors.append(f"{b['code']}: level '{b['level']}' not among levels of node '{path}' {node['levels']}")
            for c in [b["code"], *[s["code"] for s in b.get("statements", [])]]:
                if c in codes:
                    errors.append(f"duplicate code {c}")
                codes.add(c)
            blocks[b["code"]] = (b, path, chain)
        for child in node.get("children", []):
            walk(child, [*ancestry, node["slug"]])

    for strand in doc["strands"]:
        walk(strand, [])

    for code, (b, path, chain) in blocks.items():
        anchor = b.get("anchor")
        if not anchor:
            continue
        if anchor not in blocks:
            errors.append(f"{code}: anchor {anchor} not found")
            continue
        a, a_path, _ = blocks[anchor]
        if "understanding" not in a:
            errors.append(f"{code}: anchor {anchor} has no understanding")
        if a["level"] != b["level"]:
            errors.append(f"{code}: anchor {anchor} is at level {a['level']}, block is at {b['level']}")
        if a_path not in chain:
            errors.append(f"{code}: anchor {anchor} on '{a_path}' is not this node or an ancestor of '{path}'")
    return errors


def _prefixes(parts):
    return ["/".join(parts[: i + 1]) for i in range(len(parts))]


def validator_for(schema, doc):
    """Validate against the specific document type so errors point at the bad field."""
    kind = "AreaDocument" if "strands" in doc else "GuidanceDocument"
    root = {k: v for k, v in schema.items() if k != "oneOf"}
    return Draft202012Validator({**root, "$ref": f"#/$defs/{kind}"})


def describe(err):
    has_rule = isinstance(err.schema, dict) and err.schema.get("description")
    leaf = None
    if err.context and not has_rule:
        leaf = max(err.context, key=lambda e: len(e.absolute_path))  # deepest sub-error
    e = leaf or err
    where = "/".join(map(str, e.absolute_path)) or "<root>"
    if e.validator in ("oneOf", "not") and isinstance(e.schema, dict) and e.schema.get("description"):
        msg = f"breaks rule: {e.schema['description']}"
    else:
        msg = e.message if len(e.message) < 200 else e.message[:200] + "…"
    return f"schema: {where}: {msg}"


def main(paths):
    schema = json.loads(SCHEMA_PATH.read_text())
    failed = False
    for p in paths:
        doc = json.loads(Path(p).read_text())
        validator = validator_for(schema, doc)
        errs = [describe(e) for e in sorted(validator.iter_errors(doc), key=lambda e: list(e.absolute_path))]
        if not errs and "strands" in doc:
            errs = check_area(doc)
        status = "OK" if not errs else f"{len(errs)} error(s)"
        print(f"{p}: {status}")
        for e in errs:
            print(f"  - {e}")
        failed |= bool(errs)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
