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
 * Copies the standalone corpus into a freshly created replica, once.
 *
 * Turning replication on must not look like losing every memory. The replica
 * starts from whatever Turso holds — nothing, the first time — so without this
 * the archive would open empty and the previous memories would appear deleted
 * while sitting untouched in a file next door.
 *
 * Guarded on the replica being EMPTY, so it runs exactly once and can never
 * overwrite memories that arrived from another machine.
 */
async function seedReplica(): Promise<void> {
  if (!replicaActive) return;
  try {
    const mine = firstRow<{ n: number }>(await db().execute("SELECT COUNT(*) AS n FROM memories"));
    if (Number(mine?.n ?? 0) > 0) return;

    const standalone = createClient({ url: localUrl() });
    let existing: MemoryImport[] = [];
    try {
      existing = rows<MemoryImport>(
        await standalone.execute(
          `SELECT id, title, content, kind, tags, source, importance,
                  workspace, project, url, created_by, created_at, updated_at
             FROM memories`,
        ),
      );
    } catch {
      // No standalone corpus to carry over — a first-ever install with sync
      // already configured. Nothing to do, and not a failure.
      return;
    } finally {
      standalone.close();
    }
    if (!existing.length) return;

    for (const m of existing) {
      await db().execute({
        sql: MEMORIES.insert,
        args: [
          m.id, m.title, m.content, m.kind, m.tags, m.source, m.importance,
          m.workspace ?? "", m.project ?? "", m.url ?? "", m.created_by ?? "",
          m.created_at, m.updated_at,
        ],
      });
    }
    await (db() as Client & { sync?: () => Promise<unknown> }).sync?.();
    console.log(`[arra-memory] seeded the replica with ${existing.length} existing memories`);
  } catch (error) {
    // A failed seed leaves an empty replica, which is recoverable; it must not
    // stop the add-on serving.
    console.error(
      `[arra-memory] could not seed the replica: ${error instanceof Error ? error.message : error}`,
    );
  }
}

interface MemoryImport {
  id: string; title: string; content: string; kind: string; tags: string;
  source: string; importance: number; workspace: string | null; project: string | null;
  url: string | null; created_by: string | null; created_at: string; updated_at: string;
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
