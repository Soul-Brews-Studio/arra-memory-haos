import { db, ensureSchema, firstRow, rows } from "./db";
import { recordSearch } from "./searchlog";
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
  normalizeWorkspace,
  nowIso,
  readKind,
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
  workspace: string;
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
  /** The team-level namespace. One workspace holds many projects. */
  workspace?: string;
  project?: string;
  url?: string;
  createdBy?: string;
}

export type UpdateMemoryInput = Partial<CreateMemoryInput>;

/**
 * One filter value, or several.
 *
 * Every facet is optional and every omitted facet means "do not narrow on
 * this". That is the multi-agent contract: workspace and agent are FILTERS, not
 * boundaries — an unscoped search still sees the entire corpus, so nothing an
 * agent writes can be hidden from a human looking for it.
 *
 * A bare string is one value and stays the shape every MCP tool passes; an array
 * is "any of these", which is what a row of chips produces when more than one is
 * ticked. Undefined or empty means no filtering on that facet.
 */
export type ScopeValue = string | string[] | undefined;

export interface MemoryScope {
  kind?: MemoryKind | MemoryKind[];
  /** Workspace(s) — the tier above project. */
  workspace?: ScopeValue;
  /** Project(s) — the facet the dynamic MCP tools filter on. */
  project?: ScopeValue;
  /** Agent(s), against the `created_by` column. */
  createdBy?: ScopeValue;
}

export interface SearchMemoryInput extends MemoryScope {
  query?: string;
  /** Substring match within the JSON tags array. */
  tag?: string;
  limit?: number;
  /** Where the search came from — "mcp", "web". Recorded in the log. */
  source?: string;
}

/**
 * A scope value as the JSON array `scopeFilter` binds.
 *
 * `[]` means "do not filter on this", which is the default and what every
 * omitted facet becomes — so an unscoped search still sees the whole corpus.
 * Blank entries are dropped rather than matched: a chip row with nothing ticked
 * and a chip row ticked to "" must not mean different things.
 */
