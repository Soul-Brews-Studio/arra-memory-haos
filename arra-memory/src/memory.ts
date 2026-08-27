import { db, ensureSchema, firstRow, rows } from "./db";
import { MEMORIES } from "./sql";
import {
  clampLimit,
  makeMemoryTitle,
  normalizeCreatedBy,
  normalizeImportance,
  normalizeKind,
  normalizeProject,
  normalizeSource,
  normalizeTags,
  normalizeText,
  normalizeUrl,
  nowIso,
  parseTags,
  type MemoryKind,
} from "./utils";

/**
 * The memory corpus. Every statement it runs lives in sql.ts; this file owns
 * validation, shaping rows into objects, and nothing else.
 */

export interface Memory {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  source: string;
  importance: number;
  project: string;
  url: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  title?: string;
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  source?: string;
  importance?: number;
  project?: string;
  url?: string;
  createdBy?: string;
}

export type UpdateMemoryInput = Partial<CreateMemoryInput>;

export interface SearchMemoryInput {
  query?: string;
  kind?: MemoryKind;
  /** Exact project match — the facet the dynamic MCP tools filter on. */
  project?: string;
  /** Substring match within the JSON tags array. */
  tag?: string;
  limit?: number;
}

export interface MemoryStats {
  total: number;
  kinds: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  latestUpdatedAt: string | null;
}

interface MemoryRow {
  id: string;
  title: string;
  content: string;
  kind: string;
  tags: string;
  source: string;
  importance: number;
  project: string;
  url: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    kind: normalizeKind(row.kind as MemoryKind),
    tags: parseTags(row.tags),
    source: row.source,
    importance: Number(row.importance),
    project: row.project ?? "",
    url: row.url ?? "",
    createdBy: row.created_by ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createMemory(input: CreateMemoryInput): Promise<Memory> {
  await ensureSchema();

  const content = normalizeText(input.content, "content", 12_000);
  // A missing title is inferred rather than rejected: the MCP client usually
  // has content and no title, and refusing would make `remember` awkward.
  const title = normalizeText(
    input.title?.trim() || makeMemoryTitle(content),
    "title",
    160,
  );
  const kind = normalizeKind(input.kind);
  const tags = normalizeTags(input.tags);
  const source = normalizeSource(input.source);
  const importance = normalizeImportance(input.importance);
  const project = normalizeProject(input.project);
  const url = normalizeUrl(input.url);
  const createdBy = normalizeCreatedBy(input.createdBy);
  const now = nowIso();
  const id = crypto.randomUUID();

  await db().execute({
    sql: MEMORIES.insert,
    args: [
      id, title, content, kind, JSON.stringify(tags), source, importance,
      project, url, createdBy, now, now,
    ],
  });

  return {
    id, title, content, kind, tags, source, importance,
    project, url, createdBy, createdAt: now, updatedAt: now,
  };
}

/** Trigram's floor: a query shorter than this cannot use the FTS index. */
const TRIGRAM_MIN = 3;

/**
 * Escapes a user query for an FTS5 MATCH.
 *
 * FTS5 MATCH takes an expression language — bare `AND`, `*`, `:` and `-` are
 * operators, and an unbalanced quote is a syntax error rather than a search for
 * a quote. Wrapping the whole thing in double quotes makes it a literal phrase;
 * doubling any embedded quote is how FTS5 escapes one.
 */
function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export async function searchMemories(
  input: SearchMemoryInput = {},
): Promise<Memory[]> {
  await ensureSchema();

  const query = (input.query ?? "").trim().slice(0, 240);

  // Take the indexed path when the query is long enough for trigram AND no tag
  // filter is involved — tag matching is a JSON-substring test the FTS table
  // cannot express, so those queries stay on the LIKE path below.
  if (query.length >= TRIGRAM_MIN && !input.tag) {
    const kind = input.kind ? normalizeKind(input.kind) : "";
    const project = normalizeProject(input.project);
    try {
      const result = await db().execute({
        sql: MEMORIES.searchFts,
        args: [ftsPhrase(query), kind, kind, project, project, clampLimit(input.limit)],
      });
      return rows<MemoryRow>(result).map(toMemory);
    } catch {
      // An FTS failure must never mean "no results" — a corrupt or missing
      // index degrades to the scan below rather than lying about the corpus.
    }
  }
  const pattern = `%${query.toLocaleLowerCase()}%`;
  const kind = input.kind ? normalizeKind(input.kind) : "";
  const project = normalizeProject(input.project);
  const tag = (input.tag ?? "").trim().toLocaleLowerCase();
  // Tags live as a JSON array in one column, so a tag filter is a substring
  // match against that text. Quoting the needle stops "ha" matching "haos".
  const tagPattern = tag ? `%"${tag}"%` : "";
  const limit = clampLimit(input.limit);

  // The argument list is long because the ranking CASE re-tests the query and
  // the LIKE pattern per branch. Every one is a bound parameter — see sql.ts.
  const result = await db().execute({
    sql: MEMORIES.search,
    args: [
      query, pattern, pattern, pattern,
      kind, kind,
      project, project,
      tag, tagPattern,
      query, query,
      query, pattern,
      query, pattern,
      limit,
    ],
  });

  return rows<MemoryRow>(result).map(toMemory);
}

export async function getMemory(id: string): Promise<Memory | null> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.byId,
    args: [normalizeText(id, "id", 100)],
  });
  const row = firstRow<MemoryRow>(result);
  return row ? toMemory(row) : null;
}

