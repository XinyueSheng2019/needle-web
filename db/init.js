import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required, for example postgres://postgres:postgres@localhost:5432/needle_lsst");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });


// this is a demo for photometry but not in the database yet
try {
  await client.connect();
  await client.query(readFileSync(resolve("db/schema.sql"), "utf8"));
  await client.query(readFileSync(resolve("db/seed.sql"), "utf8"));

  const demoMagPath = resolve("demo/mag_sets_v4/ZTF23abaujuy.json");
  if (existsSync(demoMagPath)) {
    const payload = readFileSync(demoMagPath, "utf8");
    const doc = JSON.parse(payload);
    const ztfId = typeof doc.objectId === "string" ? doc.objectId : "ZTF23abaujuy";
    await client.query(
      `UPDATE objects SET photometry_json = $1::jsonb, ztf_id = $2 WHERE lasair_id = $3`,
      [payload, ztfId, "LSS_J102429.1+091204"],
    );
    console.log(`Demo photometry (${ztfId}, mag_sets_v4) stored on LSS_J102429.1+091204.`);
  } else {
    console.warn("Optional demo/mag_sets_v4/ZTF23abaujuy.json not found; photometry_json left at default for seed rows.");
  }


  
  console.log("PostgreSQL schema and seed data are ready.");
} finally {
  await client.end();
}
