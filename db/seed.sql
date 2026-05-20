INSERT INTO users (id, orcid, email, display_name, role, preferences)
VALUES
  ('11111111-1111-4111-8111-111111111111', '0000-0002-1825-0097', 'admin@needle-lsst.dev', 'X. Researcher', 'admin', '{"theme":"dark"}'),
  ('22222222-2222-4222-8222-222222222222', '0000-0003-1415-9265', 'arivera@needle-lsst.dev', 'A. Rivera', 'team_lead', '{}'),
  ('33333333-3333-4333-8333-333333333333', '0000-0001-6180-3398', 'mchen@needle-lsst.dev', 'M. Chen', 'member', '{"accountKind":"shared"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO objects (lasair_id, object_name, ztf_id, ra, dec, latest_mag, band, tns_class, tns_name, ps_image_urls, last_classified)
VALUES
  ('LSS_J102429.1+091204', 'LSST-2026tde-1842', 'ZTF26abc1842', 156.1214, 9.2012, 18.7, 'r', NULL, NULL, '["/stamps/tde-1842-latest.webp"]', now() - interval '8 minutes'),
  ('LSS_J221035.4-011923', 'LSST-2026sn-0419', 'ZTF26sn0419', 332.6478, -1.3231, 19.4, 'i', 'SN Ia', 'SN 2026abc', '["/stamps/sn-0419-latest.webp"]', now() - interval '22 minutes'),
  ('LSS_J034402.8-214411', 'LSST-2026slsn-0997', 'ZTF26slsn0997', 56.0118, -21.7364, 20.1, 'g', NULL, NULL, '["/stamps/slsn-0997-latest.webp"]', now() - interval '35 minutes'),
  ('LSS_J145924.2+372142', 'LSST-2026agn-3301', 'ZTF26agn3301', 224.8510, 37.3618, 18.9, 'r', 'AGN', 'AT 2026agn', '["/stamps/agn-3301-latest.webp"]', now() - interval '1 hour'),
  ('LSS_J011449.7+153002', 'LSST-2026unc-7812', 'ZTF26unc7812', 18.7072, 15.5006, 21.0, 'z', NULL, NULL, '["/stamps/unc-7812-latest.webp"]', now() - interval '2 hours')
ON CONFLICT (lasair_id) DO UPDATE SET
  object_name = EXCLUDED.object_name,
  ra = EXCLUDED.ra,
  dec = EXCLUDED.dec,
  latest_mag = EXCLUDED.latest_mag,
  band = EXCLUDED.band,
  tns_class = EXCLUDED.tns_class,
  tns_name = EXCLUDED.tns_name,
  last_classified = EXCLUDED.last_classified;

SELECT create_alert_partition(date_trunc('month', now())::date);

INSERT INTO needle_classifications (
  lasair_id,
  model_version,
  class,
  score,
  confidence,
  agn_removed,
  quality_flags,
  raw_probs,
  feature_importance,
  comments,
  classified_by,
  classified_at
)
VALUES
  ('LSS_J102429.1+091204', 'NEEDLE 2.0', 'TDE', 0.94, 0.94, false, ARRAY['nuclear','host matched'], '{"TDE":0.94,"SN Ia":0.03,"SLSNe-I":0.01,"Unclear":0.015,"Other":0.005}', '{"Color evolution":0.91,"Host offset":0.78,"Rise time":0.62}', 'Blue nuclear flare with slow rise; high-priority spectroscopy requested.', NULL, now() - interval '8 minutes'),
  ('LSS_J221035.4-011923', 'NEEDLE 2.0', 'SN Ia', 0.87, 0.87, false, ARRAY['clean stamp'], '{"SN Ia":0.87,"SN II":0.08,"SN Ibc":0.03,"Unclear":0.015,"Other":0.005}', '{"Color evolution":0.69,"Rise time":0.74}', 'Photometric Ia candidate with clean PS stamp and rising light curve.', '22222222-2222-4222-8222-222222222222', now() - interval '22 minutes'),
  ('LSS_J034402.8-214411', 'NEEDLE 2.0', 'SLSNe-I', 0.91, 0.91, false, ARRAY['faint host','blue color'], '{"SLSNe-I":0.91,"TDE":0.05,"SN II":0.025,"Unclear":0.01,"Other":0.005}', '{"Color evolution":0.88,"Host offset":0.63}', 'Luminous, blue transient offset from faint host. Add to shared SLSN watchlist.', NULL, now() - interval '35 minutes'),
  ('LSS_J145924.2+372142', 'NEEDLE 2.0', 'AGN-removed', 0.96, 0.96, true, ARRAY['WISE AGN','historical variability'], '{"AGN-removed":0.96,"Other":0.02,"Unclear":0.015,"SN Ia":0.005}', '{"Historical variability":0.95}', 'Known variable nucleus removed before transient candidate queueing.', NULL, now() - interval '1 hour'),
  ('LSS_J011449.7+153002', 'NEEDLE 2.0', 'Unclear', 0.52, 0.52, false, ARRAY['low SNR','moon proximity'], '{"Unclear":0.52,"SN II":0.24,"SN Ia":0.15,"TDE":0.06,"Other":0.03}', '{"Signal quality":0.31}', 'Low signal-to-noise stamp; wait for next epoch before escalating.', '33333333-3333-4333-8333-333333333333', now() - interval '2 hours');

-- Earlier NEEDLE epochs for TDE demo object (daily cadence); latest row remains the INSERT above.
INSERT INTO needle_classifications (
  lasair_id,
  model_version,
  class,
  score,
  confidence,
  agn_removed,
  quality_flags,
  raw_probs,
  feature_importance,
  comments,
  classified_by,
  classified_at
)
VALUES
  (
    'LSS_J102429.1+091204',
    'NEEDLE 2.0',
    'Unclear',
    0.41,
    0.41,
    false,
    ARRAY['nuclear'],
    '{"Unclear":0.41,"TDE":0.28,"SN II":0.15,"SN Ia":0.10,"Other":0.06}',
    '{"Signal quality":0.55}',
    'Sparse first-night coverage.',
    NULL,
    timestamptz '2026-05-10 15:00:00+00'
  ),
  (
    'LSS_J102429.1+091204',
    'NEEDLE 2.0',
    'TDE',
    0.72,
    0.72,
    false,
    ARRAY['nuclear'],
    '{"TDE":0.72,"Unclear":0.14,"SN Ia":0.08,"SN II":0.04,"Other":0.02}',
    '{"Color evolution":0.7}',
    'Rising blue continuum.',
    NULL,
    timestamptz '2026-05-11 16:20:00+00'
  ),
  (
    'LSS_J102429.1+091204',
    'NEEDLE 2.0',
    'TDE',
    0.85,
    0.85,
    false,
    ARRAY['nuclear','host matched'],
    '{"TDE":0.85,"Unclear":0.08,"SN Ia":0.04,"SN II":0.02,"Other":0.01}',
    '{"Host offset":0.62}',
    'Host match strengthened.',
    NULL,
    timestamptz '2026-05-12 11:00:00+00'
  ),
  (
    'LSS_J102429.1+091204',
    'NEEDLE 2.0',
    'TDE',
    0.91,
    0.91,
    false,
    ARRAY['nuclear','host matched'],
    '{"TDE":0.91,"SN Ia":0.05,"Unclear":0.03,"Other":0.01}',
    '{"Rise time":0.71}',
    'Pre-outburst archival constraint.',
    NULL,
    timestamptz '2026-05-13 09:30:00+00'
  );

-- Multi-band photometry for the TDE demo row is loaded from `demo/mag_sets_v4/ZTF23abaujuy.json`
-- when you run `node db/init.js` (mag_sets_v4 JSON with `candidates` is supported by the API).

WITH simulated AS (
  SELECT
    index,
    'LSS_SIM_J' || (100000 + index * 137)::text || '.' || (index % 10)::text || '+' || (1000 + index * 29)::text AS lasair_id,
    'LSST-2026sim-' || lpad(index::text, 4, '0') AS object_name,
    ('ZTF26sim' || lpad(index::text, 4, '0')) AS ztf_id,
    round((12.5 + index * 13.271)::numeric, 4)::double precision AS ra,
    round(((CASE WHEN index % 2 = 0 THEN 1 ELSE -1 END) * (1.4 + index * 2.117))::numeric, 4)::double precision AS dec,
    round((17.8 + (index % 9) * 0.37)::numeric, 3) AS latest_mag,
    (ARRAY['g', 'r', 'i', 'z'])[index % 4 + 1] AS band,
    (ARRAY['TDE', 'SLSNe-I', 'SN Ia', 'SN Ibc', 'SN II', 'Unclear', 'Other'])[index % 7 + 1]::object_class AS class,
    round((0.56 + ((index * 7) % 39)::numeric / 100), 5) AS confidence
  FROM generate_series(6, 20) AS index
)
INSERT INTO objects (lasair_id, object_name, ztf_id, ra, dec, latest_mag, band, tns_class, tns_name, ps_image_urls, last_classified)
SELECT
  lasair_id,
  object_name,
  ztf_id,
  ra,
  dec,
  latest_mag,
  band,
  CASE WHEN index % 4 = 0 THEN class::text ELSE NULL END,
  CASE WHEN index % 4 = 0 THEN 'AT 2026sim' || lpad(index::text, 4, '0') ELSE NULL END,
  jsonb_build_array('/stamps/' || lower(object_name) || '-latest.webp'),
  now() - (index * interval '11 minutes')
FROM simulated
ON CONFLICT (lasair_id) DO UPDATE SET
  object_name = EXCLUDED.object_name,
  ra = EXCLUDED.ra,
  dec = EXCLUDED.dec,
  latest_mag = EXCLUDED.latest_mag,
  band = EXCLUDED.band,
  tns_class = EXCLUDED.tns_class,
  tns_name = EXCLUDED.tns_name,
  last_classified = EXCLUDED.last_classified;

WITH simulated AS (
  SELECT
    index,
    'LSS_SIM_J' || (100000 + index * 137)::text || '.' || (index % 10)::text || '+' || (1000 + index * 29)::text AS lasair_id,
    (ARRAY['TDE', 'SLSNe-I', 'SN Ia', 'SN Ibc', 'SN II', 'Unclear', 'Other'])[index % 7 + 1]::object_class AS class,
    round((0.56 + ((index * 7) % 39)::numeric / 100), 5) AS confidence,
    round(greatest(0.03, (1.0 - (0.56 + ((index * 7) % 39)::numeric / 100)) * 0.34 + (index % 5)::numeric * 0.004), 4) AS p2,
    round(greatest(0.03, (1.0 - (0.56 + ((index * 7) % 39)::numeric / 100)) * 0.26 + (index % 4)::numeric * 0.004), 4) AS p3,
    round(greatest(0.02, (1.0 - (0.56 + ((index * 7) % 39)::numeric / 100)) * 0.18 + (index % 3)::numeric * 0.003), 4) AS p4,
    round(greatest(0.02, (index % 6)::numeric * 0.012 + 0.015), 4) AS p5
  FROM generate_series(6, 20) AS index
)
INSERT INTO needle_classifications (
  lasair_id,
  model_version,
  class,
  score,
  confidence,
  agn_removed,
  quality_flags,
  raw_probs,
  feature_importance,
  comments,
  classified_by,
  classified_at
)
SELECT
  lasair_id,
  'NEEDLE 2.0',
  class,
  confidence,
  confidence,
  false,
  ARRAY['simulated'],
  CASE class::text
    WHEN 'TDE' THEN jsonb_build_object('TDE', confidence, 'SN Ia', p2, 'Unclear', p3, 'Other', p4, 'SN II', p5)
    WHEN 'SLSNe-I' THEN jsonb_build_object('SLSNe-I', confidence, 'TDE', p2, 'Unclear', p3, 'Other', p4, 'SN II', p5)
    WHEN 'SN Ia' THEN jsonb_build_object('SN Ia', confidence, 'SN II', p2, 'Unclear', p3, 'Other', p4, 'TDE', p5)
    WHEN 'SN Ibc' THEN jsonb_build_object('SN Ibc', confidence, 'SN II', p2, 'SN Ia', p3, 'Other', p4, 'Unclear', p5)
    WHEN 'SN II' THEN jsonb_build_object('SN II', confidence, 'SN Ia', p2, 'Unclear', p3, 'Other', p4, 'TDE', p5)
    WHEN 'Unclear' THEN jsonb_build_object('Unclear', confidence, 'Other', p2, 'SN II', p3, 'SN Ia', p4, 'TDE', p5)
    ELSE jsonb_build_object('Other', confidence, 'Unclear', p2, 'SN II', p3, 'TDE', p4, 'SN Ia', p5)
  END,
  jsonb_build_object('Color evolution', confidence, 'Host offset', round((confidence * 0.8)::numeric, 5)),
  'Simulated ' || class::text || ' candidate for workflow testing and action handling.',
  CASE WHEN index % 3 = 0 THEN '22222222-2222-4222-8222-222222222222'::uuid ELSE NULL END,
  now() - (index * interval '11 minutes')
FROM simulated;

INSERT INTO user_object_interactions (user_id, lasair_id, starred, promoted_to_tns, snoozed_until, follow_up_status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'LSS_J102429.1+091204', true, false, NULL, 'Observing'),
  ('11111111-1111-4111-8111-111111111111', 'LSS_J034402.8-214411', true, true, NULL, 'Completed'),
  ('11111111-1111-4111-8111-111111111111', 'LSS_J145924.2+372142', false, false, now() + interval '14 days', 'Snooze'),
  ('11111111-1111-4111-8111-111111111111', 'LSS_J011449.7+153002', false, false, now() + interval '1 day', 'To Do')
ON CONFLICT (user_id, lasair_id) DO UPDATE SET
  starred = EXCLUDED.starred,
  promoted_to_tns = EXCLUDED.promoted_to_tns,
  snoozed_until = EXCLUDED.snoozed_until,
  follow_up_status = EXCLUDED.follow_up_status,
  updated_at = now();

WITH simulated AS (
  SELECT
    index,
    'LSS_SIM_J' || (100000 + index * 137)::text || '.' || (index % 10)::text || '+' || (1000 + index * 29)::text AS lasair_id,
    CASE
      WHEN index % 6 = 0 THEN 'Observing'
      WHEN index % 5 = 0 THEN 'Completed'
      ELSE 'To Do'
    END::follow_up_status AS follow_up_status
  FROM generate_series(6, 20) AS index
)
INSERT INTO user_object_interactions (user_id, lasair_id, starred, promoted_to_tns, snoozed_until, follow_up_status)
SELECT
  '11111111-1111-4111-8111-111111111111',
  lasair_id,
  index % 7 = 0,
  index % 8 = 0,
  CASE WHEN index % 10 = 0 THEN now() + interval '3 months' ELSE NULL END,
  follow_up_status
FROM simulated
ON CONFLICT (user_id, lasair_id) DO UPDATE SET
  starred = EXCLUDED.starred,
  promoted_to_tns = EXCLUDED.promoted_to_tns,
  snoozed_until = EXCLUDED.snoozed_until,
  follow_up_status = EXCLUDED.follow_up_status,
  updated_at = now();

INSERT INTO observing_telescopes (code, display_name) VALUES
  ('LT', 'Liverpool Telescope'),
  ('NTT', 'New Technology Telescope'),
  ('SOAR', 'Southern Astrophysical Research Telescope'),
  ('VLT', 'Very Large Telescope'),
  ('GEMINI_NORTH', 'Gemini North')
ON CONFLICT (code) DO NOTHING;

INSERT INTO follow_up (lasair_id, priority, telescope, telescope_codes, status, notes, assigned_user, revisit_at)
VALUES
  (
    'LSS_J102429.1+091204',
    'Low',
    'LT',
    ARRAY['LT']::text[],
    'Observing',
    'Request spectroscopy before next queue rollover.',
    '22222222-2222-4222-8222-222222222222',
    now() + interval '18 hours'
  ),
  ('LSS_J221035.4-011923', 'Low', 'NTT', ARRAY['NTT']::text[], 'To Do', 'Photometric confirmation.', NULL, NULL),
  ('LSS_J034402.8-214411', 'Low', 'VLT', ARRAY['VLT', 'LT']::text[], 'Completed', 'Shared with SLSN Watch.', '33333333-3333-4333-8333-333333333333', NULL),
  ('LSS_J145924.2+372142', 'Low', NULL, '{}'::text[], 'Snooze', 'AGN contaminant.', NULL, NULL),
  ('LSS_J011449.7+153002', 'Low', NULL, '{}'::text[], 'To Do', 'Wait for next epoch.', NULL, NULL);

WITH simulated AS (
  SELECT
    index,
    'LSS_SIM_J' || (100000 + index * 137)::text || '.' || (index % 10)::text || '+' || (1000 + index * 29)::text AS lasair_id,
    round((0.56 + ((index * 7) % 39)::numeric / 100), 5) AS confidence,
    CASE
      WHEN index % 6 = 0 THEN 'Observing'
      WHEN index % 5 = 0 THEN 'Completed'
      ELSE 'To Do'
    END::follow_up_status AS status
  FROM generate_series(6, 20) AS index
)
INSERT INTO follow_up (lasair_id, priority, telescope, telescope_codes, status, notes, assigned_user)
SELECT
  lasair_id,
  'Low',
  NULL,
  '{}'::text[],
  status,
  'Simulated follow-up queue entry.',
  NULL
FROM simulated
WHERE status <> 'To Do';

INSERT INTO annotations (lasair_id, user_id, body, mentions)
VALUES
  ('LSS_J102429.1+091204', '22222222-2222-4222-8222-222222222222', '@TDE Follow-up please review the host offset and spectroscopy window before tomorrow''s queue.', ARRAY['TDE Follow-up']),
  ('LSS_J102429.1+091204', NULL, 'Classification confidence increased from 0.88 to 0.94 after latest r-band point.', ARRAY[]::text[]);

INSERT INTO object_comments (lasair_id, user_id, publisher, body, created_at)
VALUES
  ('LSS_J102429.1+091204', '22222222-2222-4222-8222-222222222222', 'M. Nicholl', 'Please prioritize spectroscopy while the source is still blue and rising.', now() - interval '3 hours'),
  ('LSS_J102429.1+091204', '33333333-3333-4333-8333-333333333333', 'X. Sheng', 'Host match looks clean; no obvious AGN history in the quick-look checks.', now() - interval '2 hours'),
  ('LSS_J221035.4-011923', '22222222-2222-4222-8222-222222222222', 'M. Nicholl', 'Likely normal Ia; keep in list but no urgent escalation.', now() - interval '4 hours')
ON CONFLICT DO NOTHING;

INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
VALUES
  ('22222222-2222-4222-8222-222222222222', 'exported daily TDE candidate report', 'report', 'daily-tde', '{}'),
  (NULL, 'scheduled NEEDLE 2.0 retraining job', 'model', 'NEEDLE 2.0', '{"scheduled_for":"2026-05-03"}'),
  ('33333333-3333-4333-8333-333333333333', 'invited ORCID user to TDE Follow-up', 'team', 'tde-follow-up', '{"orcid":"0000-0002-1825-0097"}'),
  (NULL, 'rotated refresh tokens for inactive sessions', 'security', 'refresh-tokens', '{}');

INSERT INTO teams (id, name, owner_id)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Transient Hunters', '22222222-2222-4222-8222-222222222222'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'TDE Follow-up', '22222222-2222-4222-8222-222222222222'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'SLSN Watch', '33333333-3333-4333-8333-333333333333')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (team_id, user_id, permission)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'classify'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'classify'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '11111111-1111-4111-8111-111111111111', 'annotate'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'annotate'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333', 'view')
ON CONFLICT (team_id, user_id) DO UPDATE SET permission = EXCLUDED.permission;