function scopeSet(value: ScopeValue, normalize: (v: string | undefined) => string): string {
  const list = (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((v) => normalize(v))
    .filter((v) => v !== "");
  // De-duplicated so a repeated chip cannot change the plan SQLite picks.
  return JSON.stringify([...new Set(list)]);
}

/**
 * The eight bound arguments for `scopeFilter` in sql.ts, in its exact order.
 *
 * Written once, here, because the order is a contract between two files and
 * eight positional placeholders are easy to transpose silently — a swapped pair
 * would filter projects by workspace name and return nothing, with no error.
 */
function scopeArgs(scope: MemoryScope): string[] {
  const kind = scopeSet(
    scope.kind as ScopeValue,
    (v) => (v ? normalizeKind(v as MemoryKind) : ""),
  );
  const workspace = scopeSet(scope.workspace, normalizeWorkspace);
  const project = scopeSet(scope.project, normalizeProject);
  const createdBy = scopeSet(scope.createdBy, normalizeCreatedBy);
  return [kind, kind, workspace, workspace, project, project, createdBy, createdBy];
}

/**
 * A scope value as one string, for the search log.
 *
 * The log has a single TEXT column per facet, and it is read by a human asking
 * "what was this search narrowed to" — so several ticked chips become
 * "a, b" rather than being truncated to the first or dropped entirely.
 */
function scopeLabel(value: ScopeValue): string {
  if (value === undefined) return "";
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(", ");
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
  workspace: string;
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
    // readKind, not normalizeKind — a stored row must never fail to load.
    kind: readKind(row.kind),
    tags: parseTags(row.tags),
    source: row.source,
    importance: Number(row.importance),
    workspace: row.workspace ?? "",
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
  const workspace = normalizeWorkspace(input.workspace);
  const project = normalizeProject(input.project);
  const url = normalizeUrl(input.url);
  const createdBy = normalizeCreatedBy(input.createdBy);
  const now = nowIso();
  const id = crypto.randomUUID();

  await db().execute({
    sql: MEMORIES.insert,
    args: [
      id, title, content, kind, JSON.stringify(tags), source, importance,
      workspace, project, url, createdBy, now, now,
    ],
  });

  return {
    id, title, content, kind, tags, source, importance,
    workspace, project, url, createdBy, createdAt: now, updatedAt: now,
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

/**
 * Every search records itself.
 *
 * The recording lives INSIDE the search functions, not at their call sites.
 * There are six ways to reach a search — recall_memories, each generated
 * project tool, every time-window tool, search_memories_between, the web API,
 * and hybrid recall — and a log wired up at call sites is one forgotten call
 * away from answering "what did I search for" with a confident, partial lie.
 *
 * Put it where the search actually happens and no caller can omit it.
 */
async function logged<T extends { id: string }>(
  run: () => Promise<T[]>,
  meta: {
    query?: string;
    mode: string;
    kind?: string;
    workspace?: string;
    project?: string;
    tag?: string;
    source?: string;
  },
): Promise<T[]> {
  const started = Date.now();
  const results = await run();

  // An empty query is a LISTING, not a search. The UI refetches the whole
  // archive on load and on every filter change, and recording those buries the
  // handful of entries anyone actually wants to read under a wall of
  // "(empty query) → 4 results". "What was I searching for" is the question;
  // scrolling a list is not an answer to it.
  if ((meta.query ?? "").trim()) {
    // Fire-and-forget. The caller already has its answer, and searchlog.ts
    // swallows every failure — observability must not cost the thing observed.
    void recordSearch({
      ...meta,
      resultIds: results.map((r) => r.id),
      durationMs: Date.now() - started,
      source: meta.source ?? "internal",
    });
  }
  return results;
}

export async function searchMemories(
  input: SearchMemoryInput = {},
): Promise<Memory[]> {
  return logged(() => searchMemoriesNoLog(input), {
    query: input.query,
    mode: "keyword",
    kind: scopeLabel(input.kind as ScopeValue),
    workspace: scopeLabel(input.workspace),
    project: scopeLabel(input.project),
    tag: input.tag,
    source: input.source,
  });
}

/**
 * The same search without recording, for composing internally.
 *
 * Hybrid recall runs a keyword AND a semantic pass for ONE user action; if both
 * logged themselves the log would double-count every hybrid search. The caller
 * that composes them logs once, as "hybrid".
 */
export async function searchMemoriesNoLog(
  input: SearchMemoryInput = {},
): Promise<Memory[]> {
  await ensureSchema();

  const query = (input.query ?? "").trim().slice(0, 240);

  // Take the indexed path when the query is long enough for trigram AND no tag
  // filter is involved — tag matching is a JSON-substring test the FTS table
  // cannot express, so those queries stay on the LIKE path below.
  if (query.length >= TRIGRAM_MIN && !input.tag) {
    try {
      const result = await db().execute({
        sql: MEMORIES.searchFts,
        args: [ftsPhrase(query), ...scopeArgs(input), clampLimit(input.limit)],
      });
      return rows<MemoryRow>(result).map(toMemory);
    } catch {
      // An FTS failure must never mean "no results" — a corrupt or missing
      // index degrades to the scan below rather than lying about the corpus.
    }
  }
  const pattern = `%${query.toLocaleLowerCase()}%`;
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
      ...scopeArgs(input),
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
  const workspace =
    input.workspace === undefined ? existing.workspace : normalizeWorkspace(input.workspace);
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
      workspace, project, url, createdBy, updatedAt, existing.id,
    ],
  });

  // createdAt is deliberately not touched: a revision is the same memory.
  return {
    ...existing,
    title, content, kind, tags, source, importance,
    workspace, project, url, createdBy, updatedAt,
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
export async function listProjects(
  limit = 20,
  workspace?: string,
): Promise<ProjectFacet[]> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.facets.projects,
    args: [
      normalizeWorkspace(workspace), normalizeWorkspace(workspace),
      clampLimit(limit, 20),
    ],
  });
  return rows<{ project: string; count: number; latest: string }>(result).map((row) => ({
    project: String(row.project),
    count: Number(row.count),
    latest: String(row.latest),
  }));
}

/**
 * Every tag in the corpus with its use count, busiest first — optionally only
 * the tags actually used inside one workspace.
 *
 * A tag vocabulary is only useful if it is the vocabulary of the thing you are
 * looking at; the whole corpus's tag list is noise to an agent working in one
 * workspace, which is what makes this the "combo with tags" half of the design.
 */
export async function listTags(
  limit = 50,
  workspace?: string,
): Promise<Array<{ tag: string; count: number }>> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.facets.allTags,
    args: [
      normalizeWorkspace(workspace), normalizeWorkspace(workspace),
      clampLimit(limit, 50),
    ],
  });
  return rows<{ tag: string; count: number }>(result).map((row) => ({
    tag: String(row.tag),
    count: Number(row.count),
  }));
}

export interface WorkspaceFacet {
  workspace: string;
  count: number;
  /** Distinct non-empty projects filed under it. */
  projects: number;
  /** Distinct non-empty `created_by` values that have written to it. */
  agents: number;
  latest: string;
}

