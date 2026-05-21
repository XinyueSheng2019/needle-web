# NEEDLE-LSST Web

Professional dark-mode research platform prototype for the NEEDLE 2.0 LSST transient classifier.

## What is included

- Responsive React + TypeScript + Vite frontend scaffold.
- Global layout with navbar, object search, user actions, sidebar navigation, and footer credits.
- Dashboard metrics, recent activity, model health, statistics charts, object list, object detail view, starred/team sharing, follow-up queue, annotations, model monitor, admin controls, and backend blueprint.
- PostgreSQL/PostGIS schema designed for millions of alerts with range partitioning, BRIN indexes, JSONB payload storage, full-text search support, and coordinate cone search.
- Node API server that connects the prototype to the database, with frontend fallback data when the API is offline.

## Run locally

```bash
npm install
npm run dev
```

## Run with PostgreSQL

Start the scalable local Postgres/PostGIS database:

```bash
docker compose up -d postgres
```

Create `.env` from the example:

```bash
cp .env.example .env
export DATABASE_URL=postgres://needle:needle_dev_password@localhost:5432/needle_lsst
```

Initialize schema and seed data:

```bash
npm run db:init
```

Wipe the application database created by Docker (drops and recreates the DB named in `DATABASE_URL`, then run `db:init` again):

```bash
npm run db:clean && npm run db:init
```

Run the API and frontend in two terminals:

```bash
npm run dev:api
```

```bash
npm run dev
```

The frontend proxies `/api/*` to `http://localhost:5174`.

Production build:

```bash
npm run build
```

## Next implementation steps

1. Add ingestion jobs for Lasair alert streams into the partitioned `alerts` table.
2. Add monthly alert partition automation in deployment.
3. Connect authentication, RBAC enforcement, audit logging middleware, WebSocket alerts, and Lasair pushback.
4. Add production charting/table libraries for very large paginated result sets.

## Troubleshooting

### API port already in use

```bash
lsof -nP -iTCP -sTCP:LISTEN
kill -9 <pid>
npm run dev:api
```

## Understand the development structure

### Layout

The app is split into three layers: **Postgres** (`db/`), **Node HTTP API** (`server/`), and **React + Vite** (`src/`). In development, Vite proxies `/api` to the API on port **5174** (`vite.config.ts`).

### Database (`db/`)

| File | Role |
|------|------|
| `schema.sql` | Defines tables, enums, indexes (objects, alerts, classifications, interactions, telescopes, etc.). Change this when you need new columns or tables. |
| `seed.sql` | Demo/reference rows after schema apply. Good for sample data; not usually where app logic lives. |
| `init.js` | One-shot script: connects with `DATABASE_URL`, runs `schema.sql` then `seed.sql`, optionally loads demo photometry from `demo/mag_sets_v4/`. Run via `npm run db:init`. |

### API server (`server/`)

| File | Role |
|------|------|
| `db.js` | Shared `pg` `Pool` and `query(sql, params)`. All DB access goes through `query`; without `DATABASE_URL`, `pool` is `null` and queries throw. |
| `api.js` | Plain Node `http` server: CORS, JSON helpers, mapping/normalization helpers, `handleRequest` router. Endpoints include `/api/health`, `/api/dashboard`, `/api/objects`, `PATCH …/interactions`, `POST …/comments`, `GET …/detail`, `/api/telescopes` (GET/POST). Extend by adding routes in `handleRequest`. |

Comment in `server/api.js` (around `handleRequest` / lines 876–879):

```javascript
/**
 * Main HTTP router for the prototype API.
 * To add a new endpoint manually, add an `if` block here that checks `url.pathname` and calls a helper function.
 */
```

**Implementation pattern:** add a named `async` helper (like `getDashboard`) near the other helpers, then branch on `url.pathname` and HTTP method inside `handleRequest`.

### Frontend (`src/`)

| File         | Role                                                                                                                                                                                 |
| --------------| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `main.tsx`   | React bootstrap: mounts `App` and imports `styles.css`.                                                                                                                              |
| `App.tsx`    | Almost all UI: layout, routing-ish views, charts, lists, wiring clicks to `src/api.ts`. Large file — change when adding screens or interactions.                                     |
| `api.ts`     | `fetch('/api/...')` wrappers (`fetchPlatformData`, `updateObjectInteraction`, comments, detail, telescopes, etc.), plus `normalizeTransientObject`. Single client-side API boundary. |
| `data.ts`    | TypeScript types (`TransientObject`, `PlatformData`, …) and `fallbackPlatformData` when the API is down. Align shapes with what the server returns.                                  |
| `styles.css` | Global styling for the prototype.                                                                                                                                                    |

### Config / tooling

| File             | Role                                                                                    |
| ------------------| -----------------------------------------------------------------------------------------|
| `package.json`   | Scripts: `vite` (frontend), `node server/api.js` (`dev:api`), `db/init.js` (`db:init`). |
| `vite.config.ts` | Dev proxy: `/api` → `localhost:5174`.                                                   |
| `tsconfig*.json` | TypeScript project splits for app vs Node tooling.                                      |

### Where to program first when adding a feature

Use this order so types and contracts stay aligned:

1. **Data model** — If it needs persistence, edit `db/schema.sql` (and `seed.sql` for fixtures), then run `npm run db:init` on a database you can reset (or apply migrations manually — this repo replays full schema in `init.js`).
2. **Server behavior** — Implement SQL + helpers in `server/api.js`, call `query` from `server/db.js`, and register the route in `handleRequest`.
3. **Client API** — Add `fetch` helpers (and request/response types) in `src/api.ts`.
4. **Types & offline story** — Extend `src/data.ts` and, if the UI should work without the API, `fallbackPlatformData`.
5. **UI** — Wire buttons/forms/lists in `src/App.tsx` and style in `src/styles.css` if needed.

If the feature is **UI-only** (no DB), start in `src/App.tsx` with local/fake state; when you need persistence, add `server/api.js` and the steps above.

### Quick mental model

- `schema.sql` — what exists in Postgres.
- `server/api.js` — HTTP + SQL + JSON the browser receives.
- `src/api.ts` — how the React app calls that HTTP API.
- `src/data.ts` — contracts and demo data.
- `App.tsx` — what users see and do.

Together, that is enough to navigate the repo and put new behavior in the right layer on the first try.


### function design

#### TAGS
- transient tags: star, promote, follow-up, snooze;
- for follow-ups, four priorities: High, medium, low, monitor 
- `snooze` is to remove the present of false positives, once it is removed, user can still find it via the search bar; if the classification outlier score increase 0.3, the object will return to the object list.
- `monitor` is to monitor the high-confidence candidates with few detections, and need more detections to ensure the priority; user can pair this tag with revisit function via setting the time interval to check again.
