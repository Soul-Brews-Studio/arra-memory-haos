import { db, ensureSchema, rows } from "./db";
import { MEMORIES, VECTORS } from "./sql";
import type { MemoryScope } from "./memory";
import { normalizeKind } from "./utils";

/**
 * The corpus as geometry.
 *
 * Two shapes, because they answer different questions and the research on this
 * is blunt about which one survives scale:
 *
 *   MAP — every memory is a point, positioned by projecting its embedding down
 *         to three dimensions. No edges at all. Proximity IS similarity. This is
 *         what Nomic Atlas does, and it scales precisely BECAUSE it drops the
 *         edge-drawing problem.
 *
 *   WEB — a node-link graph with edges between near neighbours. Legible at small
 *         N, a hairball past a few hundred: Obsidian's graph is unreadable past
 *         ~200 notes and Roam's layout gives up around 600. No layout algorithm
 *         fixes this; every credible tool answers it with filtering and focus.
 *
 * Both are offered because the web is genuinely more striking at the scale a
 * personal corpus actually lives at, and because a tool that refuses to draw the
 * thing you asked for is not more honest, only less useful. The node counts are
 * returned so the UI can say which regime it is in.
 *
 * Everything here runs on the embeddings that already exist for semantic search.
 * There is no second index and no new dependency.
 */

export interface GraphNode {
  id: string;
  title: string;
  kind: string;
  workspace: string;
  project: string;
  createdBy: string;
  importance: number;
  createdAt: string;
  /** Position in the projection, each axis normalised to roughly [-1, 1]. */
  x: number;
  y: number;
  z: number;
}

/**
 * Why an edge exists. The three are not interchangeable and must not be drawn
 * the same way.
 *
 *   link     someone WROTE it — a [[reference]] in the text. The only kind of
 *            edge that carries intent rather than statistics.
 *   similar  mutual k-nearest-neighbours over the embeddings. Inferred.
 *   bridge   exists only so the graph stays connected. Carries almost nothing
 *            and is drawn faintest, because a spanning-tree edge implies a
 *            closeness it does not have.
 */
export type EdgeKind = "link" | "similar" | "bridge";

export interface GraphEdge {
  /** Indices into `nodes`, not ids — the renderer wants offsets. */
  source: number;
  target: number;
  /** Cosine distance. 0 identical, 1 orthogonal. Meaningless for a link. */
  distance: number;
  kind: EdgeKind;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** How many memories carry no vector and are therefore absent. */
  unembedded: number;
  /** Fraction of variance the three axes actually capture, 0–1. */
  explained: number;
  /** The k used for the neighbour graph, chosen from N. */
  k: number;
  /** Edges that came from a written [[reference]] rather than from similarity. */
  links: number;
  /**
   * Edges as a fraction of all possible pairs, 0–1.
   *
   * The honest signal for whether a node-link view is worth drawing. Near 1 the
   * graph is complete and every layout is a hairball regardless of algorithm;
   * the map view carries the same information without the occlusion.
   */
  density: number;
  /** Cosine distance stats across all pairs — the honest scale for a threshold. */
  distance: { min: number; max: number; median: number } | null;
}

interface VectorRow {
  id: string;
  title: string;
  content: string;
  kind: string;
  workspace: string;
  project: string;
  created_by: string;
  importance: number;
  created_at: string;
  embedding: unknown;
}

/**
 * bge-m3 output is L2-normalised, so a dot product IS cosine similarity and
 * cosine distance is `1 - dot`. Worth stating because it means none of the
 * maths below needs a normalisation step, and adding one would be a silent
 * no-op that looks like diligence.
 */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Principal components by power iteration, deflating between components.
 *
 * PCA rather than UMAP or t-SNE, deliberately. UMAP gives better-separated
 * clusters, but it is a substantial dependency, it is stochastic — the same
 * corpus lays out differently on every load unless a seed is threaded all the
 * way through — and at the scale a personal archive lives at, its advantage is
 * mostly invisible. PCA is forty lines, deterministic, and reports how much
 * variance it actually captured so the UI can admit when the projection is
 * lossy rather than presenting a flat cloud as structure.
 *
 * The `explained` figure matters: three axes out of 1024 usually capture a
 * modest fraction, and a viewer is entitled to know that two points sitting
 * together might be far apart in the space this is a shadow of.
 */
