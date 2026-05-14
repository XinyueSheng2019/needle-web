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

### remove node:
lsof -nP -iTCP -sTCP:LISTEN
kill -9 xxxx
npm run dev:api 