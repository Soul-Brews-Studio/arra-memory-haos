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

/** The standalone on-disk corpus. Always exists; never replaced by the replica. */
function localUrl(): string {
  // /data is the only directory Home Assistant persists across add-on
  // restarts AND includes in its backups. Anywhere else is scratch space
  // that quietly vanishes on the next update.
  return process.env.DATABASE_URL ?? "file:/data/arra-memory.db";
}

/**
 * The replica's OWN file — never the standalone one.
 *
 * An embedded replica keeps a metadata sidecar next to its database and expects
 * to have created both. Handed a plain SQLite file that already exists, libSQL
 * refuses with:
 *
 *   sync error: invalid local state: db file exists but metadata file does not
 *
 * and — this is the part that matters — it refuses on EVERY statement, so
 * turning sync on took down reads and writes together. Measured on catlab
 * 2026-08-28: the add-on returned that string for `GET /api/memories` and every
 * write, with a corpus that was completely intact on disk.
 *
 * Giving the replica its own path means it creates the file and the metadata as
 * a matched pair, and the standalone corpus stays exactly where it was.
 */
function replicaUrl(): string {
  return localUrl().replace(/\.db$/, "") + "-replica.db";
}

/** Why the replica is not in use, when it was asked for. Null means no problem. */
let replicaError: string | null = null;
let replicaActive = false;

export function replicaStatus(): { active: boolean; requested: boolean; error: string | null } {
  return {
    active: replicaActive,
    requested: Boolean(process.env.TURSO_SYNC_URL?.trim() && process.env.TURSO_AUTH_TOKEN?.trim()),
    error: replicaError,
  };
}

export function db(): Client {
  if (!client) client = createClient({ url: replicaActive ? replicaUrl() : localUrl() });
  return client;
}

/**
 * Bring the replica up, if one is configured — and never let it take the add-on
 * down when it cannot.
 *
 * Replication is an optional durability feature. A corpus that is readable
 * without it must stay readable when it fails: a wrong token, an expired one, a
 * deleted database or no network are all conditions where the right behaviour is
 * "serve from the local file and say loudly that replication is off", not
 * "return a sync error for every request". That distinction is the whole reason
 * this runs at startup and catches.
 */
async function startReplica(): Promise<void> {
  const syncUrl = process.env.TURSO_SYNC_URL?.trim();
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  if (!syncUrl || !authToken) return;

  try {
    const replica = createClient({
      url: replicaUrl(),
      syncUrl,
      authToken,
      // Seconds. Low enough that a second client sees a write soon, high
      // enough that an idle add-on is not chattering at the network.
      syncInterval: Number(process.env.TURSO_SYNC_INTERVAL) || 60,
    });
    // Prove it before trusting it. A constructed client has contacted nothing;
    // the first sync is the first moment the credentials are actually tested.
    await replica.sync();

    client = replica;
    replicaActive = true;
    replicaError = null;
    console.log(`[arra-memory] embedded replica: ${replicaUrl()} ⇄ ${syncUrl}`);
  } catch (error) {
    replicaActive = false;
    replicaError = error instanceof Error ? error.message : String(error);
    client = createClient({ url: localUrl() });
    console.error(
      `[arra-memory] replication is OFF — the corpus is being served from the ` +
        `local file and is NOT being copied to Turso. Reason: ${replicaError}`,
    );
  }
}

/**
 * Copies the standalone database into a freshly created replica, table by table.
 *
 * Turning replication on must not look like losing anything. The replica starts
 * from whatever Turso holds — nothing, the first time — so without this the
 * previous state appears deleted while sitting untouched in a file next door.
 *
 * EVERY table, not just `memories`. The first version of this copied the corpus
 * and nothing else, which silently reset three things that are not the corpus
 * and are not obviously part of it:
 *
 *   - `search_log`  — the entire history of what had been looked for
 *   - `kv`          — which MCP tools the owner had switched off
 *   - `oauth_*`     — the registered client and token for the claude.ai
 *                     connector, i.e. the connector stops working
 *
 * Each table is guarded on ITSELF being empty rather than on the corpus being
 * empty, so a replica that already has memories can still recover the tables
 * that were missed — this heals a database that was seeded by the earlier,
 * memories-only version on its next restart.
 */
const SEEDED_TABLES = [
  "memories",
  "search_log",
  "kv",
  "oauth_clients",
  "oauth_codes",
  "oauth_tokens",
] as const;

async function seedReplica(): Promise<void> {
  if (!replicaActive) return;

  let standalone: Client | null = null;
  try {
    standalone = createClient({ url: localUrl() });
  } catch {
    return;
  }

  try {
    for (const table of SEEDED_TABLES) {
      try {
        // Only into an empty table. This is what makes the whole thing safe to
        // run on every start, and what lets it fill in tables a previous
        // version of this function never copied.
        const mine = firstRow<{ n: number }>(
          await db().execute(`SELECT COUNT(*) AS n FROM ${table}`),
        );
        if (Number(mine?.n ?? 0) > 0) continue;

        const source = await standalone.execute(`SELECT * FROM ${table}`);
        const existing = source.rows as unknown as Array<Record<string, unknown>>;
        if (!existing.length) continue;

        // Columns come from the source result rather than a hard-coded list, so
        // a column added later is carried across without editing this function
        // — the failure mode being avoided is a seed that silently drops a
        // field nobody remembered to add here.
        const columns = source.columns;
        const placeholders = columns.map(() => "?").join(", ");
        const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;

        for (const row of existing) {
          await db().execute({ sql, args: columns.map((c) => row[c] as never) });
        }
        console.log(`[arra-memory] seeded ${existing.length} rows into ${table}`);
      } catch (error) {
        // One table failing must not abandon the rest — a missing table in an
        // older standalone database is expected, not fatal.
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such table/i.test(message)) {
          console.error(`[arra-memory] could not seed ${table}: ${message}`);
        }
      }
    }
    await (db() as Client & { sync?: () => Promise<unknown> }).sync?.();
  } finally {
    standalone.close();
  }
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
  // Replication first: it decides WHICH database everything below runs against,
  // and it must be allowed to fail without taking the corpus with it.
  await startReplica();

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

  // After the columns exist, before the index is built: a freshly created
  // replica gets the standalone corpus copied in, so switching replication on
  // does not read as having lost everything.
  await seedReplica();

  // Rows written before the FTS table existed are invisible to it — the
  // triggers only fire on new writes. 'rebuild' reindexes the whole corpus,
  // which is cheap at personal scale and idempotent, so it runs every start.
  try {
    await db().execute(MEMORIES.rebuildFts);
  } catch {
    // A brand-new database has nothing to rebuild; not an error.
  }
}