export async function updateMemory(
  id: string,
  input: UpdateMemoryInput,
): Promise<Memory | null> {
  const existing = await getMemory(id);
  if (!existing) return null;

  // Every field falls back to what is already stored, so a partial update
  // never blanks a column the caller did not mention.
  const content =
    input.content === undefined
      ? existing.content
      : normalizeText(input.content, "content", 12_000);
  const title =
    input.title === undefined ? existing.title : normalizeText(input.title, "title", 160);
  const kind = input.kind === undefined ? existing.kind : normalizeKind(input.kind);
  const tags = input.tags === undefined ? existing.tags : normalizeTags(input.tags);
  const source =
    input.source === undefined ? existing.source : normalizeSource(input.source);
  const importance =
    input.importance === undefined
      ? existing.importance
      : normalizeImportance(input.importance);
  const project =
    input.project === undefined ? existing.project : normalizeProject(input.project);
  const url = input.url === undefined ? existing.url : normalizeUrl(input.url);
  const createdBy =
    input.createdBy === undefined ? existing.createdBy : normalizeCreatedBy(input.createdBy);
  const updatedAt = nowIso();

  await db().execute({
    sql: MEMORIES.update,
    args: [
      title, content, kind, JSON.stringify(tags), source, importance,
      project, url, createdBy, updatedAt, existing.id,
    ],
  });

  // createdAt is deliberately not touched: a revision is the same memory.
  return {
    ...existing,
    title, content, kind, tags, source, importance, project, url, createdBy, updatedAt,
  };
}

export async function deleteMemory(id: string): Promise<boolean> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.delete,
    args: [normalizeText(id, "id", 100)],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function getMemoryStats(): Promise<MemoryStats> {
  await ensureSchema();
  const conn = db();
  const [summary, kinds, tags] = await Promise.all([
    conn.execute(MEMORIES.stats.summary),
    conn.execute(MEMORIES.stats.byKind),
    conn.execute(MEMORIES.stats.topTags),
  ]);

  const summaryRow = firstRow<{ total: number; latest_updated_at: string | null }>(summary);

  return {
    total: Number(summaryRow?.total ?? 0),
    kinds: Object.fromEntries(
      rows<{ kind: string; count: number }>(kinds).map((r) => [
        r.kind,
        Number(r.count),
      ]),
    ),
    topTags: rows<{ tag: string; count: number }>(tags).map((r) => ({
      tag: String(r.tag),
      count: Number(r.count),
    })),
    latestUpdatedAt: summaryRow?.latest_updated_at ?? null,
  };
}

// ── facets: what the dynamic MCP tools are generated from ─────────────────────

export interface ProjectFacet {
  project: string;
  count: number;
  latest: string;
}

/**
 * Distinct projects in the corpus, busiest first.
 *
 * This is the query that makes `tools/list` dynamic: each project returned here
 * becomes its own recall tool, so a model sees `recall_haos_oracle` rather than
 * having to know that `project` is a parameter and guess its value.
 */
export async function listProjects(limit = 20): Promise<ProjectFacet[]> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.facets.projects,
    args: [clampLimit(limit, 20)],
  });
  return rows<{ project: string; count: number; latest: string }>(result).map((row) => ({
    project: String(row.project),
    count: Number(row.count),
    latest: String(row.latest),
  }));
}

/** Every tag in the corpus with its use count, busiest first. */
export async function listTags(limit = 50): Promise<Array<{ tag: string; count: number }>> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.facets.allTags,
    args: [clampLimit(limit, 50)],
  });
  return rows<{ tag: string; count: number }>(result).map((row) => ({
    tag: String(row.tag),
    count: Number(row.count),
  }));
}

/** Distinct calendar months the corpus spans, newest first. */
export async function listMonths(limit = 24): Promise<Array<{ month: string; count: number }>> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.facets.months,
    args: [clampLimit(limit, 24)],
  });
  return rows<{ month: string; count: number }>(result).map((row) => ({
    month: String(row.month),
    count: Number(row.count),
  }));
}

