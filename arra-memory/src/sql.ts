/**
 * Every SQL statement in the add-on, in one file.
 *
 * Nothing else in the codebase writes SQL inline. Keeping it here means the
 * complete surface that touches the database can be read top to bottom in one
 * sitting — which is what makes it auditable, and what makes swapping the
 * embedded file for a real sqld server a change of transport rather than a
 * change of behaviour.
 *
 * Every statement is parameterised with `?`. There is no string interpolation
 * anywhere in this file, and there must never be.
 */

// ── schema ────────────────────────────────────────────────────────────────────
// Applied as one batch on first use. Every statement is IF NOT EXISTS, so the
// batch is idempotent and doubles as the migration for an existing database.

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS memories (
     id          TEXT PRIMARY KEY,
     title       TEXT NOT NULL,
     content     TEXT NOT NULL,
     kind        TEXT NOT NULL DEFAULT 'note',
     tags        TEXT NOT NULL DEFAULT '[]',
     source      TEXT NOT NULL DEFAULT 'web',
     importance  INTEGER NOT NULL DEFAULT 3,
     -- Provenance. Structured columns rather than tags, because "which project"
     -- and "where did this come from" are things you filter and group by, and a
     -- tag list cannot be indexed for either.
     project     TEXT NOT NULL DEFAULT '',
     url         TEXT NOT NULL DEFAULT '',
     created_by  TEXT NOT NULL DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     CHECK (length(content) BETWEEN 1 AND 12000),
     CHECK (length(title) BETWEEN 1 AND 160),
     CHECK (importance BETWEEN 1 AND 5)
   )`,
  `CREATE INDEX IF NOT EXISTS memories_updated_idx
     ON memories(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memories_kind_idx
     ON memories(kind, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memories_importance_idx
     ON memories(importance DESC, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS memories_project_idx
     ON memories(project, updated_at DESC)`,

  // ── full-text search ───────────────────────────────────────────────────────
  //
  // tokenize='trigram', and that choice is not stylistic.
  //
  // FTS5's default unicode61 tokenizer splits on whitespace and punctuation.
  // Thai writes without spaces between words, so unicode61 swallows an entire
  // Thai sentence as ONE token and searching for a word inside it returns
  // nothing at all. Measured on this exact database engine, 2026-08-28:
  // searching "ความจำ" inside "ระบบความจำสำหรับผู้ช่วยเอไอ" returned 0 rows
  // under unicode61 and 1 row under trigram.
  //
  // Trigram indexes every 3-character sequence, so it needs no word boundaries
  // — which also makes it the one FTS5 tokenizer that can accelerate a
  // LIKE '%needle%'. The costs are honest: roughly 2-3x storage on the indexed
  // text, and queries shorter than 3 characters cannot use the index.
  //
  // `content=` makes this an external-content table: the text is NOT stored a
  // second time, only the index is. The triggers below keep it in step.
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
     title, content, tags,
     content='memories',
     content_rowid='rowid',
     tokenize='trigram'
   )`,

  // External-content FTS5 does not track its source table on its own. Without
  // these three triggers the index silently drifts from the corpus, which is
  // worse than having no index: searches return confidently wrong results.
  `CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(rowid, title, content, tags)
     VALUES (new.rowid, new.title, new.content, new.tags);
   END`,
  // 'delete' rows are how FTS5 retracts old terms for external content; a bare
  // UPDATE would leave the previous text matchable forever.
  `CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
     VALUES ('delete', old.rowid, old.title, old.content, old.tags);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
     VALUES ('delete', old.rowid, old.title, old.content, old.tags);
     INSERT INTO memories_fts(rowid, title, content, tags)
     VALUES (new.rowid, new.title, new.content, new.tags);
   END`,

  // The Cloudflare KV replacement. KV gave us three operations — get,
  // put-with-TTL, delete — and that is a table with an expiry column.
  // expires_at is a unix timestamp; NULL means the entry never expires.
  `CREATE TABLE IF NOT EXISTS kv (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     expires_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS kv_expiry_idx ON kv(expires_at)`,

  // The hosted version delegated these to Cloudflare's OAuth provider, which
  // stored them as opaque KV blobs. Owning the flow means they can be real
  // tables — queryable, inspectable, typed.
  `CREATE TABLE IF NOT EXISTS oauth_clients (
     client_id     TEXT PRIMARY KEY,
     client_name   TEXT,
     redirect_uris TEXT NOT NULL,
     created_at    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
     code                  TEXT PRIMARY KEY,
     client_id             TEXT NOT NULL,
     redirect_uri          TEXT NOT NULL,
     code_challenge        TEXT NOT NULL,
     code_challenge_method TEXT NOT NULL,
     scope                 TEXT NOT NULL DEFAULT '',
     expires_at            INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
     token      TEXT PRIMARY KEY,
     client_id  TEXT NOT NULL,
     scope      TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     expires_at INTEGER
   )`,
];

// ── key/value (replaces Cloudflare KV) ────────────────────────────────────────

export const KV = {
  // The expiry check lives in the query, not in JavaScript after the fetch: an
  // expired row must never be returned even once. That makes a stale row a
  // storage detail rather than an auth decision.
  //                                          args: key, nowSeconds
  get: `SELECT value FROM kv
         WHERE key = ?
           AND (expires_at IS NULL OR expires_at > ?)`,

  // Upsert, so re-issuing a session with the same id refreshes its deadline
  // instead of failing on the primary key. args: key, value, expiresAt|null
  put: `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE
            SET value = excluded.value, expires_at = excluded.expires_at`,

  //                                          args: key
  delete: `DELETE FROM kv WHERE key = ?`,

  // Housekeeping only — reads already ignore expired rows. args: nowSeconds
  sweep: `DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?`,
} as const;

// ── memories ──────────────────────────────────────────────────────────────────

const MEMORY_COLUMNS = `id, title, content, kind, tags, source, importance,
                        project, url, created_by, created_at, updated_at`;

export const MEMORIES = {
  // args: id, title, content, kind, tags, source, importance,
  //       project, url, createdBy, now, now
  insert: `INSERT INTO memories
             (id, title, content, kind, tags, source, importance,
              project, url, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  //                                          args: id
  byId: `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`,

  // Honest keyword search — substring matching over title, content and tags,
  // ranked by how well the hit matches rather than by relevance magic. An
  // empty query returns the recent-and-important slice instead of nothing.
  //
  // The repeated placeholders are deliberate: passing the query and the LIKE
  // pattern separately for each branch keeps every value parameterised.
  /**
   * Full-text search over the trigram index, ranked by BM25.
   *
   * Preferred over `search` below whenever the query is at least 3 characters
   * (trigram's floor). BM25 is negated in the ORDER BY because FTS5 returns it
   * as a score where MORE NEGATIVE is a better match — sorting ascending
   * without the negation would return the worst hits first.
   *
   * Title is weighted 3x and tags 2x against content, so a query that matches
   * a title outranks one buried in a paragraph.
   * args: match, kind, kind, project, project, limit
   */
  searchFts: `SELECT m.id, m.title, m.content, m.kind, m.tags, m.source,
                     m.importance, m.project, m.url, m.created_by,
                     m.created_at, m.updated_at
                FROM memories_fts f
                JOIN memories m ON m.rowid = f.rowid
               WHERE memories_fts MATCH ?
                 AND (? = '' OR m.kind = ?)
                 AND (? = '' OR m.project = ?)
               ORDER BY bm25(memories_fts, 3.0, 1.0, 2.0),
                        m.importance DESC,
                        m.updated_at DESC
               LIMIT ?`,

  /** Rebuilds the FTS index from the corpus. Used after a schema upgrade. */
  rebuildFts: `INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`,

  // args: query, pattern, pattern, pattern, kind, kind, project, project,
  //       tag, tagPattern, query, query, query, pattern, query, pattern, limit
  search: `SELECT ${MEMORY_COLUMNS}
             FROM memories
            WHERE (? = '' OR lower(title) LIKE ?
                          OR lower(content) LIKE ?
                          OR lower(tags) LIKE ?)
              AND (? = '' OR kind = ?)
              AND (? = '' OR project = ?)
              AND (? = '' OR lower(tags) LIKE ?)
            ORDER BY
              CASE
                WHEN ? <> '' AND lower(title) = lower(?) THEN 0
                WHEN ? <> '' AND lower(title) LIKE ?     THEN 1
                WHEN ? <> '' AND lower(tags)  LIKE ?     THEN 2
                ELSE 3
              END,
              importance DESC,
              updated_at DESC
            LIMIT ?`,

  // args: title, content, kind, tags, source, importance,
  //       project, url, createdBy, updatedAt, id
  update: `UPDATE memories
              SET title = ?, content = ?, kind = ?, tags = ?,
                  source = ?, importance = ?, project = ?, url = ?,
                  created_by = ?, updated_at = ?
            WHERE id = ?`,

  //                                          args: id
  delete: `DELETE FROM memories WHERE id = ?`,

  stats: {
    summary: `SELECT COUNT(*) AS total, MAX(updated_at) AS latest_updated_at
                FROM memories`,
    byKind: `SELECT kind, COUNT(*) AS count
               FROM memories
              GROUP BY kind
              ORDER BY count DESC, kind ASC`,
    // json_each unrolls the JSON tags array into rows so tags can be counted
    // without reading every memory into memory and folding it in JS.
    topTags: `SELECT value AS tag, COUNT(*) AS count
                FROM memories, json_each(memories.tags)
               GROUP BY value
               ORDER BY count DESC, value ASC
               LIMIT 8`,
  },

  // ── the facets the dynamic MCP tools are generated from ────────────────────
  // These are what make `tools/list` reflect the corpus instead of a fixed
  // list: each distinct project below becomes its own recall tool.
  facets: {
    projects: `SELECT project, COUNT(*) AS count, MAX(updated_at) AS latest
                 FROM memories
                WHERE project <> ''
                GROUP BY project
                ORDER BY count DESC, project ASC
                LIMIT ?`,
    allTags: `SELECT value AS tag, COUNT(*) AS count
                FROM memories, json_each(memories.tags)
               GROUP BY value
               ORDER BY count DESC, value ASC
               LIMIT ?`,

    // Which calendar months the corpus actually spans. Each becomes its own
    // search tool, so a model is offered `search_2026_08` only when there is
    // something to find in August 2026.
    months: `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS count
               FROM memories
              GROUP BY month
              ORDER BY month DESC
              LIMIT ?`,
  },

  // ── time ranges ────────────────────────────────────────────────────────────
  // created_at is ISO-8601 UTC, which sorts lexicographically — so a range is a
  // plain string BETWEEN and needs no date parsing in SQLite. Both bounds are
  // inclusive of the strings passed; the caller decides the boundaries.
  // args: fromIso, toIso, query, pattern, pattern, pattern, limit
  inRange: `SELECT ${MEMORY_COLUMNS}
              FROM memories
             WHERE created_at >= ? AND created_at <= ?
               AND (? = '' OR lower(title) LIKE ?
                           OR lower(content) LIKE ?
                           OR lower(tags) LIKE ?)
             ORDER BY created_at DESC
             LIMIT ?`,
} as const;

/**
 * Columns added after the first release.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and re-adding an existing column is
 * an error rather than a no-op — so these run individually and their failures
 * are swallowed. A fresh database already has them from CREATE TABLE above;
 * an upgraded one gets them here. See db.ts for the execution.
 */
export const MIGRATIONS: string[] = [
  `ALTER TABLE memories ADD COLUMN project    TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE memories ADD COLUMN url        TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE memories ADD COLUMN created_by TEXT NOT NULL DEFAULT ''`,

  // Semantic search. F32_BLOB is a libSQL native type, not an extension —
  // 1024 to match bge-m3. The width is fixed at column-creation time, so
  // changing the model to one with different dimensions means a new column and
  // a re-embed, not an edit here.
  `ALTER TABLE memories ADD COLUMN embedding F32_BLOB(1024)`,
  `ALTER TABLE memories ADD COLUMN embedding_model TEXT NOT NULL DEFAULT ''`,

  // An approximate-nearest-neighbour index, also native. Without it a semantic
  // query is a full scan computing cosine distance per row — fine for a hundred
  // memories, not for a hundred thousand.
  `CREATE INDEX IF NOT EXISTS memories_embedding_idx
     ON memories (libsql_vector_idx(embedding))`,
];

// ── OAuth ─────────────────────────────────────────────────────────────────────

export const OAUTH = {
  clients: {
    // args: clientId, clientName, redirectUrisJson, createdAt
    register: `INSERT INTO oauth_clients
                 (client_id, client_name, redirect_uris, created_at)
               VALUES (?, ?, ?, ?)`,
    //                                        args: clientId
    byId: `SELECT client_id, client_name, redirect_uris, created_at
             FROM oauth_clients WHERE client_id = ?`,
  },

  codes: {
    // args: code, clientId, redirectUri, challenge, method, scope, expiresAt
    issue: `INSERT INTO oauth_codes
              (code, client_id, redirect_uri, code_challenge,
               code_challenge_method, scope, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
    // args: code, nowSeconds
    consume: `SELECT code, client_id, redirect_uri, code_challenge,
                     code_challenge_method, scope, expires_at
                FROM oauth_codes
               WHERE code = ? AND expires_at > ?`,
    // Authorization codes are single-use: the caller deletes immediately after
    // a successful exchange, so a replayed code finds nothing.  args: code
    delete: `DELETE FROM oauth_codes WHERE code = ?`,
    // args: nowSeconds
    sweep: `DELETE FROM oauth_codes WHERE expires_at <= ?`,
  },

  tokens: {
    // args: token, clientId, scope, createdAt, expiresAt|null
    issue: `INSERT INTO oauth_tokens
              (token, client_id, scope, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)`,
    // args: token, nowSeconds
    verify: `SELECT token, client_id, scope, created_at, expires_at
               FROM oauth_tokens
              WHERE token = ?
                AND (expires_at IS NULL OR expires_at > ?)`,
    //                                        args: token
    revoke: `DELETE FROM oauth_tokens WHERE token = ?`,
    // args: nowSeconds
    sweep: `DELETE FROM oauth_tokens
             WHERE expires_at IS NOT NULL AND expires_at <= ?`,
  },
} as const;

// ── semantic search ───────────────────────────────────────────────────────────

export const VECTORS = {
  /** args: vectorLiteral, model, id */
  store: `UPDATE memories SET embedding = vector32(?), embedding_model = ? WHERE id = ?`,

  /**
   * Nearest neighbours by cosine distance.
   *
   * Distance, not similarity: 0 is identical and 2 is opposite, so this sorts
   * ASCENDING. Rows with no embedding are excluded rather than ranked last —
   * a NULL vector is "not indexed yet", which is not the same as "unrelated",
   * and letting it score would be a quiet lie.
   *
   * args: vectorLiteral, kind, kind, project, project, vectorLiteral, limit
   */
  search: `SELECT id, title, content, kind, tags, source, importance,
                  project, url, created_by, created_at, updated_at,
                  vector_distance_cos(embedding, vector32(?)) AS distance
             FROM memories
            WHERE embedding IS NOT NULL
              AND (? = '' OR kind = ?)
              AND (? = '' OR project = ?)
            ORDER BY vector_distance_cos(embedding, vector32(?)) ASC
            LIMIT ?`,

  /** Memories still missing a vector, oldest first. args: model, limit */
  pending: `SELECT id, title, content FROM memories
             WHERE embedding IS NULL OR embedding_model <> ?
             ORDER BY updated_at DESC
             LIMIT ?`,

  /** How much of the corpus is indexed, and by which model. */
  coverage: `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
                    MAX(embedding_model) AS model
               FROM memories`,
} as const;
