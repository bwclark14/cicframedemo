-- Sample data drawn from the November 2026 drafts. Exercises:
--   * strand-level anchor at Early Level (Technologies / IDEAs)
--   * strand anchor + sub-strand payloads at Third Level (Business, D&E, Computing Science)
--   * a level-restricted strand (A Data Rich World: Third–Fourth only)
--   * Beginning/End-of-level phases (Numeracy and Mathematics)
--   * French progression guidance and RC scripture texts

-- Areas ----------------------------------------------------------------------
INSERT INTO curriculum_area (slug, name, family, purpose_statement) VALUES
 ('technologies', 'Technologies', NULL,
  'Learners use ethical, sustainable and innovative approaches to address real-world challenges, connecting theory and practice through technological activity. This supports them to become adaptable and socially aware citizens who can participate in and contribute to a dynamic, inclusive and rapidly evolving world.'),
 ('numeracy-mathematics', 'Numeracy and Mathematics', NULL, NULL),
 ('languages', 'Languages', 'Languages', NULL),
 ('re-roman-catholic', 'Religious Education Roman Catholic', NULL, NULL);

INSERT INTO big_idea (area_id, name, description, position)
SELECT id, v.name, v.description, v.pos FROM curriculum_area,
 (VALUES ('Understanding Our World', 'We live in a complex world full of physical, digital, social and economic systems. …', 1),
         ('Innovation',              'Engaging with our world requires the confident use of tools, materials and processes to create products and services. …', 2),
         ('Shaping Our Future',      'Every technological decision has economic, environmental and social impacts. …', 3)) AS v(name, description, pos)
WHERE slug = 'technologies';

INSERT INTO source_document (title, doc_type, area_id, version, published_on, file_name)
SELECT 'CIC Draft Technical Framework - Technologies', 'technical_framework', id, '1.0', '2026-11-01',
       'CIC Draft Technical Framework - Technologies - November 2026.pdf'
FROM curriculum_area WHERE slug = 'technologies';

-- Technologies nodes ---------------------------------------------------------
INSERT INTO structural_node (area_id, node_type, slug, name, position)
SELECT ca.id, 'strand', v.slug, v.name, v.pos FROM curriculum_area ca,
 (VALUES ('ideas', 'Identify, Define, Explore and Articulate (IDEAs)', 1),
         ('data-rich-world', 'A Data Rich World', 5)) AS v(slug, name, pos)
WHERE ca.slug = 'technologies';

INSERT INTO structural_node (area_id, parent_id, node_type, slug, name, position)
SELECT p.area_id, p.id, 'sub_strand', v.slug, v.name, v.pos
FROM structural_node p,
 (VALUES ('business', 'Business', 1),
         ('design-engineering', 'Design and Engineering', 2),
         ('computing-science', 'Computing Science', 3)) AS v(slug, name, pos)
WHERE p.path = 'ideas';

INSERT INTO node_level (node_id, level_code)
SELECT n.id, l FROM structural_node n,
       unnest(ARRAY['early','first','second','third','fourth']) l WHERE n.path = 'ideas'
UNION ALL
SELECT n.id, l FROM structural_node n,
       unnest(ARRAY['third','fourth']) l WHERE n.path IN ('ideas/business','ideas/design-engineering','ideas/computing-science')
UNION ALL
SELECT n.id, l FROM structural_node n,
       unnest(ARRAY['third','fourth']) l WHERE n.path = 'data-rich-world';

-- Early Level: anchor and payload on the strand ------------------------------
INSERT INTO content_block (code, node_id, level_code, understanding, source_document_id, source_page)
SELECT 'TCH.IDEAS.E.1', n.id, 'early',
       'Ideas can be developed into solutions that address needs and solve problems.',
       (SELECT id FROM source_document LIMIT 1), 4
FROM structural_node n WHERE n.path = 'ideas';

-- Third Level: anchor on the strand, payloads on each sub-strand -------------
INSERT INTO content_block (code, node_id, level_code, understanding, source_page)
SELECT 'TCH.IDEAS.3.1', n.id, 'third',
       'Ideas are developed through an iterative process of analysing needs, generating solutions, testing outcomes and refining designs based on evidence.', 6