function project(vectors: Float32Array[], dims = 3): { coords: number[][]; explained: number } {
  const n = vectors.length;
  const d = vectors[0]!.length;

  // Centre. PCA on uncentred data finds the mean direction as its first
  // component, which is the same for every corpus and tells you nothing.
  const mean = new Float32Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) mean[i]! += v[i]! / n;
  const centred = vectors.map((v) => {
    const out = new Float32Array(d);
    for (let i = 0; i < d; i++) out[i] = v[i]! - mean[i]!;
    return out;
  });

  let totalVariance = 0;
  for (const v of centred) totalVariance += dot(v, v);

  const components: Float32Array[] = [];
  const captured: number[] = [];
  // A fixed seed, not randomness: the same corpus must lay out the same way
  // twice, or every reload looks like the data changed.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };

  for (let c = 0; c < dims; c++) {
    let vec = new Float32Array(d);
    for (let i = 0; i < d; i++) vec[i] = rand();

    for (let iter = 0; iter < 64; iter++) {
      const next = new Float32Array(d);
      // next = Xᵀ(X·vec), the covariance product without ever forming the
      // 1024×1024 covariance matrix — which would be 4MB per call for nothing.
      for (const row of centred) {
        const s = dot(row, vec);
        for (let i = 0; i < d; i++) next[i]! += s * row[i]!;
      }
      // Deflate against components already found, so each axis is orthogonal
      // to the last rather than converging on the same dominant direction.
      for (const prev of components) {
        const s = dot(next, prev);
        for (let i = 0; i < d; i++) next[i]! -= s * prev[i]!;
      }
      let norm = Math.sqrt(dot(next, next));
      if (norm < 1e-9) break;
      for (let i = 0; i < d; i++) next[i]! /= norm;
      vec = next;
    }

    components.push(vec);
    let variance = 0;
    for (const row of centred) variance += dot(row, vec) ** 2;
    captured.push(variance);
  }

  const coords = centred.map((row) => components.map((comp) => dot(row, comp)));

  // Normalise each axis independently to [-1, 1]. Independently, because the
  // second and third components are usually much smaller than the first, and a
  // shared scale would flatten the cloud into a line that looks like a finding.
  for (let axis = 0; axis < dims; axis++) {
    const values = coords.map((c) => c[axis]!);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    for (const c of coords) c[axis] = ((c[axis]! - lo) / span) * 2 - 1;
  }

  const explained = totalVariance > 0
    ? captured.reduce((a, b) => a + b, 0) / totalVariance
    : 0;
  return { coords, explained };
}

/**
 * Edges: mutual k-nearest-neighbours, unioned with a maximum spanning tree.
 *
 * Not a fixed cosine threshold. In high dimensions similarities concentrate —
 * measured on this corpus, every pair sat between 0.30 and 0.79 similarity, so
 * one global cutoff takes everything or nothing. bge-m3 makes it worse: its own
 * documentation shows an UNRELATED pair scoring ≈0.35, not ≈0, so a threshold
 * anchored at zero misclassifies unrelated text as related.
 *
 * Mutual kNN — keep an edge only if each point is in the other's top k — caps
 * degree and suppresses hubs, the points that are nobody's neighbour but
 * everybody's nearest. It also strips enough edges to disconnect the graph,
 * which is why it is unioned with a spanning tree: the MST edges are marked
 * `bridge` so the renderer can draw them faintly and not imply a closeness they
 * do not carry.
 */