/**
 * The workspaces, busiest first, plus how many memories name none.
 *
 * There is no workspaces table — this query IS the list. A workspace comes into
 * existence the moment an agent writes into it and disappears when its last
 * memory leaves, which is why creating one needs no endpoint and no ceremony.
 *
 * `unassigned` is returned alongside because the list itself excludes the unset
 * bucket, and a page that showed only these rows would quietly account for less
 * than the whole corpus.
 */
export async function listWorkspaces(
  limit = 50,
): Promise<{ workspaces: WorkspaceFacet[]; unassigned: number }> {
  await ensureSchema();
  const conn = db();
  const [listed, none] = await Promise.all([
    conn.execute({ sql: MEMORIES.facets.workspaces, args: [clampLimit(limit, 50)] }),
    conn.execute(MEMORIES.facets.unassigned),
  ]);
  return {
    workspaces: rows<{
      workspace: string; count: number; projects: number; agents: number; latest: string;
    }>(listed).map((row) => ({
      workspace: String(row.workspace),
      count: Number(row.count),
      projects: Number(row.projects),
      agents: Number(row.agents),
      latest: String(row.latest),
    })),
    unassigned: Number(firstRow<{ count: number }>(none)?.count ?? 0),
  };
}

/**
 * Every chip row, in one round trip.
 *
 * The archive draws four rows of chips — kind, workspace, project, agent — plus
 * tags, and fetching each separately meant five requests to render one bar and
 * five chances for the rows to disagree about the corpus.
 *
 * Counts are corpus-wide and deliberately NOT recomputed against the current
 * filter. Chips that shrink and vanish as you tick them make the bar jump under
 * the cursor and hide the option you need to untick; a stable row you can read
 * once is worth more than counts that track the selection.
 */
export async function listFacets(): Promise<{
  kinds: Array<{ kind: string; count: number }>;
  workspaces: WorkspaceFacet[];
  unassigned: number;
  projects: ProjectFacet[];
  agents: AgentFacet[];
  tags: Array<{ tag: string; count: number }>;
  total: number;
}> {
  await ensureSchema();
  const conn = db();
  const [kinds, ws, none, projects, agents, tags, summary] = await Promise.all([
    conn.execute(MEMORIES.stats.byKind),
    conn.execute({ sql: MEMORIES.facets.workspaces, args: [50] }),
    conn.execute(MEMORIES.facets.unassigned),
    conn.execute({ sql: MEMORIES.facets.allProjects, args: [50] }),
    conn.execute({ sql: MEMORIES.facets.agents, args: ["", "", 50] }),
    conn.execute({ sql: MEMORIES.facets.allTags, args: ["", "", 50] }),
    conn.execute(MEMORIES.stats.summary),
  ]);

  return {
    kinds: rows<{ kind: string; count: number }>(kinds).map((r) => ({
      kind: String(r.kind),
      count: Number(r.count),
    })),
    workspaces: rows<{
      workspace: string; count: number; projects: number; agents: number; latest: string;
    }>(ws).map((r) => ({
      workspace: String(r.workspace),
      count: Number(r.count),
      projects: Number(r.projects),
      agents: Number(r.agents),
      latest: String(r.latest),
    })),
    unassigned: Number(firstRow<{ count: number }>(none)?.count ?? 0),
    projects: rows<{ project: string; count: number; latest: string }>(projects).map((r) => ({
      project: String(r.project),
      count: Number(r.count),
      latest: String(r.latest),
    })),
    agents: rows<{ agent: string; count: number; latest: string }>(agents).map((r) => ({
      agent: String(r.agent),
      count: Number(r.count),
      latest: String(r.latest),
    })),
    tags: rows<{ tag: string; count: number }>(tags).map((r) => ({
      tag: String(r.tag),
      count: Number(r.count),
    })),
    total: Number(firstRow<{ total: number }>(summary)?.total ?? 0),
  };
}

/** The facets a value can be merged within. */
export type Facet = "kind" | "workspace" | "project" | "agent" | "tag";

/**
 * Rename one facet value to another, everywhere.
 *
 * The repair for an open vocabulary. Nothing is deleted: every memory keeps its
 * place and simply files under a different word, so this is reversible by
 * merging back — which matters, because "merge retros into retro" is a judgement
 * and judgements get revised.
 *
 * Returns how many rows changed, so a caller can tell "merged 14" from a typo
 * that matched nothing.
 */