FROM structural_node n WHERE n.path = 'ideas';

INSERT INTO content_block (code, node_id, level_code, anchor_block_id, position, source_page)
SELECT v.code, n.id, 'third', (SELECT id FROM content_block WHERE code = 'TCH.IDEAS.3.1'), v.pos, 6
FROM structural_node n
JOIN (VALUES ('ideas/business',           'TCH.IDEAS.BUS.3.1', 1),
             ('ideas/design-engineering', 'TCH.IDEAS.DE.3.1',  2),
             ('ideas/computing-science',  'TCH.IDEAS.CS.3.1',  3)) AS v(path, code, pos) ON v.path = n.path;

INSERT INTO statement (code, block_id, kind, body, position)
SELECT b.code || '.' || v.suffix, b.id, v.kind, v.body, v.pos
FROM content_block b
JOIN (VALUES
  ('TCH.IDEAS.E.1', 'K1', 'know', 'A design is a plan showing how something is to be built or carried out, or the way that something is put together.', 1),
  ('TCH.IDEAS.E.1', 'K2', 'know', 'Ideas do not always work out as planned.', 2),
  ('TCH.IDEAS.E.1', 'D1', 'do',   'Experiment with materials, tools and technology to share design ideas.', 1),
  ('TCH.IDEAS.E.1', 'D2', 'do',   'Represent design ideas through mark making and sketching.', 2),
  ('TCH.IDEAS.BUS.3.1', 'K1', 'know', 'Entrepreneurial thinking is about identifying opportunities to create or improve products, services or processes.', 1),
  ('TCH.IDEAS.BUS.3.1', 'D1', 'do',   'Prepare a business pitch for the idea, initiative or solution.', 1),
  ('TCH.IDEAS.BUS.3.1', 'I1', 'includes', E'Enterprise activities that include problem solving and creative initiatives that build an entrepreneurial mindset, such as:\n- coming up with new product or service ideas in response to a brief\n- project-based learning', 1),
  ('TCH.IDEAS.DE.3.1', 'K1', 'know', 'Briefs identify opportunities and constraints to a scenario or situation.', 1),
  ('TCH.IDEAS.DE.3.1', 'D1', 'do',   'Critique existing products, services or systems against criteria.', 1),
  ('TCH.IDEAS.CS.3.1', 'K1', 'know', 'Prototypes are used to test ideas and gather feedback before implementation.', 1),
  ('TCH.IDEAS.CS.3.1', 'D1', 'do',   'Test solutions against success criteria.', 1),
  ('TCH.IDEAS.CS.3.1', 'N1', 'note', 'Computational thinking underpins the development process.', 1)
) AS v(block, suffix, kind, body, pos) ON v.block = b.code;

-- Maths: Beginning / End of Early Level --------------------------------------
INSERT INTO structural_node (area_id, node_type, slug, name)
SELECT id, 'strand', 'quantity-number-algebraic', 'Quantity, Numbers and the Algebraic Properties of Number'
FROM curriculum_area WHERE slug = 'numeracy-mathematics';
INSERT INTO structural_node (area_id, parent_id, node_type, slug, name)
SELECT area_id, id, 'sub_strand', 'number-systems-structures', 'Number systems and structures'
FROM structural_node WHERE path = 'quantity-number-algebraic';
INSERT INTO node_level SELECT id, 'early' FROM structural_node WHERE path = 'quantity-number-algebraic/number-systems-structures';

INSERT INTO content_block (code, node_id, level_code, understanding, metadata)
SELECT 'MNU.QNA.NSS.E.1', id, 'early',
       'Numbers, including zero, can be represented as spoken number names, written numerals and quantities, while retaining the same value.',
       '{"doQualifier": "through play, everyday routines, games, songs, stories and rhymes"}'
FROM structural_node WHERE path = 'quantity-number-algebraic/number-systems-structures';

