import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
const M = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const db = new PGlite();
await db.exec(fs.readFileSync(`${M}/schema.sql`, 'utf8'));
await db.exec(fs.readFileSync(`${M}/examples/seed-example.sql`, 'utf8'));
const q = async (label, sql) => { const r = await db.query(sql); console.log(`\n## ${label}`); console.table(r.rows); };

await q('Resolved blocks', `SELECT code, node_path, level_code, is_anchor, anchor_code, left(understanding,50) u FROM v_content_block ORDER BY area_slug, level_ordinal, node_path`);
await q('Summary of progression', `SELECT area_slug, node_path, level_code, left(understanding,60) u FROM v_summary_of_progression`);
await q('Third Level IDEAs payload incl. sub-strands', `
  SELECT b.node_path, s.kind, left(s.body,55) body FROM v_content_block b JOIN statement s ON s.block_id=b.id
  WHERE b.area_slug='technologies' AND b.node_path LIKE 'ideas%' AND b.level_code='third' ORDER BY b.position, s.kind, s.position`);
await q('Maths phases', `SELECT s.code, s.kind, s.phase, left(s.body,50) body FROM statement s WHERE code LIKE 'MNU%' ORDER BY s.phase NULLS LAST, s.kind`);
await q('Full-text search "prototype"', `SELECT code, left(body,60) body FROM statement WHERE search @@ to_tsquery('simple','prototypes')`);
await q('French early guidance', `SELECT kind, mode, topic, left(body,45) body FROM guidance_entry WHERE language_code='fr' AND level_code='early' ORDER BY kind, position`);
await q('Scripture', `SELECT g.body, g.ref_selection, r.citation, r.label FROM guidance_entry g JOIN scripture_reference r ON r.guidance_entry_id=g.id ORDER BY r.position`);

const mustFail = async (label, sql) => {
  try { await db.exec(sql); console.log(`FAIL (accepted): ${label}`); process.exitCode = 1; }
  catch (e) { console.log(`ok rejected: ${label} -> ${e.message}`); }
};
console.log('\n## Integrity checks');
await mustFail('block at a level the node does not exist at', `INSERT INTO content_block (code,node_id,level_code,understanding) SELECT 'X1',id,'early','u' FROM structural_node WHERE path='data-rich-world'`);
await mustFail('block with neither understanding nor anchor', `INSERT INTO content_block (code,node_id,level_code) SELECT 'X2',id,'third' FROM structural_node WHERE path='ideas'`);
await mustFail('anchor at a different level', `INSERT INTO content_block (code,node_id,level_code,anchor_block_id) SELECT 'X3',n.id,'fourth',(SELECT id FROM content_block WHERE code='TCH.IDEAS.3.1') FROM structural_node n WHERE path='ideas/business'`);
await db.exec(`INSERT INTO content_block (code,node_id,level_code,understanding) SELECT 'SIB',id,'third','sibling anchor' FROM structural_node WHERE path='ideas/business'`);
await mustFail('anchor on a sibling/non-ancestor node', `INSERT INTO content_block (code,node_id,level_code,anchor_block_id) SELECT 'X4',n.id,'third',(SELECT id FROM content_block WHERE code='SIB') FROM structural_node n WHERE path='ideas/computing-science'`);
await mustFail('anchor losing its understanding while depended on', `UPDATE content_block SET understanding=NULL, anchor_block_id=(SELECT id FROM content_block WHERE code='SIB') WHERE code='TCH.IDEAS.3.1'`);
await mustFail('anchor moving level while depended on', `UPDATE content_block SET level_code='fourth' WHERE code='TCH.IDEAS.3.1'`);
await mustFail('sub-strand directly under area (no parent)', `INSERT INTO structural_node (area_id,node_type,slug,name) SELECT id,'sub_strand','x','X' FROM curriculum_area WHERE slug='technologies'`);
await mustFail('sub-sub-strand directly under strand', `INSERT INTO structural_node (area_id,parent_id,node_type,slug,name) SELECT area_id,id,'sub_sub_strand','x','X' FROM structural_node WHERE path='ideas'`);
await mustFail('parent in another area', `INSERT INTO structural_node (area_id,parent_id,node_type,slug,name) SELECT (SELECT id FROM curriculum_area WHERE slug='languages'),id,'sub_strand','x','X' FROM structural_node WHERE path='ideas'`);
await mustFail('ref_selection on non-scripture entry', `UPDATE guidance_entry SET ref_selection='all' WHERE kind='level_descriptor'`);
await mustFail('unknown statement kind', `INSERT INTO statement (code,block_id,kind,body) SELECT 'X5',id,'skill','x' FROM content_block LIMIT 1`);
await db.exec(`UPDATE structural_node SET slug='ideas-strand' WHERE path='ideas'`);
await q('Child paths after renaming strand', `SELECT path FROM structural_node WHERE path LIKE 'ideas%' ORDER BY path`);
await mustFail('choose without a minimum count', `UPDATE guidance_entry SET ref_choose_min=NULL WHERE kind='scripture_text'`);
await mustFail('minimum count without choose', `UPDATE guidance_entry SET ref_choose_min=2 WHERE kind='level_descriptor'`);
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
