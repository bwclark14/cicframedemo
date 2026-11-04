#!/usr/bin/env bash
# Extract one curriculum area and produce its review page.
#   tools/extract/run.sh technologies          (run from model/)
# Uses $PYTHON if set (needs pdfplumber + jsonschema), else python3.
set -euo pipefail
AREA="${1:?usage: run.sh <area-config-name>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MODEL="$(cd "$HERE/../.." && pwd)"
PY="${PYTHON:-python3}"
CFG="$HERE/configs/$AREA.json"
PDFS="$MODEL/../frameworks"
DATA="$MODEL/data"

echo "== extract"
"$PY" "$HERE/extract.py" "$CFG" --pdf-dir "$PDFS" --out "$DATA" | tail -1
echo "== coverage"
if COV="$("$PY" "$HERE/coverage.py" "$CFG" --pdf-dir "$PDFS" --area "$DATA/$AREA.area.json")"; then
  echo "$COV"; COV_HTML="<span class=ok>Pass</span> — $(echo "$COV" | grep 'source words')"
else
  echo "$COV"; COV_HTML="<span class=bad>Differences found</span> — run coverage.py for detail"
fi
echo "== validate"
"$PY" "$MODEL/tools/validate.py" "$DATA/$AREA.area.json"
echo "== web manifest"
"$PY" - "$DATA" <<'PYEOF'
import json, sys, pathlib
d = pathlib.Path(sys.argv[1])
areas = [{"slug": a["slug"], "name": a["name"], "file": f.name}
         for f in sorted(d.glob("*.area.json")) for a in [json.loads(f.read_text())]]
(d / "areas.json").write_text(json.dumps({"areas": areas}, indent=2) + "\n")
print(f"{len(areas)} area(s) in data/areas.json")
PYEOF
echo "== review"
"$PY" "$HERE/review.py" "$CFG" --pdf-dir "$PDFS" --data "$DATA" --coverage "$COV_HTML"
