import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required, for example postgres://needle:needle_dev_password@localhost:5432/needle_lsst");
  process.exit(1);
}

function assertSafeIdent(name, label) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`${label} must be ASCII letters, numbers, or underscores only: ${JSON.stringify(name)}`);
  }
}

function quoteIdent(ident) {
  return `"${ident.replace(/"/g, '""')}"`;
}

function parseDbContext(urlString) {
  const url = new URL(urlString);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!dbName) throw new Error("DATABASE_URL must include a database name in the path");
  assertSafeIdent(dbName, "Database name");
  const owner = decodeURIComponent(url.username || "postgres");
  assertSafeIdent(owner, "Database owner (user from DATABASE_URL)");
  const adminUrl = new URL(urlString);
  adminUrl.pathname = "/postgres";
  return { dbName, owner, adminConnectionString: adminUrl.toString() };
}

const { dbName, owner, adminConnectionString } = parseDbContext(databaseUrl);

const admin = new Client({ connectionString: adminConnectionString });

try {
  await admin.connect();
  console.error(`Dropping database ${dbName} (maintenance connection to postgres)...`);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(owner)}`);
  console.log(`Recreated empty database ${dbName} (owner ${owner}). Run: npm run db:init`);
} finally {
  await admin.end();
}
