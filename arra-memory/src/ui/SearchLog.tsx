import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { timeAgo } from "./components";
import { Panel } from "./Menu";
import type { SearchLogEntry, SearchLogStats } from "./types";

/**
 * The search log.
 *
 * It shows the query text, because that is what makes the log worth having and
 * also what makes it worth deleting — so every destructive control is one click
 * away and says exactly how much it will remove before it does. Nothing here
 * deletes on a single stray click.
 */
export function SearchLog({ onClose, nav }: { onClose: () => void; nav?: React.ReactNode }) {
  const [entries, setEntries] = useState<SearchLogEntry[]>([]);
  const [stats, setStats] = useState<SearchLogStats | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"all" | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.searchLog.list({ limit: 200, q: filter || undefined });
      setEntries(r.entries);
      setStats(r.stats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the search log.");
    } finally {
      setBusy(false);
    }
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(load, filter ? 180 : 0);
    return () => clearTimeout(t);
  }, [load, filter]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setConfirming(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
      setBusy(false);
    }
  };

  return (
    <Panel
      eyebrow="Search log"
      title="What was looked for"
      subtitle={
        stats && !stats.enabled
          ? "Recording is off. Turn on search_log in this add-on's configuration to start keeping a record."
          : undefined
      }
      onClose={onClose}
      nav={nav}
      actions={
        stats?.enabled ? (
          <>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by what was searched…"
              aria-label="Filter the search log"
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
            <div className="meta mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span>
                {busy ? "loading…" : `${entries.length} shown`}
                {stats ? ` · ${stats.total} recorded` : ""}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                disabled={busy || !entries.length}
                onClick={() => act(() => api.searchLog.prune(30))}
                className="rounded border border-line px-2 py-1 transition-colors hover:border-ember hover:text-ember disabled:opacity-40"
              >
                prune &gt; 30 days
              </button>
              {confirming === "all" ? (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => act(() => api.searchLog.clear())}
                    className="rounded bg-[#5c2320] px-2 py-1 text-[#f0928f]"
                  >
                    delete all {stats?.total ?? ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded px-2 py-1 text-dim hover:text-ink"
                  >
                    keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy || !entries.length}
                  onClick={() => setConfirming("all")}
                  className="rounded border border-line px-2 py-1 transition-colors hover:border-[#f0928f] hover:text-[#f0928f] disabled:opacity-40"
                >
                  clear all
                </button>
              )}
            </div>
          </>
        ) : undefined
      }
    >
      <>

          {error && (
            <p role="alert" className="mb-3 rounded-lg border border-[#5c2320] bg-[#2a1614] px-3 py-2 text-sm text-[#f0928f]">
              {error}
            </p>
          )}

          {entries.length === 0 && !busy ? (
            <p className="py-14 text-center text-sm text-dim">
              {filter ? "No searches match that." : "Nothing recorded yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entries.map((e) => (
                <li
                  key={e.id}
                  className="group flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 transition-colors hover:border-line-bright"
                >
                  <div className="min-w-0 flex-1">
                    <p className="prose-memory !text-[0.95rem] truncate">
                      {e.query || <span className="text-faint">(empty query)</span>}
                    </p>
                    <div className="meta mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span title={e.createdAt}>{timeAgo(e.createdAt)}</span>
                      <span aria-hidden="true">·</span>
                      {/* A zero-result search is the interesting kind — it is
                          where the corpus disagreed with what you expected. */}
                      <span style={{ color: e.resultCount ? undefined : "var(--color-ember)" }}>
                        {e.resultCount} result{e.resultCount === 1 ? "" : "s"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{e.durationMs}ms</span>
                      {e.source && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{e.source}</span>
                        </>
                      )}
                      {e.kind && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{e.kind}</span>
                        </>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => act(() => api.searchLog.remove(e.id))}
                    aria-label={`Forget the search for “${e.query}”`}
                    className="shrink-0 rounded p-1.5 text-faint opacity-0 transition-opacity hover:text-[#f0928f] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
      </>
    </Panel>
  );
}
