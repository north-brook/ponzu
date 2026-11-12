-- A design is now a canvas (docs/cloud.md). Every step is a rename or a key rewrite: rows, ids,
-- identities and sequences stay as they are. A canvas made before this keeps its des_ id; new
-- ones are cnv_. Run it with every sandbox asleep: an awake runner runs the old bundle against
-- the old names. db:migrate applies it in one transaction, so any failure leaves the old names.
--
-- Every name is renamed by one rule, the one Drizzle's names follow from the renamed schema:
-- "designs" becomes "canvases", then "design" becomes "canvas". The renames are loops over the
-- catalog, not lists, so a table, key, check or index that merged after this was written is
-- renamed too; the last block refuses to commit if any name in the schema still says design.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sandboxes" WHERE "state" <> 'asleep') THEN
    RAISE EXCEPTION 'Put every sandbox to sleep before this migration. Not asleep: %',
      (SELECT string_agg("design_id" || ' ' || "state", ', ') FROM "sandboxes" WHERE "state" <> 'asleep');
  END IF;
END $$;--> statement-breakpoint
-- Tables (and any sequence or view). A table's row type and array type follow its name.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relname, c.relkind FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
       AND c.relname LIKE '%design%'
  LOOP
    EXECUTE format('ALTER %s %s RENAME TO %I',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.rel, replace(replace(r.relname, 'designs', 'canvases'), 'design', 'canvas'));
  END LOOP;
END $$;--> statement-breakpoint
-- Columns of tables. Check bodies, index definitions and foreign keys refer to columns by number
-- and follow.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT a.attrelid::regclass AS rel, a.attname FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND a.attnum > 0 AND NOT a.attisdropped AND a.attname LIKE '%design%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME COLUMN %I TO %I', r.rel, r.attname,
      replace(replace(r.attname, 'designs', 'canvases'), 'design', 'canvas'));
  END LOOP;
END $$;--> statement-breakpoint
-- Constraints of every kind: primary keys, unique, foreign keys, checks, exclusions, and the
-- NOT NULL constraints Postgres 18 records as <table>_<column>_not_null and keeps through a table
-- or column rename. Renaming a primary key, unique or exclusion constraint renames its index.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS rel, conname FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND conrelid <> 0 AND conname LIKE '%design%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.rel, r.conname,
      replace(replace(r.conname, 'designs', 'canvases'), 'design', 'canvas'));
  END LOOP;
END $$;--> statement-breakpoint
-- Indexes that are not constraints, and each index's own copy of its columns' names: an index
-- keeps the name a column had when it was built, and a column rename leaves it. ALTER TABLE
-- renames one on the index itself, which is what a fresh CREATE INDEX would have named it.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS idx, c.relname FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('i', 'I')
       AND c.relname LIKE '%design%'
  LOOP
    EXECUTE format('ALTER INDEX %s RENAME TO %I', r.idx,
      replace(replace(r.relname, 'designs', 'canvases'), 'design', 'canvas'));
  END LOOP;
  FOR r IN
    SELECT a.attrelid::regclass AS idx, a.attname FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('i', 'I')
       AND a.attname LIKE '%design%'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME COLUMN %I TO %I', r.idx, r.attname,
      replace(replace(r.attname, 'designs', 'canvases'), 'design', 'canvas'));
  END LOOP;
END $$;--> statement-breakpoint
-- The one stored key with the word: jobs waiting to wake a sandbox or read a pull request.
UPDATE "jobs" SET "payload" = ("payload" - 'designId') || jsonb_build_object('canvasId', "payload" -> 'designId')
 WHERE "payload" ? 'designId';--> statement-breakpoint
-- Every start mints its runner a new token, so with every sandbox asleep none is in use. One that
-- is would be an old bundle's, calling the old routes.
UPDATE "runner_tokens" SET "revoked_at" = now() WHERE "revoked_at" IS NULL;--> statement-breakpoint
-- Refuse to commit while any name or definition in the schema still says design.
DO $$
DECLARE left_over text;
BEGIN
  SELECT string_agg(kind || ' ' || name, ', ') INTO left_over FROM (
    SELECT 'relation' AS kind, relname::text AS name FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relname LIKE '%design%'
    UNION ALL SELECT 'constraint', conname::text FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND conname LIKE '%design%'
    UNION ALL SELECT 'column', attrelid::regclass::text || '.' || attname FROM pg_attribute
     WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
       AND attname LIKE '%design%' AND NOT attisdropped
    UNION ALL SELECT 'type', typname::text FROM pg_type
     WHERE typnamespace = 'public'::regnamespace AND typname LIKE '%design%'
    UNION ALL SELECT 'default', adrelid::regclass::text FROM pg_attrdef
     WHERE adrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
       AND pg_get_expr(adbin, adrelid) LIKE '%design%'
    UNION ALL SELECT 'constraint body', conname::text FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND pg_get_constraintdef(oid) LIKE '%design%'
    UNION ALL SELECT 'index body', indexrelid::regclass::text FROM pg_index
     WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
       AND pg_get_indexdef(indexrelid) LIKE '%design%'
    UNION ALL SELECT 'function', proname::text FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace AND (proname LIKE '%design%' OR prosrc LIKE '%design%')
    UNION ALL SELECT 'trigger', tgname::text FROM pg_trigger
     WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
       AND tgname LIKE '%design%'
    UNION ALL SELECT 'policy', polname::text FROM pg_policy
     WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
       AND polname LIKE '%design%'
    UNION ALL SELECT 'view body', viewname::text FROM pg_views
     WHERE schemaname = 'public' AND definition LIKE '%design%'
  ) AS names;
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'The canvas rename left names that say design: %', left_over;
  END IF;
END $$;
