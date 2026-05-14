-- NEEDLE-LSST PostgreSQL schema
-- Optimized for high-volume LSST alert ingestion and fast scientific filtering.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE user_role AS ENUM ('admin', 'team_lead', 'member', 'viewer');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'object_class') THEN
    CREATE TYPE object_class AS ENUM (
      'TDE',
      'SLSNe-I',
      'SN Ia',
      'SN Ibc',
      'SN II',
      'Unclear',
      'AGN-removed',
      'Other'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'follow_up_status') THEN
    CREATE TYPE follow_up_status AS ENUM ('To Do', 'Observing', 'Analyzed', 'Archived');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orcid text UNIQUE,
  email citext UNIQUE,
  display_name text NOT NULL,
  role user_role NOT NULL DEFAULT 'member',
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS objects (
  lasair_id text PRIMARY KEY,
  object_name text NOT NULL,
  ztf_id text,
  ra double precision NOT NULL CHECK (ra >= 0 AND ra < 360),
  dec double precision NOT NULL CHECK (dec >= -90 AND dec <= 90),
  sky_position geography(Point, 4326)
    GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(ra, dec), 4326)::geography) STORED,
  latest_mag numeric(6, 3),
  band text,
  tns_class text,
  tns_name text,
  ps_image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_classified timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS tns_class text;

ALTER TABLE objects
  ADD COLUMN IF NOT EXISTS tns_name text;

CREATE INDEX IF NOT EXISTS objects_name_trgm_idx ON objects USING gin (object_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS objects_ztf_trgm_idx ON objects USING gin (ztf_id gin_trgm_ops);
CREATE INDEX IF NOT EXISTS objects_sky_position_idx ON objects USING gist (sky_position);
CREATE INDEX IF NOT EXISTS objects_last_classified_idx ON objects (last_classified DESC);

-- Raw LSST/Lasair alerts can grow to millions or billions of rows.
-- Partition by received_at so old data can be archived and time-window queries stay fast.
CREATE TABLE IF NOT EXISTS alerts (
  alert_id bigint NOT NULL,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'Lasair',
  candidate_mjd double precision,
  magnitude numeric(6, 3),
  band text,
  broker_payload jsonb NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (alert_id, received_at)
) PARTITION BY RANGE (received_at);

CREATE TABLE IF NOT EXISTS alerts_default PARTITION OF alerts DEFAULT;

CREATE INDEX IF NOT EXISTS alerts_default_received_brin_idx ON alerts_default USING brin (received_at);
CREATE INDEX IF NOT EXISTS alerts_default_lasair_received_idx ON alerts_default (lasair_id, received_at DESC);
CREATE INDEX IF NOT EXISTS alerts_default_features_gin_idx ON alerts_default USING gin (features jsonb_path_ops);

CREATE TABLE IF NOT EXISTS needle_classifications (
  id bigserial PRIMARY KEY,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  alert_id bigint,
  alert_received_at timestamptz,
  classified_at timestamptz NOT NULL DEFAULT now(),
  classified_by uuid REFERENCES users(id),
  model_version text NOT NULL,
  class object_class NOT NULL,
  score numeric(6, 5) NOT NULL CHECK (score >= 0 AND score <= 1),
  confidence numeric(6, 5) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  agn_removed boolean NOT NULL DEFAULT false,
  quality_flags text[] NOT NULL DEFAULT '{}',
  raw_probs jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_importance jsonb NOT NULL DEFAULT '{}'::jsonb,
  comments text
);

CREATE INDEX IF NOT EXISTS classifications_object_time_idx
  ON needle_classifications (lasair_id, classified_at DESC);
CREATE INDEX IF NOT EXISTS classifications_class_confidence_idx
  ON needle_classifications (class, confidence DESC, classified_at DESC);
CREATE INDEX IF NOT EXISTS classifications_recent_brin_idx
  ON needle_classifications USING brin (classified_at);
CREATE INDEX IF NOT EXISTS classifications_raw_probs_gin_idx
  ON needle_classifications USING gin (raw_probs jsonb_path_ops);

CREATE TABLE IF NOT EXISTS user_object_interactions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  starred boolean NOT NULL DEFAULT false,
  promoted_to_tns boolean NOT NULL DEFAULT false,
  snoozed_until timestamptz,
  follow_up_status follow_up_status NOT NULL DEFAULT 'To Do',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lasair_id)
);

