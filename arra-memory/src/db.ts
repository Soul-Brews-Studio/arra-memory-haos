import { createClient, type Client } from "@libsql/client";
import { MEMORIES, MIGRATIONS, SCHEMA } from "./sql";

/**
 * One embedded libSQL database holds everything: the memory corpus, the
 * key/value store that replaces Cloudflare KV, and the OAuth tables.
 *
 * `file:` means the database is a plain file on disk — no server, no network,
 * no account. It is the same libSQL/Turso engine the hosted product runs; only
 * the transport differs. Point DATABASE_URL at a `libsql://` or `http://` sqld
 * and every statement in sql.ts keeps working unchanged.
 */

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

export function db(): Client {
  if (!client) {
    // /data is the only directory Home Assistant persists across add-on
    // restarts AND includes in its backups. Anywhere else is scratch space
    // that quietly vanishes on the next update.
    const url = process.env.DATABASE_URL ?? "file:/data/arra-memory.db";
    const syncUrl = process.env.TURSO_SYNC_URL?.trim();
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

    if (syncUrl && authToken) {
      // Embedded replica. The local file stays the read path — every query is
      // answered from disk at local speed, with no network in the hot path —
      // while libSQL replicates against Turso in the background. Writes go to
      // the primary and come back on the next sync.
      //
      // This is what makes the corpus survive the machine: catlab can be lost
      // entirely and the memories are still in Turso.
      client = createClient({
        url,
        syncUrl,
        authToken,
        // Seconds. Low enough that a second client sees a write soon, high
        // enough that an idle add-on is not chattering at the network.
        syncInterval: Number(process.env.TURSO_SYNC_INTERVAL) || 60,
      });
      console.log(`[arra-memory] embedded replica: ${url} ⇄ ${syncUrl}`);
    } else {
      client = createClient({ url });
    }
  }
  return client;
}

/**
 * Applies the schema once per process.
 *
 * Memoized on the promise rather than guarded by a boolean: concurrent first
 * requests would each see `false` and race to create the same tables. Every
 * caller awaits the one migration instead.
 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = migrate().catch((error) => {
      // Clear the memo so the next request retries rather than inheriting a
      // permanently rejected promise and wedging the add-on.
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/**
 * libSQL types every column as `Row` (a value bag), which never structurally
 * overlaps with the shapes callers actually expect — so every read needs a
 * double assertion. These two helpers hold that assertion in one place instead
 * of scattering `as unknown as` through every query site.
 *
 * The assertion is honest: the shape is guaranteed by the SELECT list in
 * sql.ts, which is the only place columns are named.
 */
export function rows<T>(result: { rows: unknown[] }): T[] {
  return result.rows as unknown as T[];
}

export function firstRow<T>(result: { rows: unknown[] }): T | undefined {
  return result.rows[0] as unknown as T | undefined;
}

async function migrate(): Promise<void> {
  // Everything in SCHEMA is IF NOT EXISTS, so the batch is idempotent and
  // doubles as the create path for a fresh database.
  await db().batch(SCHEMA, "write");

  // Columns added after the first release. SQLite rejects a duplicate ADD
  // COLUMN rather than ignoring it, and there is no IF NOT EXISTS form, so the
  // only way to be idempotent is to attempt each one and discard the failure.
  // Run individually — inside a batch, one expected error rolls back the rest.
  for (const statement of MIGRATIONS) {
    try {
      await db().execute(statement);
    } catch {
      // Already present. This is the success case on every run after the first.
    }
  }

  // Rows written before the FTS table existed are invisible to it — the
  // triggers only fire on new writes. 'rebuild' reindexes the whole corpus,
  // which is cheap at personal scale and idempotent, so it runs every start.
  try {
    await db().execute(MEMORIES.rebuildFts);
  } catch {
    // A brand-new database has nothing to rebuild; not an error.
  }
}