INSERT INTO statement (code, block_id, kind, phase, body, position)
SELECT 'MNU.QNA.NSS.E.1.' || v.suffix, b.id, v.kind, v.phase, v.body, v.pos
FROM content_block b, (VALUES
  ('BK1', 'know', 'beginning', 'Zero is represented by the numeral 0.', 1),
  ('BD1', 'do',   'beginning', 'Find examples of numerals in outdoor and indoor spaces.', 1),
  ('EK1', 'know', 'end',       'Digits are the symbols (0 to 9) used in the decimal number system.', 1),
  ('ED1', 'do',   'end',       'Connect numbers to familiar quantities and contexts. For example, ten fingers, four seasons, six eggs in a box.', 1),
  ('V1',  'vocabulary', NULL,  'numbers, zero', 1),
  ('M1',  'milestone',  NULL,  'Recognises some familiar numbers within the environment.', 1)
) AS v(suffix, kind, phase, body, pos)
WHERE b.code = 'MNU.QNA.NSS.E.1';

-- French progression guidance ------------------------------------------------
INSERT INTO language (code, name, area_id) SELECT 'fr', 'French', id FROM curriculum_area WHERE slug = 'languages';
INSERT INTO source_document (title, doc_type, area_id, version, published_on)
SELECT 'CIC – Languages – Progression Guidance French', 'progression_guidance', id, '1.0', '2026-11-01'
FROM curriculum_area WHERE slug = 'languages';

INSERT INTO guidance_entry (source_document_id, area_id, kind, language_code, level_code, mode, topic, body, position)
SELECT d.id, d.area_id, v.kind, 'fr', 'early', v.mode, v.topic, v.body, v.pos
FROM source_document d, (VALUES
  ('level_descriptor',    NULL::text,   'Words and Short Phrases', 'Highly familiar individual words or groups of words associated with highly familiar contexts, routines and experiences.', 0),
  ('language_exemplar',   'receptive',  NULL, 'un chat, un chien, une pomme', 1),
  ('language_exemplar',   'productive', NULL, 'je m’appelle', 1),
  ('grammar_progression', 'receptive',  'Nouns and articles', 'Articles are used with nouns (e.g. une banane, le chat)', 1),
  ('grammar_progression', 'productive', 'Nouns and articles', 'Articles with nouns (e.g. une banane, le chat) when modelled', 1),
  ('suggested_context',   NULL,         NULL, 'greetings', 1),
  ('progression_example', 'productive', 'Expressing a view or preference', 'Learners may join in with or use a familiar expression such as super! within a modelled activity.', 1)
) AS v(kind, mode, topic, body, pos)
WHERE d.doc_type = 'progression_guidance';

-- RC scripture texts ---------------------------------------------------------
INSERT INTO structural_node (area_id, node_type, slug, name)
SELECT id, 'strand', 'exploring-word-of-god', 'Exploring the Word of God' FROM curriculum_area WHERE slug = 're-roman-catholic';
INSERT INTO source_document (title, doc_type, area_id, version)
SELECT 'CIC - Religious Education Roman Catholic - Scripture Texts', 'supplementary_list', id, '1.0'
FROM curriculum_area WHERE slug = 're-roman-catholic';

INSERT INTO guidance_entry (source_document_id, area_id, kind, level_code, node_id, body, ref_selection, ref_choose_min)
SELECT d.id, d.area_id, 'scripture_text', 'early', n.id,
       'Hear, recall and respond to one of the following Old Testament passages', 'choose', 1
FROM source_document d JOIN structural_node n ON n.area_id = d.area_id
WHERE d.doc_type = 'supplementary_list';

INSERT INTO scripture_reference (guidance_entry_id, citation, book, chapter_start, label, position)
SELECT g.id, v.citation, v.book, v.ch, v.label, v.pos
FROM guidance_entry g, (VALUES ('Genesis 1', 'Genesis', 1, 'The 1st account of Genesis', 1),
                               ('Genesis 6', 'Genesis', 6, 'The Flood', 2),
                               ('Exodus 2',  'Exodus',  2, 'The birth of Moses', 3)) AS v(citation, book, ch, label, pos)
WHERE g.kind = 'scripture_text';
