-- =============================================================================
-- CIC Curriculum Data Model — PostgreSQL 15+
--
-- Backbone:  Curriculum Area -> Structural Node (recursive) -> Content Block
--            (bound to one node + one level) -> Statements (Know/Do/Notes/…)
--
-- A Content Block either *owns* an Understanding Statement (it is an anchor)
-- or *inherits* one from an anchor block on the same node or an ancestor node
-- at the same level (e.g. Technologies Third Level: Understanding on the
-- strand, Know/Do on each subject sub-strand).
--
-- Supporting guidance (language progression guidance, RC scripture texts)
-- lives in guidance_entry, keyed by the same level / node dimensions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Reference data
-- -----------------------------------------------------------------------------

CREATE TABLE level (
    code        text PRIMARY KEY,                 -- 'early', 'first', ...
    name        text NOT NULL,
    ordinal     smallint NOT NULL UNIQUE,
    is_bge      boolean NOT NULL DEFAULT true     -- one of the five core levels
);

CREATE TABLE stage (                              -- year groups (Scripture Texts)
    code        text PRIMARY KEY,                 -- 'ELC', 'P1' … 'S6'
    name        text NOT NULL,
    level_code  text NOT NULL REFERENCES level,
    ordinal     smallint NOT NULL UNIQUE
);

CREATE TABLE statement_kind (
    code        text PRIMARY KEY,                 -- 'know', 'do', 'note', …
    label       text NOT NULL,                    -- as printed in the frameworks
    is_core     boolean NOT NULL                  -- part of the K/D/U payload proper
);

-- -----------------------------------------------------------------------------
-- 2. Curriculum areas and their framing
-- -----------------------------------------------------------------------------

CREATE TABLE curriculum_area (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug              text NOT NULL UNIQUE,       -- 'technologies', 'languages-latin'
    name              text NOT NULL,
    family            text,                       -- groups sibling frameworks: 'Languages', 'Literacy'
    content_language  text NOT NULL DEFAULT 'en', -- BCP 47; 'gd' for Literacy and Gàidhlig
    purpose_statement text,
    translations      jsonb NOT NULL DEFAULT '{}', -- {"gd": {"name": "…"}}
    position          smallint NOT NULL DEFAULT 0
);

CREATE TABLE big_idea (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id      uuid NOT NULL REFERENCES curriculum_area ON DELETE CASCADE,
    name         text NOT NULL,
    description  text,
    translations jsonb NOT NULL DEFAULT '{}',
    position     smallint NOT NULL DEFAULT 0,
    UNIQUE (area_id, name)
);

-- Provenance: every published PDF. New versions are new rows (supersedes_id).
CREATE TABLE source_document (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title         text NOT NULL,
    doc_type      text NOT NULL CHECK (doc_type IN (
                    'technical_framework',   -- a KDU framework
                    'asn_milestones',        -- ASN milestone overlay / foundation framework
                    'progression_guidance',  -- per-language guidance
                    'supplementary_list',    -- e.g. RC Scripture Texts
                    'compilation',           -- e.g. Early Level, Big Ideas & Purpose Statements
                    'overview')),            -- e.g. Building Scotland's Curriculum
    area_id       uuid REFERENCES curriculum_area ON DELETE CASCADE,
    version       text NOT NULL,
    published_on  date,
    status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','superseded')),
    file_name     text,
    supersedes_id uuid REFERENCES source_document
);

-- -----------------------------------------------------------------------------
-- 3. Structural nodes (recursive: strand -> sub-strand -> sub-sub-strand)
-- -----------------------------------------------------------------------------

