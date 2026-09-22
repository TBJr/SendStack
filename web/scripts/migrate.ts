import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { getPool } from "../lib/db";

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const dir = join(__dirname, "../drizzle");
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const applied = await client.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [file]);
      if (applied.rows[0]) {
        console.log(`Skip ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (id, applied_at) VALUES ($1, NOW())`, [file]);
        await client.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("Migrations complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