ALTER TABLE user_object_interactions
  ADD COLUMN IF NOT EXISTS promoted_to_tns boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS interactions_starred_idx
  ON user_object_interactions (user_id, starred, updated_at DESC)
  WHERE starred = true;
CREATE INDEX IF NOT EXISTS interactions_followup_idx
  ON user_object_interactions (follow_up_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS interactions_promoted_idx
  ON user_object_interactions (user_id, promoted_to_tns, updated_at DESC)
  WHERE promoted_to_tns = true;
CREATE INDEX IF NOT EXISTS interactions_snoozed_until_idx
  ON user_object_interactions (snoozed_until)
  WHERE snoozed_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS annotations (
  id bigserial PRIMARY KEY,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_id bigint REFERENCES annotations(id) ON DELETE CASCADE,
  body text NOT NULL,
  mentions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS annotations_object_time_idx ON annotations (lasair_id, created_at DESC);
CREATE INDEX IF NOT EXISTS annotations_body_trgm_idx ON annotations USING gin (body gin_trgm_ops);

CREATE TABLE IF NOT EXISTS object_comments (
  id bigserial PRIMARY KEY,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  publisher text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS object_comments_object_time_idx
  ON object_comments (lasair_id, created_at DESC);
CREATE INDEX IF NOT EXISTS object_comments_body_trgm_idx
  ON object_comments USING gin (body gin_trgm_ops);

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('view', 'annotate', 'classify')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_collection_objects (
  collection_id uuid NOT NULL REFERENCES team_collections(id) ON DELETE CASCADE,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, lasair_id)
);

CREATE TABLE IF NOT EXISTS follow_up (
  id bigserial PRIMARY KEY,
  lasair_id text NOT NULL REFERENCES objects(lasair_id) ON DELETE CASCADE,
  priority text NOT NULL CHECK (priority IN ('High', 'Medium', 'Low')),
  telescope text,
  status follow_up_status NOT NULL DEFAULT 'To Do',
  notes text,
  assigned_user uuid REFERENCES users(id) ON DELETE SET NULL,
  revisit_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS follow_up_status_priority_idx ON follow_up (status, priority, updated_at DESC);

ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS telescope_codes text[] NOT NULL DEFAULT '{}';

UPDATE follow_up
SET telescope_codes = ARRAY[telescope]
WHERE telescope IS NOT NULL AND btrim(telescope) <> '' AND cardinality(telescope_codes) = 0;

CREATE TABLE IF NOT EXISTS observing_telescopes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9._-]{1,32}$'),
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS observing_telescopes_code_idx ON observing_telescopes (code);

ALTER TABLE follow_up ADD COLUMN IF NOT EXISTS revisit_at timestamptz;

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_time_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);

DROP VIEW IF EXISTS latest_object_classifications;

CREATE VIEW latest_object_classifications AS
SELECT DISTINCT ON (o.lasair_id)
  o.lasair_id,
  o.object_name,
  o.ztf_id,
  o.ra,
  o.dec,
  o.latest_mag,
  o.band,
  o.tns_class,
  o.tns_name,
  o.ps_image_urls,
  c.class,
  c.score,
  c.confidence,
  c.agn_removed,
  c.quality_flags,
  c.model_version,
  c.classified_at,
  c.comments,
  c.raw_probs
FROM objects o
LEFT JOIN needle_classifications c ON c.lasair_id = o.lasair_id
ORDER BY o.lasair_id, c.classified_at DESC NULLS LAST;

CREATE OR REPLACE FUNCTION create_alert_partition(partition_start date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_end date := partition_start + interval '1 month';
  partition_name text := 'alerts_' || to_char(partition_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF alerts FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    partition_start,
    partition_end
  );

  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING brin (received_at)', partition_name || '_received_brin_idx', partition_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (lasair_id, received_at DESC)', partition_name || '_lasair_received_idx', partition_name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I USING gin (features jsonb_path_ops)', partition_name || '_features_gin_idx', partition_name);
END;
$$;

CREATE OR REPLACE FUNCTION purge_expired_snoozed_objects()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count integer;
BEGIN
  WITH deleted AS (
    DELETE FROM objects o
    WHERE EXISTS (
      SELECT 1
      FROM user_object_interactions i
      WHERE i.lasair_id = o.lasair_id
        AND i.snoozed_until IS NOT NULL
        AND i.snoozed_until < now()
    )
    RETURNING 1
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$;
