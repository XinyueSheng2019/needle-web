import { createServer } from "node:http";
import { URL } from "node:url";
import { query } from "./db.js";

const port = Number(process.env.API_PORT ?? 5174);
const demoUserId = process.env.DEMO_USER_ID ?? "11111111-1111-4111-8111-111111111111";

/**
 * Sends a JSON HTTP response with CORS headers for the Vite frontend.
 * To change allowed origins or methods manually, edit these headers or set `CORS_ORIGIN` in `.env`.
 */
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN ?? "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, PATCH, POST, OPTIONS",
    "Content-Type": "application/json",
  });
  response.end(JSON.stringify(body));
}

/**
 * Reads and parses a JSON request body from Node's native HTTP request stream.
 * To support larger payloads manually, add a byte limit check while chunks are collected.
 */
async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function normalizeTelescopeCodeToken(value) {
  const s = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  return s || null;
}

/**
 * Maps normalized facility tokens to the exact `observing_telescopes.code` values stored in PostgreSQL.
 * Matching is case-insensitive so e.g. GEMINI_NORTH resolves to the row stored as GEMINI_NORTH or Gemini_North.
 */
async function resolveTelescopeCodesForStore(tokens) {
  const normalized = [...new Set(tokens.map((c) => normalizeTelescopeCodeToken(c)).filter(Boolean))];
  if (normalized.length === 0) {
    return [];
  }
  const resolved = [];
  for (const code of normalized) {
    const result = await query(`SELECT code FROM observing_telescopes WHERE lower(code) = lower($1) LIMIT 1`, [code]);
    if (result.rowCount === 0) {
      const error = new Error(`Unknown telescope "${code}". Add it in the telescope menu first.`);
      error.statusCode = 400;
      throw error;
    }
    resolved.push(result.rows[0].code);
  }
  const seen = new Set();
  const out = [];
  for (const c of resolved) {
    if (seen.has(c)) {
      continue;
    }
    seen.add(c);
    out.push(c);
  }
  return out;
}

function coercePostgresTextArray(value) {
  if (value == null || value === "") {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === "{}") {
      return [];
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) {
        return [];
      }
      return inner.split(",").map((part) => part.trim().replace(/^"(.*)"$/, "$1"));
    }
  }
  return [];
}

function coercePsImageUrls(value) {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((x) => String(x)).filter(Boolean);
  }
  return [];
}

/** ZTF `fid` → filter name (Lasair / ZTF). */
function ztfFidToBand(fid) {
  const n = Number(fid);
  const map = { 1: "g", 2: "r", 3: "i" };
  if (map[n]) {
    return map[n];
  }
  return Number.isFinite(n) ? `fid${n}` : "";
}

/**
 * NEEDLE `mag_sets_v4` export: `{ objectId, objectData?, candidates: [{ mjd, magpsf, sigmapsf, fid, ... }] }`.
 * Candidates are flattened to `{ mjd, band, mag, magErr }` for the light-curve API.
 */
function photometryFromMagSetsV4(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.candidates)) {
    return null;
  }
  const out = [];
  for (const c of raw.candidates) {
    const mjd = Number(c.mjd);
    const mag = Number(c.magpsf);
    const band = ztfFidToBand(c.fid);
    if (!Number.isFinite(mjd) || !Number.isFinite(mag) || !band) {
      continue;
    }
    const magErrRaw = c.sigmapsf != null ? Number(c.sigmapsf) : undefined;
    const magErr = magErrRaw != null && Number.isFinite(magErrRaw) ? magErrRaw : undefined;
    out.push({ mjd, band, mag, magErr });
  }
  return out.length > 0 ? out : null;
}

/**
 * Normalizes stored photometry JSON: mag_sets_v4 object, flat array, or `{ points: [...] }`.
 */
