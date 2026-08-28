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
     --
     -- workspace is the tier ABOVE project: one workspace holds many projects.
     -- It is a plain column and there is no workspaces table, so the hierarchy
     -- is DERIVED: SELECT DISTINCT workspace, project is the whole of it. That
     -- keeps a workspace free to appear the moment an agent writes into it and to
     -- vanish when the last memory leaves, with nothing to keep in step.
     --
     -- Empty means UNSET, exactly as it does for project: an unset value matches
     -- every filter rather than forming a "none" bucket, so nothing an agent
     -- wrote before this column existed becomes invisible.
     workspace   TEXT NOT NULL DEFAULT '',
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
  // NOTE: indexes over `workspace` live in MIGRATIONS, not here. This batch runs
  // BEFORE the ALTER TABLE statements, and `CREATE TABLE IF NOT EXISTS` is a
  // no-op on an existing database — so an index naming a migrated column fails
  // with "no such column" on exactly the upgrade path, while passing on a fresh
  // database where CREATE TABLE supplied it. memories_embedding_idx is in
  // MIGRATIONS for the same reason.

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
  // ── the search log ─────────────────────────────────────────────────────────
  //
  // This stores the QUERY TEXT and the ids it returned, which is a deliberate
  // and consequential choice. A search log that records what you looked for is
  // as sensitive as the corpus itself — arguably more so, because intent is
  // often sharper than content. It exists because "what was I searching for
  // last week" is a real question; it is disable-able for the same reason.
  //
  // Result IDS are stored, never result CONTENT: the memories are already in
  // the table next door, and duplicating their text here would double the
  // blast radius of a leak for no added recall.
  `CREATE TABLE IF NOT EXISTS search_log (
     id           TEXT PRIMARY KEY,
     query        TEXT NOT NULL DEFAULT '',
     mode         TEXT NOT NULL DEFAULT 'keyword',
     kind         TEXT NOT NULL DEFAULT '',
     -- The log records the filters a search ran under, so it has to learn every
     -- new one. Without this column the log would answer "who searched inside
     -- which workspace" with a confident blank.
     workspace    TEXT NOT NULL DEFAULT '',
     project      TEXT NOT NULL DEFAULT '',
     tag          TEXT NOT NULL DEFAULT '',
     result_count INTEGER NOT NULL DEFAULT 0,
     result_ids   TEXT NOT NULL DEFAULT '[]',
     duration_ms  INTEGER NOT NULL DEFAULT 0,
     source       TEXT NOT NULL DEFAULT '',
     created_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS search_log_created_idx
     ON search_log(created_at DESC)`,

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
                        workspace, project, url, created_by, created_at, updated_at`;

/**
 * The scope filters, in the one order every statement below uses.
 *
 * Each is a SET, passed as a JSON array: `[]` disables that filter entirely,
 * `["a"]` is one value, `["a","b"]` is either. That is what makes an unscoped
 * search return the whole corpus — a client that knows nothing about workspaces
 * keeps working exactly as it did — while a scoped one narrows without a second
 * code path.
 *
 * Sets rather than single values because the UI filters with chips you toggle,
 * and "show me haos-oracle AND kvm-oracle" is one question, not two searches
 * the caller has to merge. `json_each` unrolls the array inside SQLite, so the
 * whole thing stays one bound parameter and there is still no interpolation.
 *
 * Within a row it is OR (any of these workspaces); across rows it is AND (that
 * workspace AND that agent), which is what someone ticking boxes expects.
 *
 * `prefix` exists because the FTS and vector statements alias the table.
 * args in every case: kind, kind, workspace, workspace, project, project,
 *                     createdBy, createdBy
 */
const scopeFilter = (prefix = "") => `
              AND (? = '[]' OR ${prefix}kind       IN (SELECT value FROM json_each(?)))
              AND (? = '[]' OR ${prefix}workspace  IN (SELECT value FROM json_each(?)))
              AND (? = '[]' OR ${prefix}project    IN (SELECT value FROM json_each(?)))
              AND (? = '[]' OR ${prefix}created_by IN (SELECT value FROM json_each(?)))`;

export const MEMORIES = {
  // args: id, title, content, kind, tags, source, importance,
  //       workspace, project, url, createdBy, now, now
  insert: `INSERT INTO memories
             (id, title, content, kind, tags, source, importance,
              workspace, project, url, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

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
   * args: match, then the eight scope arguments, then limit
   */
  searchFts: `SELECT m.id, m.title, m.content, m.kind, m.tags, m.source,
                     m.importance, m.workspace, m.project, m.url, m.created_by,
                     m.created_at, m.updated_at
                FROM memories_fts f
                JOIN memories m ON m.rowid = f.rowid
               WHERE memories_fts MATCH ?${scopeFilter("m.")}
               ORDER BY bm25(memories_fts, 3.0, 1.0, 2.0),
                        m.importance DESC,
                        m.updated_at DESC
               LIMIT ?`,

  /** Rebuilds the FTS index from the corpus. Used after a schema upgrade. */
  rebuildFts: `INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`,

  // args: query, pattern, pattern, pattern, <eight scope arguments>,
  //       tag, tagPattern, query, query, query, pattern, query, pattern, limit
  search: `SELECT ${MEMORY_COLUMNS}
             FROM memories
            WHERE (? = '' OR lower(title) LIKE ?
                          OR lower(content) LIKE ?
                          OR lower(tags) LIKE ?)${scopeFilter()}
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

  /**
   * Merge one facet value into another, across the whole corpus.
   *
   * Free-text facets drift: `retro`, `Retro` and `retros` become three kinds the
   * moment three callers disagree. Merge is the repair — and it exists precisely
   * BECAUSE the vocabulary is open. A closed enum prevents drift by refusing
   * words; an open one permits words and needs a way to reconcile them.
   *
   * Renames rather than deletes: no row is removed, no row loses its place in
   * the corpus. updated_at is deliberately untouched — a merge is a change to
   * the vocabulary, not to the memory, and bumping it would reorder the whole
   * archive by an act of tidying. args: to, from
   */
  mergeKind: `UPDATE memories SET kind = ? WHERE kind = ?`,
  mergeWorkspace: `UPDATE memories SET workspace = ? WHERE workspace = ?`,
  mergeProject: `UPDATE memories SET project = ? WHERE project = ?`,
  mergeAgent: `UPDATE memories SET created_by = ? WHERE created_by = ?`,

  /**
   * Merging a TAG is not a column rewrite — tags are a JSON array, so the value
   * has to be replaced inside it and the result de-duplicated (a memory already
   * carrying both the source and the target must not end up with the target
   * twice). json_each unrolls, json_group_array rebuilds, DISTINCT dedupes.
   * args: from, to, from  — the first ? is the value MATCHED, the second the
   * replacement, the third the existence guard. Written out because three
   * placeholders of the same two values is exactly where a transposition hides.
   */
  mergeTag: `UPDATE memories
                SET tags = (
                      SELECT json_group_array(v) FROM (
                        SELECT DISTINCT CASE WHEN value = ? THEN ? ELSE value END AS v
                          FROM json_each(memories.tags)
                      )
                    )
              WHERE EXISTS (
                    SELECT 1 FROM json_each(memories.tags) WHERE value = ?
                  )`,

  /** Distinct kinds with counts — the chip row, and what merge is chosen from. */
  kinds: `SELECT kind, COUNT(*) AS count
            FROM memories
           WHERE kind <> ''
           GROUP BY kind
           ORDER BY count DESC, kind ASC`,

  // args: title, content, kind, tags, source, importance,
  //       workspace, project, url, createdBy, updatedAt, id
  update: `UPDATE memories
              SET title = ?, content = ?, kind = ?, tags = ?,
                  source = ?, importance = ?, workspace = ?, project = ?,
                  url = ?, created_by = ?, updated_at = ?
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
    // args: workspace, workspace, limit
    projects: `SELECT project, COUNT(*) AS count, MAX(updated_at) AS latest
                 FROM memories
                WHERE project <> ''
                  AND (? = '' OR workspace = ?)
                GROUP BY project
                ORDER BY count DESC, project ASC
                LIMIT ?`,
    // args: workspace, workspace, limit
    allTags: `SELECT value AS tag, COUNT(*) AS count
                FROM memories, json_each(memories.tags)
               WHERE (? = '' OR memories.workspace = ?)
               GROUP BY value
               ORDER BY count DESC, value ASC
               LIMIT ?`,

    /**
     * The workspaces, and what each one contains.
     *
     * There is no workspaces table, so this query IS the workspace list — a
     * workspace exists exactly as long as a memory names it. The two DISTINCT
     * counts are what make the tier above `project` worth having: they answer
     * "how many projects and how many agents are in here" without a second
     * round trip per row.
     *
     * NULLIF maps the unset sentinel to NULL so COUNT(DISTINCT ...) skips it —
     * without it, "no project" would be counted as a project named "".
     * args: limit
     */
    workspaces: `SELECT workspace,
                        COUNT(*) AS count,
                        COUNT(DISTINCT NULLIF(project, ''))    AS projects,
                        COUNT(DISTINCT NULLIF(created_by, '')) AS agents,
                        MAX(updated_at) AS latest
                   FROM memories
                  WHERE workspace <> ''
                  GROUP BY workspace
                  ORDER BY count DESC, workspace ASC
                  LIMIT ?`,

    /**
     * Every project in the corpus, regardless of workspace.
     *
     * The chip rows are flat: project chips are shown alongside workspace chips
     * rather than appearing only after a workspace is picked. A dropdown that
     * materialises once you choose something else is a nested choice, and the
     * whole point of the chip bar is that there is nothing to open and nothing
     * to unlock. args: limit
     */
    allProjects: `SELECT project, COUNT(*) AS count, MAX(updated_at) AS latest
                    FROM memories
                   WHERE project <> ''
                   GROUP BY project
                   ORDER BY count DESC, project ASC
                   LIMIT ?`,

    /**
     * How many memories name no workspace at all.
     *
     * The list above hides them, and a Workspaces page that silently omits part
     * of the corpus is a lie told by omission — this is what lets the page say
     * so out loud. args: none
     */
    unassigned: `SELECT COUNT(*) AS count FROM memories WHERE workspace = ''`,

    /**
     * Who has written to the corpus. Optionally within one workspace.
     *
     * `created_by` has been stored since the first release and was filterable by
     * nothing — this is the query that turns it into a facet.
     * args: workspace, workspace, limit
     */
    agents: `SELECT created_by AS agent, COUNT(*) AS count,
                    MAX(updated_at) AS latest
               FROM memories
              WHERE created_by <> ''
                AND (? = '' OR workspace = ?)
              GROUP BY created_by
              ORDER BY count DESC, created_by ASC
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
  // args: fromIso, toIso, query, pattern, pattern, pattern,
  //       <eight scope arguments>, limit
  inRange: `SELECT ${MEMORY_COLUMNS}
              FROM memories
             WHERE created_at >= ? AND created_at <= ?
               AND (? = '' OR lower(title) LIKE ?
                           OR lower(content) LIKE ?
                           OR lower(tags) LIKE ?)${scopeFilter()}
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

  // The workspace tier, added in 0.10.0. Existing rows get '' — unset, not
  // "default" — so every memory written before workspaces existed stays visible
  // to every search rather than being filed under a bucket nobody asked for.
  `ALTER TABLE memories   ADD COLUMN workspace TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE search_log ADD COLUMN workspace TEXT NOT NULL DEFAULT ''`,

  // These two must come AFTER the ALTER above and must not be in SCHEMA — see
  // the note there. Leading on workspace then project makes one index serve
  // both "everything in this workspace" and "this project inside it", since a
  // composite index is usable by any prefix of its columns.
  `CREATE INDEX IF NOT EXISTS memories_workspace_idx
     ON memories(workspace, project, updated_at DESC)`,
  // "Which agent wrote this" is a filter now rather than a stored-and-forgotten
  // column, so it needs an index to be one.
  `CREATE INDEX IF NOT EXISTS memories_created_by_idx
     ON memories(created_by, updated_at DESC)`,

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

// ── the search log ────────────────────────────────────────────────────────────

const SEARCH_LOG_COLUMNS = `id, query, mode, kind, workspace, project, tag,
                            result_count, result_ids, duration_ms, source,
                            created_at`;

export const SEARCH_LOG = {
  // args: id, query, mode, kind, workspace, project, tag,
  //       count, idsJson, ms, source, now
  record: `INSERT INTO search_log
             (id, query, mode, kind, workspace, project, tag,
              result_count, result_ids, duration_ms, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  // args: limit
  list: `SELECT ${SEARCH_LOG_COLUMNS}
           FROM search_log
          ORDER BY created_at DESC
          LIMIT ?`,

  // Substring match over the recorded queries. args: pattern, limit
  find: `SELECT ${SEARCH_LOG_COLUMNS}
           FROM search_log
          WHERE lower(query) LIKE ?
          ORDER BY created_at DESC
          LIMIT ?`,

  //                                          args: id
  deleteOne: `DELETE FROM search_log WHERE id = ?`,

  /** Everything. Used only when the caller explicitly confirms. */
  deleteAll: `DELETE FROM search_log`,

  // Older than an ISO cutoff the caller computes. args: cutoffIso
  deleteBefore: `DELETE FROM search_log WHERE created_at < ?`,

  stats: `SELECT COUNT(*) AS total,
                 MIN(created_at) AS oldest,
                 MAX(created_at) AS newest
            FROM search_log`,
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
   * args: vectorLiteral, <eight scope arguments>, vectorLiteral, limit
   */
  search: `SELECT id, title, content, kind, tags, source, importance,
                  workspace, project, url, created_by, created_at, updated_at,
                  vector_distance_cos(embedding, vector32(?)) AS distance
             FROM memories
            WHERE embedding IS NOT NULL${scopeFilter()}
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
