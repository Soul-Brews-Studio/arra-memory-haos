import { db, ensureSchema } from "./db";
import { KV } from "./sql";
import { nowSeconds } from "./utils";

/**
 * The Cloudflare KV replacement.
 *
 * The hosted version bound a `KVNamespace` and used exactly three of its
 * methods — get, put with an expirationTtl, and delete — to track which owner
 * sessions are still valid. None of that needs Cloudflare; it needs a table
 * with an expiry column, which is what `KV` in sql.ts is.
 *
 * Expiry is enforced inside the query rather than by a background job, so an
 * expired entry is invisible to `get` the instant it lapses whether or not
 * anything has swept it. A stale row is a storage detail, never an auth
 * decision. `sweep` exists only to stop the table growing.
 */

export async function kvGet(key: string): Promise<string | null> {
  await ensureSchema();
  const result = await db().execute({
    sql: KV.get,
    args: [key, nowSeconds()],
  });
  const row = result.rows[0];
  return row ? String(row.value) : null;
}

export async function kvPut(
  key: string,
  value: string,
  options: { expirationTtl?: number } = {},
): Promise<void> {
  await ensureSchema();
  const expiresAt = options.expirationTtl
    ? nowSeconds() + options.expirationTtl
    : null;
  await db().execute({ sql: KV.put, args: [key, value, expiresAt] });
}

export async function kvDelete(key: string): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: KV.delete, args: [key] });
}

/** Drops rows already past their deadline. Housekeeping only — see the note above. */
export async function kvSweep(): Promise<number> {
  await ensureSchema();
  const result = await db().execute({ sql: KV.sweep, args: [nowSeconds()] });
  return Number(result.rowsAffected ?? 0);
}
