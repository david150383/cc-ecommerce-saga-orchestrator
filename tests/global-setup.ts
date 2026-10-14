import { runner } from "node-pg-migrate";
import pg from "pg";

// Recreates an empty test database and applies the real SQL migrations.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://saga_svc:saga_local_pw@localhost:5432/saga_test";

export default async function setup(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  url.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: url.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      "Cannot reach PostgreSQL for integration tests. Start it with `docker compose up -d` here or in " +
        "ecommerce-infrastructure, or set TEST_DATABASE_URL.",
      { cause: err },
    );
  }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  await runner({
    databaseUrl: TEST_DATABASE_URL,
    dir: "migrations",
    direction: "up",
    migrationsTable: "pgmigrations",
    count: Number.POSITIVE_INFINITY,
    log: () => undefined,
  });
}
