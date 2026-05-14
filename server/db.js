import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

export const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

/**
 * Runs a parameterized SQL query through the shared PostgreSQL connection pool.
 * To tune database performance manually, adjust the pool settings above or pass different SQL/params from API helpers.
 */
export async function query(text, params = []) {
  if (!pool) {
    throw new Error("DATABASE_URL is not configured.");
  }

  return pool.query(text, params);
}
