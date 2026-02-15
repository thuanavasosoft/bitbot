import dotenv from "dotenv";
import { Pool } from "pg";

/**
 * Creates the TrailMultiplierOptimizationBotAction table if it does not exist.
 * Uses DATABASE_URL (PostgreSQL).
 * Run with: npx tsx db/dbInit.ts
 */
async function dbInit() {
  dotenv.config();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString,
    max: 5,
  });

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS "TrailMultiplierOptimizationBotAction" (
          "id" serial PRIMARY KEY,
          "runId" varchar(256) NOT NULL,
          "actionType" varchar(256) NOT NULL,
          "meta" jsonb NOT NULL,
          "timestamp" timestamp NOT NULL
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS "TrailMultiplierOptimizationBot_timestamp"
        ON "TrailMultiplierOptimizationBotAction" ("timestamp")
      `);
      console.log("TrailMultiplierOptimizationBotAction table ready (created if not exist).");
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("dbInit failed:", err);
    throw err;
  } finally {
    await pool.end();
  }
}

dbInit();
