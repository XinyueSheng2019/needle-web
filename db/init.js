import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required, for example postgres://postgres:postgres@localhost:5432/needle_lsst");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(readFileSync(resolve("db/schema.sql"), "utf8"));
  await client.query(readFileSync(resolve("db/seed.sql"), "utf8"));
  console.log("PostgreSQL schema and seed data are ready.");
} finally {
  await client.end();
}
