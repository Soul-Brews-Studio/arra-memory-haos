import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import { KindFilter, MemoryCard, useSlashFocus } from "./components";
import { SearchLog } from "./SearchLog";
import { Tools } from "./Tools";
import { NavBar } from "./Menu";
import { MEMORY_KINDS, type Health, type Memory, type MemoryKind, type MemoryStats } from "./types";

type Phase = "checking" | "locked" | "ready";

export default function App() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);

  const searchRef = useSlashFocus();

  // Public endpoint, so this runs before unlocking — the footer can state the
  // build and what is switched on even at the lock screen.
  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
  }, []);

  useEffect(() => {
    api.session
      .check()
      .then((r) => setPhase(r.authenticated ? "ready" : "locked"))
      .catch(() => setPhase("locked"));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [found, corpus] = await Promise.all([
        api.memories.search({ q: query, kind, limit: 100 }),
        api.stats(),
      ]);
      setMemories(found.memories);
      setStats(corpus.stats);
      setError(null);
    } catch (err) {
      // A 401 mid-session means the cookie lapsed or was revoked elsewhere.
      // That is a lock screen, not an error banner.
      if (err instanceof ApiError && err.status === 401) {
        setPhase("locked");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not load memories.");
    } finally {
      setLoading(false);
    }
  }, [query, kind]);

  // Debounced: the corpus is searched on every keystroke, and a local libSQL
  // file is fast enough that 180ms is about perception, not about load.
  useEffect(() => {
    if (phase !== "ready") return;
    const timer = setTimeout(load, query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [phase, load, query]);

  if (phase === "checking") return <Splash />;
  if (phase === "locked") return <Lock onOpen={() => setPhase("ready")} />;

  return (
    <div className="min-h-screen">
      <header className="lamp border-b border-line">
        <div className="mx-auto max-w-4xl px-5 pb-5 pt-7">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow mb-1.5">Arra Memory</p>
              <h1 className="text-2xl font-semibold tracking-tight text-ink">
                The archive
              </h1>
            </div>

            <NavBar
              primary={{ label: "Remember", onSelect: () => setComposing(true) }}
              items={[
                {
                  label: "Tools",
                  title: "Which MCP tools this connector offers, and what to switch off",
                  onSelect: () => setShowTools(true),
                },
                ...(health?.features.searchLog
                  ? [{
                      label: "Search log",
                      title: "What has been looked for",
                      onSelect: () => setShowLog(true),
                    }]
                  : []),
                {
                  label: "Lock",
                  title: "End this session",
                  danger: true,
                  onSelect: () =>
                    void api.session.close().finally(() => {
                      setPhase("locked");
                      setMemories([]);
                    }),
                },
              ]}
            />
          </div>

          <label className="sr-only" htmlFor="search">
            Search memories
          </label>
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <input
              id="search"
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles, content, tags…"
              className="w-full rounded-lg border border-line bg-panel py-2.5 pl-10 pr-16 text-ink placeholder:text-faint focus:border-transparent"
            />
            <kbd className="meta pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 py-0.5">
              /
            </kbd>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <KindFilter value={kind} counts={stats?.kinds ?? {}} onChange={setKind} />
            <p className="meta">
              {loading
                ? "searching…"
                : `${memories.length} shown${
                    stats ? ` · ${stats.total} in corpus` : ""
                  }`}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-6">
        {error && (
          <p
            role="alert"
            className="mb-4 rounded-lg border border-[#5c2320] bg-[#2a1614] px-3 py-2 text-sm text-[#f0928f]"
          >
            {error}
          </p>
        )}

        {memories.length === 0 && !loading ? (
          <Empty query={query} kind={kind} onCompose={() => setComposing(true)} />
        ) : (
          <div className="flex flex-col gap-3">
            {memories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                query={query}
                onDelete={async (id) => {
                  // Optimistic: the row disappears immediately, and a failure
                  // puts it back rather than leaving the UI lying.
                  const previous = memories;
                  setMemories((list) => list.filter((m) => m.id !== id));
                  try {
                    await api.memories.remove(id);
                    void load();
                  } catch {
                    setMemories(previous);
                    setError("Could not forget that memory.");
                  }
                }}
              />
            ))}
          </div>
        )}
      </main>

      {showTools && <Tools onClose={() => setShowTools(false)} />}

      {showLog && <SearchLog onClose={() => setShowLog(false)} />}

      {composing && (
        <Compose
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function Splash() {
  return (
    <div className="grid min-h-screen place-items-center">
      <p className="eyebrow">opening the archive…</p>
    </div>
  );
}

function Lock({ onOpen }: { onOpen: () => void }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="lamp grid min-h-screen place-items-center px-5">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.session.open(passphrase);
            onOpen();
          } catch {
            setError("That passphrase does not match.");
          } finally {
            setBusy(false);
          }
        }}
        className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8"
      >
        <p className="eyebrow mb-4" style={{ color: "var(--color-ember)" }}>
          Arra Memory
        </p>
        <h1 className="mb-2 text-xl font-semibold tracking-tight">The archive is locked</h1>
        <p className="mb-6 text-sm text-dim">
          Enter the owner passphrase set in this add-on’s configuration.
        </p>

        <label htmlFor="passphrase" className="eyebrow mb-2 block">
          Owner passphrase
        </label>
        <input
          id="passphrase"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="w-full rounded-lg border border-line bg-ground px-3 py-2.5 text-ink"
        />

        {error && (
          <p role="alert" className="mt-3 text-sm text-[#f0928f]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-lg bg-ember py-2.5 font-semibold text-[#17130e] transition hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "Opening…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

function Empty({
  query,
  kind,
  onCompose,
}: {
  query: string;
  kind: MemoryKind | "";
  onCompose: () => void;
}) {
  const filtered = Boolean(query || kind);
  return (
    <div className="rounded-xl border border-dashed border-line py-16 text-center">
      <p className="mb-1.5 text-ink">
        {filtered ? "Nothing matches that." : "The archive is empty."}
      </p>
      <p className="mx-auto mb-5 max-w-sm text-sm text-dim">
        {filtered
          ? "Recall is literal keyword matching across titles, content and tags — try a word you know is in there."
          : "Memories written here or by Claude over MCP will appear in this list."}
      </p>
      {!filtered && (
        <button
          type="button"
          onClick={onCompose}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-dim transition hover:border-ember hover:text-ember"
        >
          Write the first one
        </button>
      )}
    </div>
  );
}

function Compose({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MemoryKind>("note");
  const [tags, setTags] = useState("");
  const [importance, setImportance] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes. A modal that traps you is a modal people resent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const parsedTags = useMemo(
    () => tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10),
    [tags],
  );

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Write a memory"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.memories.create({
              content,
              title: title.trim() || undefined,
              kind,
              tags: parsedTags,
              importance,
            });
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save.");
          } finally {
            setBusy(false);
          }
        }}
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-line bg-panel p-6"
      >
        <h2 className="mb-5 text-lg font-semibold tracking-tight">Write a memory</h2>

        <label htmlFor="content" className="eyebrow mb-2 block">
          Content
        </label>
        <textarea
          id="content"
          required
          autoFocus
          rows={7}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What is worth recalling later?"
          className="prose-memory w-full resize-y rounded-lg border border-line bg-ground px-3 py-2.5 placeholder:text-faint"
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="title" className="eyebrow mb-2 block">
              Title <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Inferred from the first line"
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
          </div>

          <div>
            <label htmlFor="kind" className="eyebrow mb-2 block">
              Kind
            </label>
            <select
              id="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as MemoryKind)}
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm text-ink"
            >
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="tags" className="eyebrow mb-2 block">
              Tags <span className="normal-case tracking-normal">(comma separated)</span>
            </label>
            <input
              id="tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="turso, haos"
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
          </div>

          <div>
            <label htmlFor="importance" className="eyebrow mb-2 block">
              Importance — {importance}
            </label>
            <input
              id="importance"
              type="range"
              min={1}
              max={5}
              value={importance}
              onChange={(e) => setImportance(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--color-ember)]"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-4 text-sm text-[#f0928f]">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line px-3 py-2 text-sm text-dim transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !content.trim()}
            className="rounded-lg bg-ember px-4 py-2 text-sm font-semibold text-[#17130e] transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Remember"}
          </button>
        </div>
      </form>
    </div>
  );
}
