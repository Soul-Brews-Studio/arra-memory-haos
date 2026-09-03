/**
 * `unembedded` counts memories with no vector — nothing else.
 *
 * This was live on 2026-09-03. buildGraph read at most `limit` embedded rows
 * (500 by default) and then reported `total - vectors.length`, so every memory
 * the LIMIT did not reach was counted as if it had no vector. On a corpus of
 * 29,111 fully-embedded memories the map read "28,611 without a vector" while
 * coverage was 100%. Nothing was broken; the number was measuring the page
 * size. It looked exactly like the 2026-08-28 bug in indexing.test.ts, which
 * is why it cost an evening to tell them apart.
 *
 * The test therefore builds a corpus BIGGER than the limit it asks for. At
 * limit >= N the old arithmetic is accidentally correct, so a small fixture
 * would have passed against the bug.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "arra-graph-test-"));

const embedder = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { input: string[] };
    const embeddings = body.input.map((text) =>
      Array.from({ length: 1024 }, (_, i) => ((text.length + i) % 97) / 97),
    );
    return Response.json({ model: "test-model", embeddings });
  },
});

process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
process.env.OLLAMA_URL = `http://localhost:${embedder.port}`;
process.env.EMBEDDING_MODEL = "test-model";
process.env.EMBEDDING_DIMENSIONS = "1024";

const { createMemory } = await import("./memory");
const { buildGraph } = await import("./graph");
const { db } = await import("./db");

const N = 12;
const LIMIT = 4; // deliberately below N — the whole point

async function embeddedCount(): Promise<number> {
  const result = await db().execute(
    "SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL",
  );
  return Number((result.rows[0] as any)?.n ?? 0);
}

beforeAll(async () => {
  for (let i = 0; i < N; i++) {
    await createMemory({ title: `memory ${i}`, content: `body number ${i}` });
  }
  // Indexing is fire-and-forget; wait for the corpus to actually be covered
  // rather than sleeping a guess.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await embeddedCount()) < N) await Bun.sleep(25);
  expect(await embeddedCount()).toBe(N);
});

afterAll(() => {
  embedder.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("a fully embedded corpus reports zero unembedded, however few points are drawn", async () => {
  const graph = await buildGraph({ limit: LIMIT });

  // The limit is honoured: this is a sample, not the whole corpus.
  expect(graph.nodes.length).toBe(LIMIT);
  // ...and sampling is not an absence. Before the fix this was N - LIMIT = 8.
  expect(graph.unembedded).toBe(0);
});

test("a memory with no vector is counted even when it is outside the sample", async () => {
  await db().execute({
    sql: "INSERT INTO memories (id, title, content, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: ["no-vector-1", "unindexed", "never embedded", "note", "2000-01-01", "2000-01-01"],
  });

  const graph = await buildGraph({ limit: LIMIT });

  expect(graph.nodes.length).toBe(LIMIT);
  expect(graph.unembedded).toBe(1);
});