function neighbourEdges(sim: number[][], k: number): GraphEdge[] {
  const n = sim.length;
  const topK: Set<number>[] = [];
  for (let i = 0; i < n; i++) {
    const order = [...Array(n).keys()]
      .filter((j) => j !== i)
      .sort((a, b) => sim[i]![b]! - sim[i]![a]!)
      .slice(0, k);
    topK.push(new Set(order));
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (const j of topK[i]!) {
      if (!topK[j]!.has(i)) continue; // mutual only
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: i, target: j, distance: 1 - sim[i]![j]!, kind: "similar" });
    }
  }

  // Union with a maximum spanning tree (Prim), so no memory is ever an island.
  // An isolated node reads as "unrelated to everything", when it usually means
  // "its nearest neighbour did not reciprocate".
  const inTree = new Array(n).fill(false);
  inTree[0] = true;
  for (let added = 1; added < n; added++) {
    let best = { i: -1, j: -1, s: -Infinity };
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        if (sim[i]![j]! > best.s) best = { i, j, s: sim[i]![j]! };
      }
    }
    if (best.j === -1) break;
    inTree[best.j] = true;
    const key = best.i < best.j ? `${best.i}:${best.j}` : `${best.j}:${best.i}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({ source: best.i, target: best.j, distance: 1 - best.s, kind: "bridge" });
    }
  }

  return edges;
}

/**
 * Edges someone actually wrote: `[[a reference]]` in a memory's text.
 *
 * The vault has used this notation for years — every learning in ψ/ links to its
 * neighbours that way — so the corpus already speaks it, and a memory imported
 * from a vault file arrives with its links intact and needs no conversion.
 *
 * Resolved against titles, case- and space-insensitively, and against an id
 * prefix of 8 characters or more so a link can survive a retitling. Derived on
 * read rather than stored: exactly like the workspace hierarchy, there is then
 * no second copy to fall out of step with the text, and editing a memory's body
 * updates its links with nothing else to remember.
 *
 * An unresolved link is simply dropped. A dangling reference is a normal state
 * for a corpus being written — it points at a memory not saved yet — and
 * rendering it as an edge to nowhere would be worse than rendering nothing.
 */
function linkEdges(
  nodes: Array<{ id: string; title: string }>,
  contents: string[],
): GraphEdge[] {
  const byTitle = new Map<string, number>();
  nodes.forEach((n, i) => {
    byTitle.set(n.title.trim().toLocaleLowerCase().replace(/\s+/g, " "), i);
  });

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  contents.forEach((text, from) => {
    for (const match of text.matchAll(/\[\[([^\]|]{1,160})(?:\|[^\]]*)?\]\]/g)) {
      const raw = match[1]!.trim();
      const needle = raw.toLocaleLowerCase().replace(/\s+/g, " ");
      let to = byTitle.get(needle);
      if (to === undefined && raw.length >= 8) {
        to = nodes.findIndex((n) => n.id.startsWith(raw));
        if (to === -1) to = undefined;
      }
      if (to === undefined || to === from) continue;
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: from, target: to, distance: 0, kind: "link" });
    }
  });

  return edges;
}

export async function buildGraph(scope: MemoryScope & { limit?: number }): Promise<Graph> {
  await ensureSchema();

  const limit = Math.max(1, Math.min(2000, scope.limit ?? 500));
  const result = await db().execute({ sql: MEMORIES.embedded, args: [limit] });
  const found = rows<VectorRow>(result);

  // Counted over the WHOLE corpus, not derived from the sample above. The
  // earlier `total - vectors.length` conflated two different absences: rows
  // with no vector, and rows the LIMIT simply did not reach. At 29k memories
  // with a limit of 500 that reported 28,611 "without a vector" while coverage
  // was in fact 100% — the number the UI states plainly, so it must be the
  // real one.
  const coverage = rows<{ total: number; embedded: number }>(
    await db().execute(VECTORS.coverage),
  )[0];
  const unembedded = Math.max(
    0,
    Number(coverage?.total ?? 0) - Number(coverage?.embedded ?? 0),
  );

  // Vectors arrive as a blob; libSQL hands back an ArrayBuffer or a typed array
  // depending on driver. Both are accepted rather than assuming one.
  const vectors: Float32Array[] = [];
  const nodes: Omit<GraphNode, "x" | "y" | "z">[] = [];
  // Kept only long enough to extract [[links]]; never returned to the client,
  // which needs positions and titles, not every memory's full body a second time.
  const contents: string[] = [];
  for (const row of found) {
    const raw = row.embedding as ArrayBuffer | Uint8Array | null;
    if (!raw) continue;
    const buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw;
    const vec = new Float32Array(buf);
    if (!vec.length) continue;
    vectors.push(vec);
    contents.push(String(row.content ?? ""));
    nodes.push({
      id: row.id,
      title: row.title,
      kind: normalizeKind(row.kind),
      workspace: row.workspace ?? "",
      project: row.project ?? "",
      createdBy: row.created_by ?? "",
      importance: Number(row.importance),
      createdAt: row.created_at,
    });
  }


  if (vectors.length < 2) {
    return {
      nodes: nodes.map((n) => ({ ...n, x: 0, y: 0, z: 0 })),
      edges: [],
      unembedded,
      explained: 0,
      k: 0,
      links: 0,
      density: 0,
      distance: null,
    };
  }

  const { coords, explained } = project(vectors);

  // All-pairs similarity. A self-join in SQL would work — verified — but the
  // vectors are already in memory for the projection, so computing it here
  // avoids a second full read of every embedding.
  const n = vectors.length;
  const sim: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const flat: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = dot(vectors[i]!, vectors[j]!);
      sim[i]![j] = s;
      sim[j]![i] = s;
      flat.push(1 - s);
    }
  }
  flat.sort((a, b) => a - b);

  // k = √N, clamped to [2, 12].
  //
  // Tools commonly default to a flat k of 10–15 regardless of corpus size, and
  // that is wrong at the small end: with N=6 a k of 5 makes every node every
  // other node's neighbour, mutual-kNN keeps all 15 pairs, and the "graph" is a
  // complete graph — which is the hairball, arrived at from the opposite
  // direction. √N degrades gracefully: 3 at N=6, 10 at N=100, capped at 12
  // beyond N≈150 where the flat default is right again.
  const k = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(n))));

  const written = linkEdges(nodes, contents);
  const inferred = neighbourEdges(sim, k);

  // A written link outranks an inferred one for the same pair: if someone said
  // these two are related, that is a stronger claim than cosine agreeing, and
  // drawing both would double the line.
  const claimed = new Set(
    written.map((e) => (e.source < e.target ? `${e.source}:${e.target}` : `${e.target}:${e.source}`)),
  );
  const edges = [
    ...written,
    ...inferred.filter((e) => {
      const key = e.source < e.target ? `${e.source}:${e.target}` : `${e.target}:${e.source}`;
      return !claimed.has(key);
    }),
  ];
  const possible = (n * (n - 1)) / 2;

  return {
    nodes: nodes.map((node, i) => ({
      ...node,
      x: coords[i]![0]!,
      y: coords[i]![1]!,
      z: coords[i]![2]!,
    })),
    edges,
    unembedded,
    explained,
    k,
    density: possible > 0 ? edges.length / possible : 0,
    /** How many edges someone wrote, as opposed to inferred. */
    links: written.length,
    distance: {
      min: flat[0]!,
      max: flat[flat.length - 1]!,
      median: flat[Math.floor(flat.length / 2)]!,
    },
  };
}
