import pg from "pg";

// BIGINT (int8) columns come back as bigint, never as a lossy JS number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => BigInt(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

/** Runs `fn` in one transaction: COMMIT on success, ROLLBACK on any error. */
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