CREATE TABLE structural_node (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id      uuid NOT NULL REFERENCES curriculum_area ON DELETE CASCADE,
    parent_id    uuid REFERENCES structural_node ON DELETE CASCADE,
    node_type    text NOT NULL CHECK (node_type IN ('strand','sub_strand','sub_sub_strand')),
    slug         text NOT NULL,
    path         text NOT NULL,                   -- maintained by trigger: 'ideas/business'
    name         text NOT NULL,
    description  text,
    translations jsonb NOT NULL DEFAULT '{}',
    position     smallint NOT NULL DEFAULT 0,
    UNIQUE (area_id, path),
    CHECK ((node_type = 'strand') = (parent_id IS NULL)),
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
CREATE INDEX structural_node_parent_idx ON structural_node (parent_id);

-- Which levels a node exists at (Digital World: Early–Second; Data Rich World: Third–Fourth).
CREATE TABLE node_level (
    node_id     uuid NOT NULL REFERENCES structural_node ON DELETE CASCADE,
    level_code  text NOT NULL REFERENCES level,
    PRIMARY KEY (node_id, level_code)
);

-- Optional: which Big Ideas a node draws on.
CREATE TABLE node_big_idea (
    node_id     uuid NOT NULL REFERENCES structural_node ON DELETE CASCADE,
    big_idea_id uuid NOT NULL REFERENCES big_idea ON DELETE CASCADE,
    PRIMARY KEY (node_id, big_idea_id)
);

-- -----------------------------------------------------------------------------
-- 4. Content blocks and statements (the K/D/U payload)
-- -----------------------------------------------------------------------------

CREATE TABLE content_block (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code               text NOT NULL UNIQUE,      -- stable public id, e.g. 'TCH.IDEAS.3.1'
    node_id            uuid NOT NULL,
    level_code         text NOT NULL,
    understanding      text,                      -- set => this block is an anchor
    anchor_block_id    uuid REFERENCES content_block ON DELETE CASCADE, -- set => inherits understanding
    position           smallint NOT NULL DEFAULT 0,
    source_document_id uuid REFERENCES source_document ON DELETE SET NULL,
    source_page        smallint,
    metadata           jsonb NOT NULL DEFAULT '{}',  -- e.g. {"doQualifier": "through play, …"}
    FOREIGN KEY (node_id, level_code) REFERENCES node_level ON DELETE CASCADE,
    CHECK ((understanding IS NULL) <> (anchor_block_id IS NULL))  -- exactly one
);
CREATE INDEX content_block_node_level_idx ON content_block (node_id, level_code, position);
CREATE INDEX content_block_anchor_idx     ON content_block (anchor_block_id);

CREATE TABLE statement (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code               text NOT NULL UNIQUE,      -- e.g. 'TCH.IDEAS.3.1.K3'
    block_id           uuid NOT NULL REFERENCES content_block ON DELETE CASCADE,
    kind               text NOT NULL REFERENCES statement_kind,
    phase              text CHECK (phase IN ('beginning','end')), -- Maths & ASN: Beginning/End of level
    body               text NOT NULL,             -- Markdown allowed (bullet lists in Includes/Notes)
    position           smallint NOT NULL DEFAULT 0,
    source_document_id uuid REFERENCES source_document ON DELETE SET NULL, -- overrides the block's (ASN overlays)
    source_page        smallint,
    metadata           jsonb NOT NULL DEFAULT '{}',
    search             tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED
);
CREATE INDEX statement_block_idx  ON statement (block_id, kind, phase, position);
CREATE INDEX statement_search_idx ON statement USING gin (search);

-- -----------------------------------------------------------------------------
-- 5. Supporting guidance (progression guidance, scripture texts, …)
-- -----------------------------------------------------------------------------

CREATE TABLE language (                           -- languages taught under a Languages framework
    code     text PRIMARY KEY,                    -- BCP 47: 'fr','de','es','la','gd','sco'
    name     text NOT NULL,
    area_id  uuid NOT NULL REFERENCES curriculum_area  -- the KDU framework it follows
);

CREATE TABLE guidance_entry (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_document_id uuid NOT NULL REFERENCES source_document ON DELETE CASCADE,
    area_id            uuid NOT NULL REFERENCES curriculum_area,
    kind               text NOT NULL CHECK (kind IN (
                         'introduction',        -- framing prose for a document or level
                         'level_descriptor',    -- 'Words and Short Phrases' + definition
                         'progression_example', -- one theme shown across levels
                         'language_exemplar',   -- receptive / productive language examples
                         'grammar_progression', -- one grammatical feature at one level
                         'commentary',          -- 'Comments/Guidance'
                         'suggested_context',   -- 'Suggested contexts for learning'
                         'scripture_text')),    -- RC: a scripture task for a strand/stage
    language_code      text REFERENCES language,
    level_code         text REFERENCES level,
    stage_code         text REFERENCES stage,
    node_id            uuid REFERENCES structural_node,  -- strand the entry supports
    block_id           uuid REFERENCES content_block,    -- optional fine-grained link
    mode               text CHECK (mode IN ('receptive','productive')), -- Understand / Use
    topic              text,                      -- grammar feature, example theme, descriptor name
    body               text NOT NULL,
    ref_selection      text CHECK (ref_selection IN ('all','choose','examples')), -- how to use the references
    ref_choose_min     smallint CHECK (ref_choose_min >= 1),  -- 'one of' = 1, 'two or more of' = 2
    position           smallint NOT NULL DEFAULT 0,
    metadata           jsonb NOT NULL DEFAULT '{}',
    CHECK (ref_selection IS NULL OR kind = 'scripture_text'),
    CHECK ((ref_selection IS NOT DISTINCT FROM 'choose') = (ref_choose_min IS NOT NULL))
);
CREATE INDEX guidance_lookup_idx ON guidance_entry (area_id, kind, language_code, level_code, stage_code);

CREATE TABLE scripture_reference (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guidance_entry_id uuid NOT NULL REFERENCES guidance_entry ON DELETE CASCADE,
    citation          text NOT NULL,              -- as printed: 'Luke 2: 1-20'
    book              text NOT NULL,              -- 'Luke'
    chapter_start     smallint NOT NULL,
    verse_start       smallint,
    chapter_end       smallint,
    verse_end         smallint,
    label             text,                       -- 'The Flood'
    position          smallint NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 6. Integrity triggers
-- -----------------------------------------------------------------------------

-- Node: parent in same area, type steps down one level, path materialised.
CREATE FUNCTION structural_node_before_write() RETURNS trigger AS $$
DECLARE p structural_node;
BEGIN
    IF NEW.parent_id IS NULL THEN
        NEW.path := NEW.slug;
    ELSE
        SELECT * INTO p FROM structural_node WHERE id = NEW.parent_id;
        IF p.area_id <> NEW.area_id THEN
            RAISE EXCEPTION 'node % parent belongs to a different curriculum area', NEW.slug;
        END IF;
        IF NOT ((p.node_type = 'strand'     AND NEW.node_type = 'sub_strand') OR
                (p.node_type = 'sub_strand' AND NEW.node_type = 'sub_sub_strand')) THEN
            RAISE EXCEPTION 'node % of type % cannot sit under a %', NEW.slug, NEW.node_type, p.node_type;
        END IF;
        NEW.path := p.path || '/' || NEW.slug;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER structural_node_bw BEFORE INSERT OR UPDATE ON structural_node
    FOR EACH ROW EXECUTE FUNCTION structural_node_before_write();

-- Renaming or moving a node re-materialises the paths of its descendants.
CREATE FUNCTION structural_node_after_update() RETURNS trigger AS $$
BEGIN
    IF NEW.path IS DISTINCT FROM OLD.path THEN
        UPDATE structural_node SET path = path WHERE parent_id = NEW.id;  -- fires BEFORE trigger per child
    END IF;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER structural_node_au AFTER UPDATE OF slug, parent_id, path ON structural_node
    FOR EACH ROW EXECUTE FUNCTION structural_node_after_update();

-- Block: an inheriting block's anchor must own an understanding, be at the same
-- level, and sit on the same node or an ancestor of it.
CREATE FUNCTION content_block_before_write() RETURNS trigger AS $$
DECLARE a content_block; ok boolean;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.understanding IS NULL AND OLD.understanding IS NOT NULL
       AND EXISTS (SELECT 1 FROM content_block WHERE anchor_block_id = NEW.id) THEN
        RAISE EXCEPTION 'block % is an anchor for other blocks and must keep its understanding', NEW.code;
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.node_id, NEW.level_code) IS DISTINCT FROM (OLD.node_id, OLD.level_code)
       AND EXISTS (SELECT 1 FROM content_block WHERE anchor_block_id = NEW.id) THEN
        RAISE EXCEPTION 'block % is an anchor for other blocks and cannot change node or level', NEW.code;
    END IF;
    IF NEW.anchor_block_id IS NULL THEN RETURN NEW; END IF;
    -- Only re-check placement when it changes (not on e.g. a provenance update during a cascade).
    IF TG_OP = 'UPDATE' AND (NEW.anchor_block_id, NEW.node_id, NEW.level_code)
                            IS NOT DISTINCT FROM (OLD.anchor_block_id, OLD.node_id, OLD.level_code) THEN
        RETURN NEW;
    END IF;
    SELECT * INTO a FROM content_block WHERE id = NEW.anchor_block_id;
    IF a.understanding IS NULL THEN
        RAISE EXCEPTION 'block % anchors to % which has no understanding', NEW.code, a.code;
    END IF;
    IF a.level_code <> NEW.level_code THEN
        RAISE EXCEPTION 'block % anchors to % at a different level', NEW.code, a.code;
    END IF;
    WITH RECURSIVE up AS (
        SELECT id, parent_id FROM structural_node WHERE id = NEW.node_id
        UNION ALL
        SELECT n.id, n.parent_id FROM structural_node n JOIN up ON n.id = up.parent_id
    ) SELECT EXISTS (SELECT 1 FROM up WHERE id = a.node_id) INTO ok;
    IF NOT ok THEN
        RAISE EXCEPTION 'block % anchors to % which is not on the same node or an ancestor', NEW.code, a.code;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER content_block_bw BEFORE INSERT OR UPDATE ON content_block
    FOR EACH ROW EXECUTE FUNCTION content_block_before_write();

-- -----------------------------------------------------------------------------
-- 7. Read-side views for the web service
-- -----------------------------------------------------------------------------

-- Every block with its effective Understanding resolved.
CREATE VIEW v_content_block AS
SELECT b.id,
       b.code,
       ca.slug                                    AS area_slug,
       n.path                                     AS node_path,
       n.node_type,
       n.name                                     AS node_name,
       b.level_code,
       l.ordinal                                  AS level_ordinal,
       COALESCE(b.understanding, a.understanding) AS understanding,
       (b.understanding IS NOT NULL)              AS is_anchor,
       a.code                                     AS anchor_code,
       b.position,
       b.metadata
FROM content_block b
JOIN structural_node n ON n.id = b.node_id
JOIN curriculum_area ca ON ca.id = n.area_id
JOIN level l ON l.code = b.level_code
LEFT JOIN content_block a ON a.id = b.anchor_block_id;

-- Summary of Progression: one row per anchor (node x level x understanding).
CREATE VIEW v_summary_of_progression AS
SELECT area_slug, node_path, node_name, level_code, level_ordinal, code, understanding
FROM v_content_block
WHERE is_anchor;

-- -----------------------------------------------------------------------------
-- 8. Seed reference data
-- -----------------------------------------------------------------------------

INSERT INTO level (code, name, ordinal, is_bge) VALUES
    ('foundation', 'Foundation ASN Milestones', 0, false),
    ('early',      'Early Level',               1, true),
    ('first',      'First Level',               2, true),
    ('second',     'Second Level',              3, true),
    ('third',      'Third Level',               4, true),
    ('fourth',     'Fourth Level',              5, true),
    ('senior',     'Senior Phase',              6, false);

INSERT INTO stage (code, name, level_code, ordinal) VALUES
    ('ELC','Early Learning and Childcare','early', 0),
    ('P1','Primary 1','early', 1),   ('P2','Primary 2','first', 2),
    ('P3','Primary 3','first', 3),   ('P4','Primary 4','first', 4),
    ('P5','Primary 5','second',5),   ('P6','Primary 6','second',6),
    ('P7','Primary 7','second',7),   ('S1','Secondary 1','third',8),
    ('S2','Secondary 2','third',9),  ('S3','Secondary 3','fourth',10),
    ('S4','Secondary 4','senior',11),('S5','Secondary 5','senior',12),
    ('S6','Secondary 6','senior',13);

INSERT INTO statement_kind (code, label, is_core) VALUES
    ('know',       'Know',                         true),
    ('do',         'Do',                           true),
    ('note',       'Notes',                        true),
    ('includes',   'Includes, but not limited to', false),
    ('excludes',   'Excludes',                     false),
    ('vocabulary', 'New key language (Learners)',  false),
    ('milestone',  'ASN Milestones',               false);
