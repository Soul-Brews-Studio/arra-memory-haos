import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import { KindFilter, MemoryCard, useSlashFocus } from "./components";
import { SearchLog } from "./SearchLog";
import { Tools } from "./Tools";
import { Workspaces } from "./Workspaces";
import { ScopeBar } from "./ScopeBar";
import { NavBar, Panel } from "./Menu";
import { EMPTY_ROUTE, useRoute, type View } from "./route";
import {
  MEMORY_KINDS,
  type AgentFacet,
  type Health,
  type Memory,
  type MemoryKind,
  type MemoryStats,
  type WorkspaceFacet,
} from "./types";

/**
 * The archive's scope: which workspace, project, and agent are being shown.
 *
 * Empty in every slot means the whole corpus, which is the default and stays
 * the default — workspace and agent are filters here exactly as they are over
 * MCP, so nothing is ever hidden by not having chosen one.
 */
export interface Scope {
  workspace: string;
  project: string;
  createdBy: string;
}

const NO_SCOPE: Scope = { workspace: "", project: "", createdBy: "" };

type Phase = "checking" | "locked" | "ready";

export default function App() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  // The address bar is the source of truth for what is on screen: which view,
  // what was searched, and what it was scoped to. Reloading, sharing a link and
  // the back button all work because there is nowhere else for that state to
  // hide.
  const [route, navigate] = useRoute();
  const { view, query, kind } = route;
  const scope: Scope = {
    workspace: route.workspace,
    project: route.project,
    createdBy: route.createdBy,
  };
  const setView = (next: View) => navigate({ ...route, view: next });
  const setQuery = (next: string) => navigate({ ...route, query: next });
  const setKind = (next: MemoryKind | "") => navigate({ ...route, kind: next });
  const setScope = (next: Scope) => navigate({ ...route, ...next });
  // The vocabulary the filter bar offers, fetched once and refreshed on write.
  const [facets, setFacets] = useState<{ workspaces: WorkspaceFacet[]; agents: AgentFacet[] }>({
    workspaces: [],
    agents: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
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
      const [found, corpus, divisions] = await Promise.all([
        api.memories.search({ q: query, kind, ...scope, limit: 100 }),
        api.stats(),
        // Loaded with the list so the filter bar always offers exactly the
        // workspaces and agents that currently exist — a dropdown listing a
        // workspace whose last memory was just deleted would filter to nothing.
        api.workspaces.list(),
      ]);
      setMemories(found.memories);
      setStats(corpus.stats);
      setFacets({ workspaces: divisions.workspaces, agents: divisions.agents });
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
  }, [query, kind, scope.workspace, scope.project, scope.createdBy]);

  // Debounced: the corpus is searched on every keystroke, and a local libSQL
  // file is fast enough that 180ms is about perception, not about load.
  useEffect(() => {
    if (phase !== "ready") return;
    const timer = setTimeout(load, query ? 180 : 0);
    return () => clearTimeout(timer);
  }, [phase, load, query]);

  if (phase === "checking") return <Splash />;
  if (phase === "locked") return <Lock onOpen={() => setPhase("ready")} />;

  // One nav, built once, rendered by one component in one position on every
  // page — including the primary action. Dropping "Remember" on the other pages
  // made the bar change width and the buttons shift under the cursor between
  // views, which reads as a different menu rather than the same one. Writing a
  // memory is what this app is for; it is not an archive-only errand.
  const nav = (
    <NavBar
      primary={{ label: "Remember", onSelect: () => setComposing(true) }}
      items={[
        { label: "Archive", active: view === "archive", onSelect: () => setView("archive") },
        {
          label: "Workspaces",
          title: "How the corpus is divided, and who writes to each part",
          active: view === "workspaces",
          onSelect: () => setView("workspaces"),
        },
        {
          label: "Tools",
          title: "Which MCP tools this connector offers, and what to switch off",
          active: view === "tools",
          onSelect: () => setView("tools"),
        },
        ...(health?.features.searchLog
          ? [{
              label: "Search log",
              title: "What has been looked for",
              active: view === "log",
              onSelect: () => setView("log"),
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
  );

  // Every view is a <Panel> with the same header, the same nav, in the same
  // place. The archive used to build its own header, which is how its menu
  // drifted from the rest.
  const body =
    view === "workspaces" ? (
      <Workspaces
        onClose={() => setView("archive")}
        nav={nav}
        // Picking a workspace, project, or agent here IS the navigation: it
        // scopes the archive and takes you there, rather than showing a second
        // list of memories that would then have to stay in step with the real one.
        onFilter={(next) => {
          navigate({ ...EMPTY_ROUTE, view: "archive", ...next });
        }}
      />
    ) : view === "tools" ? (
      <Tools onClose={() => setView("archive")} nav={nav} />
    ) : view === "log" ? (
      <SearchLog
        onClose={() => setView("archive")}
        nav={nav}
        // Replaying puts you in the archive with the logged query AND its scope
        // restored, which runs a real search through the same path everything
        // else uses — so it is recorded, and the log grows an entry for the
        // replay. That is correct: it genuinely was a search.
        onReplay={(entry) => {
          // One navigate, not four setters: each would be a separate route
          // write, and the first three would be clobbered by the last since
          // they all derive `next` from the same stale route.
          navigate({
            view: "archive",
            query: entry.query,
            kind: (entry.kind as MemoryKind) || "",
            workspace: entry.workspace,
            project: entry.project,
            createdBy: "",
          });
        }}
      />
    ) : (
      <Archive
        nav={nav}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        kind={kind}
        onKind={setKind}
        scope={scope}
        onScope={setScope}
        facets={facets}
        stats={stats}
        memories={memories}
        loading={loading}
        error={error}
        onCompose={() => setComposing(true)}
        onForget={async (id) => {
          // Optimistic: the row disappears immediately, and a failure puts it
          // back rather than leaving the UI lying.
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
    );

  return (
    <div className="min-h-screen">
      {body}

      {/* Outside the view switch, so Remember works from every page rather than
          silently doing nothing on three of them. */}
      {composing && (
        <Compose
          // Pre-filled from what you are currently looking at. Writing a memory
          // while scoped to a workspace and having it land outside that workspace
          // is the mistake this prevents; both fields stay editable.
          scope={scope}
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            void load();
          }}
        />
      )}

      <Footer health={health} />
    </div>
  );
}

/**
 * The archive — the same <Panel> the other three views use.
 *
 * It used to hand-roll its own header. That is how its menu drifted: the same
 * NavBar sat inside different markup, so the bar moved and changed width when
 * you navigated. The search box, scope bar and kind filter go through Panel's
 * `actions` slot, which is exactly what that slot is for.
 */
function Archive({
  nav,
  query,
  onQuery,
  searchRef,
  kind,
  onKind,
  scope,
  onScope,
  facets,
  stats,
  memories,
  loading,
  error,
  onCompose,
  onForget,
}: {
  nav: React.ReactNode;
  query: string;
  onQuery: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  kind: MemoryKind | "";
  onKind: (kind: MemoryKind | "") => void;
  scope: Scope;
  onScope: (scope: Scope) => void;
  facets: { workspaces: WorkspaceFacet[]; agents: AgentFacet[] };
  stats: MemoryStats | null;
  memories: Memory[];
  loading: boolean;
  error: string | null;
  onCompose: () => void;
  onForget: (id: string) => void;
}) {
  return (
    <Panel
      eyebrow="Arra Memory"
      title="The archive"
      nav={nav}
      // Archive is the home view, so there is nowhere to close to — Escape and
      // the nav's own Archive button both already land here.
      onClose={() => {}}
      actions={
        <>
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
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search titles, content, tags…"
              className="w-full rounded-lg border border-line bg-panel py-2.5 pl-10 pr-16 text-ink placeholder:text-faint focus:border-transparent"
            />
            <kbd className="meta pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 py-0.5">
              /
            </kbd>
          </div>

          <ScopeBar
            scope={scope}
            workspaces={facets.workspaces}
            agents={facets.agents}
            onChange={onScope}
            onClear={() => onScope({ workspace: "", project: "", createdBy: "" })}
          />

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <KindFilter value={kind} counts={stats?.kinds ?? {}} onChange={onKind} />
            <p className="meta">
              {loading
                ? "searching…"
                : `${memories.length} shown${stats ? ` · ${stats.total} in corpus` : ""}`}
            </p>
          </div>
        </>
      }
    >
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-[#5c2320] bg-[#2a1614] px-3 py-2 text-sm text-[#f0928f]"
        >
          {error}
        </p>
      )}

      {memories.length === 0 && !loading ? (
        <Empty
          query={query}
          kind={kind}
          scope={scope}
          onClearScope={() => onScope({ workspace: "", project: "", createdBy: "" })}
          onCompose={onCompose}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} query={query} onDelete={onForget} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function Footer({ health }: { health: Health | null }) {
  if (!health) return null;
  return (
    <footer className="mx-auto max-w-4xl px-5 pb-8">
      <p className="meta border-t border-line pt-3">
        Arra Memory v{health.version}
        {health.features.semantic && ` · semantic (${health.features.embeddingModel})`}
        {health.features.replica && " · replicated"}
        {health.features.searchLog && " · logging searches"}
      </p>
    </footer>
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
  scope,
  onClearScope,
  onCompose,
}: {
  query: string;
  kind: MemoryKind | "";
  scope: Scope;
  onClearScope: () => void;
  onCompose: () => void;
}) {
  const scoped = Boolean(scope.workspace || scope.project || scope.createdBy);
  const filtered = Boolean(query || kind) || scoped;
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
      {/* An empty scoped view is ambiguous — "the corpus has nothing" and "this
          workspace has nothing" look identical — so say which one, and offer the
          way out. Without this a filter left on reads as an empty archive. */}
      {scoped && (
        <button
          type="button"
          onClick={onClearScope}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-dim transition hover:border-ember hover:text-ember"
        >
          Search the whole corpus instead
        </button>
      )}
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

function Compose({
  scope,
  onClose,
  onSaved,
}: {
  scope: Scope;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<MemoryKind>("note");
  const [tags, setTags] = useState("");
  const [workspace, setWorkspace] = useState(scope.workspace);
  const [project, setProject] = useState(scope.project);
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
              workspace: workspace.trim() || undefined,
              project: project.trim() || undefined,
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
            <label htmlFor="workspace" className="eyebrow mb-2 block">
              Workspace <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="workspace"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="arra-memory-haos"
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
          </div>

          <div>
            <label htmlFor="project" className="eyebrow mb-2 block">
              Project <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="oauth"
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