/**
 * Memories created inside a time range, newest first.
 *
 * created_at is ISO-8601 UTC and therefore sorts lexicographically, so the
 * range is a plain string comparison — no date functions, no timezone maths in
 * the database. The caller (timerange.ts) owns what the boundaries mean.
 */
export async function searchInRange(input: {
  fromIso: string;
  toIso: string;
  query?: string;
  limit?: number;
}): Promise<Memory[]> {
  await ensureSchema();
  const query = (input.query ?? "").trim().slice(0, 240);
  const pattern = `%${query.toLocaleLowerCase()}%`;
  const result = await db().execute({
    sql: MEMORIES.inRange,
    args: [
      input.fromIso, input.toIso,
      query, pattern, pattern, pattern,
      clampLimit(input.limit),
    ],
  });
  return rows<MemoryRow>(result).map(toMemory);
}

// ── semantic search ───────────────────────────────────────────────────────────

import { VECTORS } from "./sql";
import {
  providerFromEnv,
  toVectorLiteral,
  type EmbeddingProvider,
} from "./embedding";

let provider: EmbeddingProvider | null | undefined;

/** Resolved once. `null` means embeddings are switched off, not broken. */
export function embeddings(): EmbeddingProvider | null {
  if (provider === undefined) provider = providerFromEnv();
  return provider;
}

/**
 * Embeds one memory and stores the vector.
 *
 * Best-effort by contract: every failure is swallowed and reported as `false`.
 * The memory is already written by the time this runs, and a side-car being
 * down must never cost the corpus a memory.
 */
export async function indexMemory(memory: Memory): Promise<boolean> {
  const p = embeddings();
  if (!p) return false;
  try {
    // Title and content together: a title carries meaning the body often
    // assumes, and embedding them apart loses the connection.
    const [vector] = await p.embed([`${memory.title}\n\n${memory.content}`]);
    if (!vector) return false;
    await db().execute({
      sql: VECTORS.store,
      args: [toVectorLiteral(vector), p.model, memory.id],
    });
    return true;
  } catch {
    return false;
  }
}

export interface SemanticResult {
  memories: Memory[];
  /** Cosine distance per memory id: 0 identical, 2 opposite. */
  distances: Record<string, number>;
}

/** Nearest neighbours. Throws only if embedding the QUERY fails. */
export async function searchSemantic(input: {
  query: string;
  kind?: MemoryKind;
  project?: string;
  limit?: number;
}): Promise<SemanticResult> {
  await ensureSchema();
  const p = embeddings();
  if (!p) throw new Error("embeddings are not configured");

  const [vector] = await p.embed([input.query]);
  if (!vector) throw new Error("query produced no embedding");

  const literal = toVectorLiteral(vector);
  const kind = input.kind ? normalizeKind(input.kind) : "";
  const project = normalizeProject(input.project);

  const result = await db().execute({
    sql: VECTORS.search,
    args: [literal, kind, kind, project, project, literal, clampLimit(input.limit)],
  });

  const found = rows<MemoryRow & { distance: number }>(result);
  return {
    memories: found.map(toMemory),
    distances: Object.fromEntries(found.map((r) => [r.id, Number(r.distance)])),
  };
}

/** How much of the corpus carries a vector, and from which model. */
export async function embeddingCoverage(): Promise<{
  total: number;
  embedded: number;
  model: string | null;
  enabled: boolean;
}> {
  await ensureSchema();
  const p = embeddings();
  try {
    const r = firstRow<{ total: number; embedded: number; model: string | null }>(
      await db().execute(VECTORS.coverage),
    );
    return {
      total: Number(r?.total ?? 0),
      embedded: Number(r?.embedded ?? 0),
      model: r?.model || null,
      enabled: Boolean(p),
    };
  } catch {
    // The vector column may not exist on a database from before this feature.
    return { total: 0, embedded: 0, model: null, enabled: Boolean(p) };
  }
}

/**
 * Embeds memories that have no vector yet, or whose vector came from a
 * different model. Returns how many were indexed.
 */
export async function backfillEmbeddings(limit = 50): Promise<number> {
  const p = embeddings();
  if (!p) return 0;
  await ensureSchema();

  const pending = rows<{ id: string; title: string; content: string }>(
    await db().execute({ sql: VECTORS.pending, args: [p.model, clampLimit(limit)] }),
  );

  let indexed = 0;
  for (const row of pending) {
    // One at a time rather than one big batch: a single oversized request that
    // fails loses the whole set, and this runs in the background anyway.
    const ok = await indexMemory({ ...(row as any), id: row.id } as Memory);
    if (ok) indexed++;
  }
  return indexed;
}