export async function mergeFacet(
  facet: Facet,
  from: string,
  to: string,
): Promise<{ facet: Facet; from: string; to: string; merged: number }> {
  await ensureSchema();

  const normalize =
    facet === "kind" ? normalizeKind
    : facet === "workspace" ? normalizeWorkspace
    : facet === "project" ? normalizeProject
    : facet === "agent" ? normalizeCreatedBy
    : (v: string | undefined) => (v ?? "").trim();

  const source = normalize(from);
  const target = normalize(to);
  if (!source) throw new Error("from is required");
  if (!target) throw new Error("to is required");
  if (source === target) throw new Error("from and to are the same value");

  const sql =
    facet === "kind" ? MEMORIES.mergeKind
    : facet === "workspace" ? MEMORIES.mergeWorkspace
    : facet === "project" ? MEMORIES.mergeProject
    : facet === "agent" ? MEMORIES.mergeAgent
    : MEMORIES.mergeTag;

  // Tag merge rewrites inside a JSON array and needs the matched value three
  // times in a different order — see the statement in sql.ts.
  const args = facet === "tag" ? [source, target, source] : [target, source];

  const result = await db().execute({ sql, args });
  return { facet, from: source, to: target, merged: Number(result.rowsAffected ?? 0) };
}

/** Distinct kinds with counts. Free text now, so this IS the vocabulary. */
export async function listKinds(): Promise<Array<{ kind: string; count: number }>> {
  await ensureSchema();
  return rows<{ kind: string; count: number }>(await db().execute(MEMORIES.kinds)).map((r) => ({
    kind: String(r.kind),
    count: Number(r.count),
  }));
}

export interface AgentFacet {
  agent: string;
  count: number;
  latest: string;
}

/**
 * Who has written to the corpus, busiest first, optionally within one
 * workspace.
 *
 * `created_by` has been a stored column since the first release and was
 * filterable by nothing at all — so "two agents share this corpus and I cannot
 * tell who wrote what" was true even though the answer was on every row. This
 * is the facet that fixes it.
 */
export async function listAgents(
  limit = 50,
  workspace?: string,
): Promise<AgentFacet[]> {
  await ensureSchema();
  const result = await db().execute({
    sql: MEMORIES.facets.agents,
    args: [
      normalizeWorkspace(workspace), normalizeWorkspace(workspace),
      clampLimit(limit, 50),
    ],
  });
  return rows<{ agent: string; count: number; latest: string }>(result).map((row) => ({
    agent: String(row.agent),
    count: Number(row.count),
    latest: String(row.latest),
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
export async function searchInRange(
  input: MemoryScope & {
    fromIso: string;
    toIso: string;
    query?: string;
    limit?: number;
    /** What window this was, for the log — e.g. "the last 3 weeks". */
    label?: string;
    source?: string;
  },
): Promise<Memory[]> {
  return logged(() => searchInRangeUnlogged(input), {
    query: input.query,
    mode: input.label ? `window:${input.label}` : "range",
    kind: scopeLabel(input.kind as ScopeValue),
    workspace: scopeLabel(input.workspace),
    project: scopeLabel(input.project),
    source: input.source,
  });
}

async function searchInRangeUnlogged(
  input: MemoryScope & {
    fromIso: string;
    toIso: string;
    query?: string;
    limit?: number;
  },
): Promise<Memory[]> {
  await ensureSchema();
  const query = (input.query ?? "").trim().slice(0, 240);
  const pattern = `%${query.toLocaleLowerCase()}%`;
  const result = await db().execute({
    sql: MEMORIES.inRange,
    args: [
      input.fromIso, input.toIso,
      query, pattern, pattern, pattern,
      ...scopeArgs(input),
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
export async function searchSemantic(
  input: MemoryScope & { query: string; limit?: number; source?: string },
): Promise<SemanticResult> {
  const started = Date.now();
  const result = await searchSemanticNoLog(input);
  if (input.query.trim()) void recordSearch({
    query: input.query,
    mode: "semantic",
    kind: scopeLabel(input.kind as ScopeValue),
    workspace: scopeLabel(input.workspace),
    project: scopeLabel(input.project),
    resultIds: result.memories.map((m) => m.id),
    durationMs: Date.now() - started,
    source: input.source ?? "internal",
  });
  return result;
}

export async function searchSemanticNoLog(
  input: MemoryScope & { query: string; limit?: number },
): Promise<SemanticResult> {
  await ensureSchema();
  const p = embeddings();
  if (!p) throw new Error("embeddings are not configured");

  const [vector] = await p.embed([input.query]);
  if (!vector) throw new Error("query produced no embedding");

  const literal = toVectorLiteral(vector);

  const result = await db().execute({
    sql: VECTORS.search,
    args: [literal, ...scopeArgs(input), literal, clampLimit(input.limit)],
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
