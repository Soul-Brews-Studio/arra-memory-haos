import { db, ensureSchema, firstRow, rows } from "./db";
import { SEARCH_LOG } from "./sql";
import { nowIso } from "./utils";

/**
 * A record of what was searched for, and what came back.
 *
 * This stores query text. That is a deliberate choice with a real cost: a
 * search log is often more revealing than the corpus it searches, because what
 * someone looked for says more than what they wrote down. It exists because
 * "what was I searching for last week" is a question worth answering, and it is
 * switchable off for exactly the same reason — see `search_log` in config.yaml.
 *
 * Result IDs are stored, result CONTENT is not. The memories live in the table
 * next door; copying their text here would double the blast radius of a leak
 * and add nothing you could not get by reading them back.
 *
 * Recording never blocks or fails a search. A log that can break the thing it
 * observes is worse than no log.
 */

export interface SearchLogEntry {
  id: string;
  query: string;
  mode: string;
  kind: string;
  project: string;
  tag: string;
  resultCount: number;
  resultIds: string[];
  durationMs: number;
  source: string;
  createdAt: string;
}

interface SearchLogRow {
  id: string;
  query: string;
  mode: string;
  kind: string;
  project: string;
  tag: string;
  result_count: number;
  result_ids: string;
  duration_ms: number;
  source: string;
  created_at: string;
}

function toEntry(row: SearchLogRow): SearchLogEntry {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.result_ids);
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    ids = [];
  }
  return {
    id: row.id,
    query: row.query,
    mode: row.mode,
    kind: row.kind ?? "",
    project: row.project ?? "",
    tag: row.tag ?? "",
    resultCount: Number(row.result_count),
    resultIds: ids,
    durationMs: Number(row.duration_ms),
    source: row.source ?? "",
    createdAt: row.created_at,
  };
}

/** Off unless explicitly enabled — logging queries is opt-in, not a default. */
export function searchLogEnabled(): boolean {
  return (process.env.SEARCH_LOG ?? "").trim().toLowerCase() === "true";
}

/**
 * Records one search. Never throws — a failure here is swallowed on purpose,
 * because the caller has already produced results the user is waiting for.
 */
export async function recordSearch(entry: {
  query?: string;
  mode?: string;
  kind?: string;
  project?: string;
  tag?: string;
  resultIds: string[];
  durationMs: number;
  source?: string;
}): Promise<void> {
  if (!searchLogEnabled()) return;
  try {
    await ensureSchema();
    await db().execute({
      sql: SEARCH_LOG.record,
      args: [
        crypto.randomUUID(),
        (entry.query ?? "").slice(0, 240),
        entry.mode ?? "keyword",
        entry.kind ?? "",
        entry.project ?? "",
        entry.tag ?? "",
        entry.resultIds.length,
        JSON.stringify(entry.resultIds.slice(0, 50)),
        Math.round(entry.durationMs),
        entry.source ?? "",
        nowIso(),
      ],
    });
  } catch {
    // Observability must never cost the thing it observes.
  }
}

export async function listSearchLog(limit = 50, query?: string): Promise<SearchLogEntry[]> {
  await ensureSchema();
  const needle = (query ?? "").trim().toLocaleLowerCase();
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  const result = needle
    ? await db().execute({ sql: SEARCH_LOG.find, args: [`%${needle}%`, capped] })
    : await db().execute({ sql: SEARCH_LOG.list, args: [capped] });
  return rows<SearchLogRow>(result).map(toEntry);
}

export async function deleteSearchLogEntry(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await db().execute({ sql: SEARCH_LOG.deleteOne, args: [id] });
  return Number(r.rowsAffected ?? 0) > 0;
}

/** Everything. The caller is responsible for having meant it. */
export async function clearSearchLog(): Promise<number> {
  await ensureSchema();
  const r = await db().execute(SEARCH_LOG.deleteAll);
  return Number(r.rowsAffected ?? 0);
}

/** Drops entries older than `days`. The default retention people expect. */
export async function pruneSearchLog(days = 30): Promise<{ removed: number; cutoff: string }> {
  await ensureSchema();
  const safeDays = Math.max(0, Math.trunc(days));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const r = await db().execute({ sql: SEARCH_LOG.deleteBefore, args: [cutoff] });
  return { removed: Number(r.rowsAffected ?? 0), cutoff };
}

export async function searchLogStats(): Promise<{
  enabled: boolean;
  total: number;
  oldest: string | null;
  newest: string | null;
}> {
  await ensureSchema();
  try {
    const r = firstRow<{ total: number; oldest: string | null; newest: string | null }>(
      await db().execute(SEARCH_LOG.stats),
    );
    return {
      enabled: searchLogEnabled(),
      total: Number(r?.total ?? 0),
      oldest: r?.oldest ?? null,
      newest: r?.newest ?? null,
    };
  } catch {
    return { enabled: searchLogEnabled(), total: 0, oldest: null, newest: null };
  }
}