function normalizePhotometryJson(raw) {
  const fromMagSets = photometryFromMagSetsV4(raw);
  if (fromMagSets) {
    return fromMagSets;
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(raw.points) ? raw.points : [];
  return list
    .map((p) => ({
      mjd: Number(p.mjd),
      band: String(p.band ?? ""),
      mag: Number(p.mag),
      magErr: p.magErr != null ? Number(p.magErr) : undefined,
    }))
    .filter((p) => Number.isFinite(p.mjd) && p.band && Number.isFinite(p.mag));
}

async function getObjectDetail(lasairId) {
  const objResult = await query(`SELECT lasair_id, photometry_json FROM objects WHERE lasair_id = $1`, [lasairId]);
  if (objResult.rowCount === 0) {
    return null;
  }
  const photometry = normalizePhotometryJson(objResult.rows[0].photometry_json);

  const histResult = await query(
    `
    SELECT DISTINCT ON ((classified_at AT TIME ZONE 'UTC')::date)
      (classified_at AT TIME ZONE 'UTC')::date AS day,
      classified_at,
      class::text AS class,
      confidence,
      raw_probs,
      model_version
    FROM needle_classifications
    WHERE lasair_id = $1
    ORDER BY (classified_at AT TIME ZONE 'UTC')::date ASC, classified_at DESC
    `,
    [lasairId],
  );

  const classificationHistory = histResult.rows.map((row) => {
    const day =
      row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    const ts = row.classified_at instanceof Date ? row.classified_at : new Date(row.classified_at);
    return {
      day,
      classifiedAt: ts.toISOString(),
      class: row.class,
      confidence: Number(row.confidence),
      rawProbs:
        row.raw_probs && typeof row.raw_probs === "object" && !Array.isArray(row.raw_probs)
          ? row.raw_probs
          : {},
      modelVersion: row.model_version ?? "",
    };
  });

  return { photometry, classificationHistory };
}

function telescopeCodesFromRow(row) {
  const raw = coercePostgresTextArray(row?.telescope_codes);
  let codes = [];
  if (raw.length > 0) {
    codes = raw.map((c) => String(c).trim()).filter(Boolean);
  } else if (row?.telescope) {
    const one = String(row.telescope).trim();
    if (one) {
      codes = [one];
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of codes) {
    if (seen.has(c)) {
      continue;
    }
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Converts PostgreSQL rows into the frontend `TransientObject` shape.
 * To expose new database columns manually, add new fields to the returned object and update the frontend type.
 */
function mapObject(row) {
  const imageHueByClass = {
    TDE: "190deg",
    "SLSNe-I": "265deg",
    "SN Ia": "28deg",
    "SN Ibc": "35deg",
    "SN II": "345deg",
    Unclear: "210deg",
    "AGN-removed": "320deg",
    Other: "225deg",
  };

  const telescopeCodes = telescopeCodesFromRow(row);

  return {
    id: row.lasair_id,
    name: row.object_name,
    lasairId: row.lasair_id,
    ra: String(row.ra),
    dec: Number(row.dec) >= 0 ? `+${row.dec}` : String(row.dec),
    magnitude: row.latest_mag == null ? "n/a" : String(row.latest_mag),
    band: row.band ?? "n/a",
    lastClassified: row.classified_at ? new Date(row.classified_at).toLocaleString() : "Unclassified",
    classifiedBy: row.model_version ?? "NEEDLE 2.0",
    classification: row.class ?? "Unclear",
    tnsClass: row.tns_class ?? null,
    tnsName: row.tns_name ?? null,
    psImageUrls: coercePsImageUrls(row.ps_image_urls),
    confidence: Number(row.confidence ?? 0),
    classProbabilities:
      row.raw_probs && typeof row.raw_probs === "object" && !Array.isArray(row.raw_probs) ? row.raw_probs : {},
    comment: row.latest_comment ?? "",
    comments: Array.isArray(row.object_comments) ? row.object_comments : [],
    starred: Boolean(row.starred),
    promoted: Boolean(row.promoted_to_tns),
    snoozed: Boolean(row.snoozed_until),
    followUp: mapFollowUpForClient(row.follow_up_status ?? row.follow_up_status_from_queue ?? "To Do"),
    priority: mapPriorityForClient(row.priority),
    lastActionAt: row.last_action_at
      ? row.last_action_at instanceof Date
        ? row.last_action_at.toISOString()
        : new Date(row.last_action_at).toISOString()
      : new Date(0).toISOString(),
    agnRemoved: Boolean(row.agn_removed),
    qualityFlags: row.quality_flags ?? [],
    imageHue: imageHueByClass[row.class] ?? "225deg",
    revisitAt: row.revisit_at
      ? row.revisit_at instanceof Date
        ? row.revisit_at.toISOString()
        : new Date(row.revisit_at).toISOString()
      : null,
    telescopeCodes,
    telescopeCode: telescopeCodes[0] ?? null,
  };
}

/**
 * Queries object summaries with optional class, confidence, and search filters.
 * To add a new filter manually, read it from `searchParams`, push a parameter, and append a SQL condition.
 */
async function getObjects(searchParams) {
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 500);
  const classFilter = searchParams.get("class");
  const minConfidence = Number(searchParams.get("minConfidence") ?? 0);
  const search = searchParams.get("search");

  const params = [demoUserId, limit, minConfidence];
  const filters = ["COALESCE(l.confidence, 0) >= $3"];

  if (classFilter) {
    params.push(classFilter);
    filters.push(`l.class = $${params.length}::object_class`);
  }

  if (search) {
    params.push(`%${search}%`);
    filters.push(`(l.object_name ILIKE $${params.length} OR l.lasair_id ILIKE $${params.length} OR l.ztf_id ILIKE $${params.length})`);
  }

  const result = await query(
    `
      SELECT
        l.*,
        i.starred,
        i.promoted_to_tns,
        i.snoozed_until,
        i.follow_up_status,
        f.priority,
        f.status AS follow_up_status_from_queue,
        f.telescope,
        f.telescope_codes,
        f.revisit_at,
        GREATEST(
          COALESCE(i.updated_at, to_timestamp(0)),
          COALESCE(f.updated_at, to_timestamp(0)),
          COALESCE(l.classified_at, to_timestamp(0))
        ) AS last_action_at,
        oc.latest_comment,
        oc.object_comments
      FROM latest_object_classifications l
      LEFT JOIN user_object_interactions i
        ON i.lasair_id = l.lasair_id AND i.user_id = $1
      LEFT JOIN LATERAL (
        SELECT priority, status, updated_at, telescope, telescope_codes, revisit_at
        FROM follow_up
        WHERE follow_up.lasair_id = l.lasair_id
        ORDER BY updated_at DESC
        LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT
          (ARRAY_AGG(body ORDER BY created_at DESC))[1] AS latest_comment,
          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', id::text,
                'publisher', publisher,
                'body', body,
                'createdAt', created_at
              )
              ORDER BY created_at DESC
            ),
            '[]'::jsonb
          ) AS object_comments
        FROM object_comments
        WHERE object_comments.lasair_id = l.lasair_id
        LIMIT 8
      ) oc ON true
      WHERE ${filters.join(" AND ")}
      ORDER BY l.classified_at DESC NULLS LAST
      LIMIT $2
    `,
    params,
  );

  return result.rows.map(mapObject);
}

/**
 * Loads one object by Lasair ID after an interaction update.
 * To return more detail manually, extend this SELECT with joins for extra tables.
 */
async function getObjectByLasairId(lasairId) {
  const result = await query(
    `
      SELECT
        l.*,
        i.starred,
        i.promoted_to_tns,
        i.snoozed_until,
        i.follow_up_status,
        f.priority,
        f.status AS follow_up_status_from_queue,
        f.telescope,
        f.telescope_codes,
        f.revisit_at,
        GREATEST(
          COALESCE(i.updated_at, to_timestamp(0)),
          COALESCE(f.updated_at, to_timestamp(0)),
          COALESCE(l.classified_at, to_timestamp(0))
        ) AS last_action_at,
        oc.latest_comment,
        oc.object_comments
      FROM latest_object_classifications l
      LEFT JOIN user_object_interactions i
        ON i.lasair_id = l.lasair_id AND i.user_id = $1
      LEFT JOIN LATERAL (
        SELECT priority, status, updated_at, telescope, telescope_codes, revisit_at
        FROM follow_up
        WHERE follow_up.lasair_id = l.lasair_id
        ORDER BY updated_at DESC
        LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT
          (ARRAY_AGG(body ORDER BY created_at DESC))[1] AS latest_comment,
          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', id::text,
                'publisher', publisher,
                'body', body,
                'createdAt', created_at
              )
              ORDER BY created_at DESC
            ),
            '[]'::jsonb
          ) AS object_comments
        FROM object_comments
        WHERE object_comments.lasair_id = l.lasair_id
        LIMIT 8
      ) oc ON true
      WHERE l.lasair_id = $2
      LIMIT 1
    `,
    [demoUserId, lasairId],
  );

  return result.rows[0] ? mapObject(result.rows[0]) : null;
}

async function listTelescopes() {
  const result = await query(
    `
      SELECT code, display_name
      FROM observing_telescopes
      ORDER BY code
    `,
  );

  return result.rows.map((row) => ({
    code: row.code,
    displayName: row.display_name,
  }));
}

async function createTelescope(body) {
  const rawCode = String(body.code ?? "").trim();
  if (!rawCode) {
    const error = new Error("Telescope code is required.");
    error.statusCode = 400;
    throw error;
  }

  const code = rawCode.toUpperCase().replace(/\s+/g, "_");

  if (!/^[A-Z0-9._-]{1,32}$/.test(code)) {
    const error = new Error("Telescope code must be 1–32 characters (letters, digits, . _ -).");
    error.statusCode = 400;
    throw error;
  }

  const displayName = body.displayName ? String(body.displayName).trim() : rawCode;

  await query(
    `
      INSERT INTO observing_telescopes (code, display_name)
      VALUES ($1, $2)
      ON CONFLICT (code) DO UPDATE SET display_name = EXCLUDED.display_name
    `,
    [code, displayName],
  );

  const refreshed = await query(`SELECT code, display_name FROM observing_telescopes WHERE code = $1`, [code]);

  return {
    code: refreshed.rows[0].code,
    displayName: refreshed.rows[0].display_name,
  };
}

/** Values allowed by Postgres enum `follow_up_status`. */
const CANONICAL_FOLLOW_UP = new Set(["To Do", "Observing", "Completed", "Snooze"]);

/**
 * Normalizes PATCH input: trims strings, drops null/empty.
 */
function normalizeFollowUpStatusForApi(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const s = String(value).trim();
  if (s === "" || s.toLowerCase() === "null") {
    return undefined;
  }
  return s;
}

/** Maps DB enum/string to client `FollowUpStatus`; unknown values fall back to To Do. */
function mapFollowUpForClient(raw) {
  const s = raw == null ? "" : String(raw).trim();
  if (CANONICAL_FOLLOW_UP.has(s)) {
    return s;
  }
  return "To Do";
}

const VALID_PRIORITIES = new Set(["High", "Medium", "Low", "Monitor"]);

function mapPriorityForClient(raw) {
  const p = raw == null || raw === "" ? "Low" : String(raw);
  return VALID_PRIORITIES.has(p) ? p : "Low";
}

async function syncFollowUpRow(lasairId, update) {
  const needsSync =
    update.followUp !== undefined ||
    update.priority !== undefined ||
    update.revisitAt !== undefined ||
    update.telescope !== undefined ||
    update.telescopeCodes !== undefined;

  if (!needsSync) {
    return;
  }

  if (update.priority !== undefined && !VALID_PRIORITIES.has(update.priority)) {
    const error = new Error("Invalid priority (use High, Medium, Low, or Monitor).");
    error.statusCode = 400;
    throw error;
  }

  const interactionResult = await query(
    `
      SELECT follow_up_status
      FROM user_object_interactions
      WHERE user_id = $1 AND lasair_id = $2
    `,
    [demoUserId, lasairId],
  );

  const interactionStatus = interactionResult.rows[0]?.follow_up_status ?? "To Do";

  const latestResult = await query(
    `
      SELECT id, status, priority, telescope, telescope_codes, revisit_at
      FROM follow_up
      WHERE lasair_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [lasairId],
  );

  const prev = latestResult.rows[0];
  const status = update.followUp ?? prev?.status ?? interactionStatus;

  let priority;
  if (update.priority !== undefined) {
    priority = update.priority;
  } else if (update.followUp === "Completed") {
    priority = "Low";
  } else if (prev) {
    priority = prev.priority;
  } else {
    priority = "Low";
  }

  let telescopeCodes = telescopeCodesFromRow(prev ?? {});
  if (update.telescopeCodes !== undefined) {
    if (!Array.isArray(update.telescopeCodes)) {
      const error = new Error("telescopeCodes must be an array of facility codes.");
      error.statusCode = 400;
      throw error;
    }
    telescopeCodes = await resolveTelescopeCodesForStore(update.telescopeCodes);
  } else if (update.telescope !== undefined) {
    if (update.telescope === null || update.telescope === "") {
      telescopeCodes = [];
    } else {
      const one = normalizeTelescopeCodeToken(update.telescope);
      if (!one) {
        telescopeCodes = [];
      } else {
        telescopeCodes = await resolveTelescopeCodesForStore([one]);
      }
    }
  }

  const telescopeLegacy = telescopeCodes[0] ?? null;

  let revisitAt = prev?.revisit_at ?? null;
  if (update.revisitAt !== undefined) {
    if (update.revisitAt === null || update.revisitAt === "") {
      revisitAt = null;
    } else {
      const parsed = new Date(update.revisitAt);
      if (Number.isNaN(parsed.getTime())) {
        const error = new Error("Invalid revisitAt datetime.");
        error.statusCode = 400;
        throw error;
      }
      revisitAt = parsed;
    }
  }

  if (prev) {
    await query(
      `
        UPDATE follow_up
        SET
          status = $2::follow_up_status,
          priority = $3,
          telescope = $4,
          telescope_codes = $5,
          revisit_at = $6,
          updated_at = now()
        WHERE id = $1
      `,
      [prev.id, status, priority, telescopeLegacy, telescopeCodes, revisitAt],
    );
  } else {
    await query(
      `
        INSERT INTO follow_up (lasair_id, priority, status, telescope, telescope_codes, revisit_at, notes)
        VALUES ($1, $2, $3::follow_up_status, $4, $5, $6, 'Follow-up queue')
      `,
      [lasairId, priority, status, telescopeLegacy, telescopeCodes, revisitAt],
    );
  }
}

/**
 * Persists Star, Promote, Snooze, and Follow-up changes for the demo user.
 * To change action behavior manually, edit the upsert into `user_object_interactions` and the follow-up update block.
 * Snooze is stored for 3 months; expired snoozed objects can be purged by `purge_expired_snoozed_objects()`.
 */
async function updateObjectInteraction(lasairId, update) {
  if (update.starred !== undefined) {
    const flags = await getSessionFlags();
    if (!flags.canEditStarred) {
      const error = new Error("Starred is only editable for private workspace accounts.");
      error.statusCode = 403;
      throw error;
    }
  }

  if (update.followUp !== undefined) {
    const normalized = normalizeFollowUpStatusForApi(update.followUp);
    if (normalized === undefined) {
      delete update.followUp;
    } else {
      update.followUp = normalized;
    }
  }

  const followUp = update.followUp;

  if (followUp !== undefined && !CANONICAL_FOLLOW_UP.has(followUp)) {
    const error = new Error("Invalid follow-up status.");
    error.statusCode = 400;
    throw error;
  }

  await query("SELECT lasair_id FROM objects WHERE lasair_id = $1", [lasairId]).then((result) => {
    if (result.rowCount === 0) {
      const error = new Error("Object not found.");
      error.statusCode = 404;
      throw error;
    }
  });

  await query(
    `
      INSERT INTO user_object_interactions (
        user_id,
        lasair_id,
        starred,
        promoted_to_tns,
        snoozed_until,
        follow_up_status,
        updated_at
      )
      VALUES (
        $1,
        $2,
        COALESCE($3::boolean, false),
        COALESCE($4::boolean, false),
        CASE
          WHEN $5::boolean IS NULL THEN NULL
          WHEN $5::boolean THEN now() + interval '3 months'
          ELSE NULL
        END,
        COALESCE($6::follow_up_status, 'To Do'::follow_up_status),
        now()
      )
      ON CONFLICT (user_id, lasair_id) DO UPDATE SET
        starred = COALESCE($3::boolean, user_object_interactions.starred),
        promoted_to_tns = COALESCE($4::boolean, user_object_interactions.promoted_to_tns),
        snoozed_until = CASE
          WHEN $5::boolean IS NULL THEN user_object_interactions.snoozed_until
          WHEN $5::boolean THEN now() + interval '3 months'
          ELSE NULL
        END,
        follow_up_status = COALESCE($6::follow_up_status, user_object_interactions.follow_up_status),
        updated_at = now()
    `,
    [
      demoUserId,
      lasairId,
      update.starred === undefined ? null : Boolean(update.starred),
      update.promoted === undefined ? null : Boolean(update.promoted),
      update.snoozed === undefined ? null : Boolean(update.snoozed),
      followUp ?? null,
    ],
  );

  await syncFollowUpRow(lasairId, update);

  await query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'updated object interaction', 'object', $2, $3::jsonb)
    `,
    [demoUserId, lasairId, JSON.stringify(update)],
  );

  return getObjectByLasairId(lasairId);
}

/**
 * Persists a new object comment and returns it in the frontend comment shape.
 * To use the logged-in user manually, replace `demoUserId` with the authenticated request user id.
 */
async function createObjectComment(lasairId, body) {
  const trimmedBody = typeof body === "string" ? body.trim() : "";

  if (!trimmedBody) {
    const error = new Error("Comment body is required.");
    error.statusCode = 400;
    throw error;
  }

  const objectResult = await query("SELECT lasair_id FROM objects WHERE lasair_id = $1", [lasairId]);

  if (objectResult.rowCount === 0) {
    const error = new Error("Object not found.");
    error.statusCode = 404;
    throw error;
  }

  const result = await query(
    `
      INSERT INTO object_comments (lasair_id, user_id, publisher, body)
      VALUES (
        $1,
        (SELECT id FROM users WHERE id = $3),
        COALESCE((SELECT display_name FROM users WHERE id = $3), 'Demo User'),
        $2
      )
      RETURNING id::text, publisher, body, created_at
    `,
    [lasairId, trimmedBody, demoUserId],
  );

  await query(
    `
      INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, metadata)
      VALUES ($1, 'posted object comment', 'object', $2, $3::jsonb)
    `,
    [demoUserId, lasairId, JSON.stringify({ body: trimmedBody })],
  );

  const comment = result.rows[0];

  return {
    id: comment.id,
    publisher: comment.publisher,
    body: comment.body,
    createdAt: comment.created_at,
  };
}

/**
 * Whether the current demo user may change `starred` on objects (private accounts only).
 * Override with env CAN_EDIT_STARRED=true|false. Otherwise uses users.preferences accountKind: private | shared.
 */
async function getSessionFlags() {
  const fromEnv = process.env.CAN_EDIT_STARRED;
  if (fromEnv !== undefined && String(fromEnv).trim() !== "") {
    const v = String(fromEnv).toLowerCase();
    return { canEditStarred: v === "1" || v === "true" || v === "yes" };
  }

  const result = await query(
    `
      SELECT COALESCE(preferences->>'accountKind', preferences->>'account_kind', 'private') AS kind
      FROM users
      WHERE id = $1
    `,
    [demoUserId],
  );
  const kind = String(result.rows[0]?.kind ?? "private").toLowerCase();
  return { canEditStarred: kind === "private" };
}

/**
 * Builds the frontend dashboard payload from multiple database queries.
 * To add data to the homepage manually, add another query here and include its result in the returned object.
 */
async function getDashboard() {
  const [session, objects, metricsResult, histogramResult, auditResult, teamsResult, annotationsResult, telescopesResult] =
    await Promise.all([
      getSessionFlags(),
      getObjects(new URLSearchParams([["limit", "100"]])),
    query(
      `
        SELECT
          COUNT(*)::int AS classified_total,
          COUNT(*) FILTER (WHERE c.classified_at >= now() - interval '24 hours')::int AS classified_today,
          COUNT(*) FILTER (WHERE i.starred)::int AS starred,
          COUNT(*) FILTER (WHERE i.snoozed_until > now())::int AS snoozed,
          COUNT(*) FILTER (WHERE f.status IS NOT NULL AND f.status <> 'Snooze')::int AS follow_up
        FROM latest_object_classifications c
        LEFT JOIN user_object_interactions i ON i.lasair_id = c.lasair_id AND i.user_id = $1
        LEFT JOIN follow_up f ON f.lasair_id = c.lasair_id
      `,
      [demoUserId],
    ),
    query(
      `
        SELECT
          to_char(day, 'Mon DD') AS day,
          COUNT(*) FILTER (WHERE class = 'TDE')::int AS tde,
          COUNT(*) FILTER (WHERE class = 'SLSNe-I')::int AS slsn,
          COUNT(*) FILTER (WHERE class IN ('SN Ia', 'SN Ibc', 'SN II'))::int AS sn,
          COUNT(*) FILTER (WHERE class = 'Unclear')::int AS unclear,
          COUNT(*) FILTER (WHERE class = 'AGN-removed')::int AS agn,
          COALESCE(round(avg(confidence) * 100), 0)::int AS confidence
        FROM generate_series(current_date - interval '6 days', current_date, interval '1 day') day
        LEFT JOIN needle_classifications c
          ON c.classified_at >= day AND c.classified_at < day + interval '1 day'
        GROUP BY day
        ORDER BY day
      `,
    ),
    query(
      `
        SELECT action, entity_type, entity_id, created_at
        FROM audit_log
        ORDER BY created_at DESC
        LIMIT 8
      `,
    ),
    query(
      `
        SELECT t.name, COUNT(tm.user_id)::int AS members, COUNT(tc.id)::int AS collections
        FROM teams t
        LEFT JOIN team_members tm ON tm.team_id = t.id
        LEFT JOIN team_collections tc ON tc.team_id = t.id
        GROUP BY t.id, t.name
        ORDER BY t.created_at DESC
        LIMIT 8
      `,
    ),
    query(
      `
        SELECT a.body, COALESCE(u.display_name, 'NEEDLE 2.0') AS author
        FROM annotations a
        LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC
        LIMIT 8
      `,
    ),
    query(
      `
        SELECT code, display_name
        FROM observing_telescopes
        ORDER BY code
      `,
    ),
  ]);

  const summary = metricsResult.rows[0];

  return {
    session,
    objects,
    metrics: [
      { label: "Promoted objects", value: String(summary.classified_total), delta: "from database" },
      { label: "Follow-up objects", value: String(summary.follow_up), delta: "active queue" },
      { label: "Snoozed objects", value: String(summary.snoozed), delta: "currently snoozed" },
      { label: "Classified today", value: String(summary.classified_today), delta: `${summary.classified_total} total` },
      { label: "Starred objects", value: String(summary.starred), delta: "personal + shared" },
    ],
    chartDays: histogramResult.rows.map((row) => ({
      day: row.day,
      tde: row.tde,
      slsn: row.slsn,
      sn: row.sn,
      unclear: row.unclear,
      agn: row.agn,
      confidence: row.confidence,
    })),
    auditEvents: auditResult.rows.map((row) => `${row.action} (${row.entity_type}${row.entity_id ? `/${row.entity_id}` : ""})`),
    teams: teamsResult.rows.map((row) => ({
      name: row.name,
      members: row.members,
      collections: row.collections,
      permission: "Team permissions managed by RBAC",
    })),
    annotations: annotationsResult.rows.map((row) => ({ author: row.author, body: row.body })),
    telescopes: telescopesResult.rows.map((row) => ({ code: row.code, displayName: row.display_name })),
  };
}

/**
 * Main HTTP router for the prototype API.
 * To add a new endpoint manually, add an `if` block here that checks `url.pathname` and calls a helper function.
 */
async function handleRequest(request, response) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  try {
    if (url.pathname === "/api/health") {
      await query("SELECT 1");
      sendJson(response, 200, { status: "ok", database: "connected" });
      return;
    }

    if (url.pathname === "/api/objects") {
      sendJson(response, 200, await getObjects(url.searchParams));
      return;
    }

    const interactionMatch = url.pathname.match(/^\/api\/objects\/(.+)\/interactions$/);
    if (request.method === "PATCH" && interactionMatch) {
      const lasairId = decodeURIComponent(interactionMatch[1]);
      const body = await readJsonBody(request);
      sendJson(response, 200, await updateObjectInteraction(lasairId, body));
      return;
    }

    const commentMatch = url.pathname.match(/^\/api\/objects\/(.+)\/comments$/);
    if (request.method === "POST" && commentMatch) {
      const lasairId = decodeURIComponent(commentMatch[1]);
      const body = await readJsonBody(request);
      sendJson(response, 201, await createObjectComment(lasairId, body.body));
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/objects\/(.+)\/detail$/);
    if (request.method === "GET" && detailMatch) {
      const lasairId = decodeURIComponent(detailMatch[1]);
      const detail = await getObjectDetail(lasairId);
      if (!detail) {
        sendJson(response, 404, { error: "Object not found" });
        return;
      }
      sendJson(response, 200, detail);
      return;
    }

    if (url.pathname === "/api/telescopes") {
      if (request.method === "GET") {
        sendJson(response, 200, await listTelescopes());
        return;
      }

      if (request.method === "POST") {
        const body = await readJsonBody(request);
        sendJson(response, 201, await createTelescope(body));
        return;
      }
    }

    if (url.pathname === "/api/dashboard") {
      sendJson(response, 200, await getDashboard());
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode ?? 500, {
      error: "API request failed",
      detail: error.message,
    });
  }
}

createServer(handleRequest).listen(port, () => {
  console.log(`NEEDLE-LSST API listening on http://localhost:${port}`);
});
