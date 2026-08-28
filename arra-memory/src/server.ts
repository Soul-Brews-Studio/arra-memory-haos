import { Elysia } from "elysia";
import { authenticate, unauthorized, type AuthConfig } from "./auth";
import { handleMcp, toolCatalog, type JsonRpcRequest } from "./mcp";
import { enableAllTools, setToolDisabled, UNDISABLEABLE } from "./tools";
import {
  backfillEmbeddings,
  createMemory,
  searchMemoriesNoLog,
  searchSemanticNoLog,
  deleteMemory,
  embeddingCoverage,
  getMemory,
  getMemoryStats,
  indexMemory,
  searchMemories,
  searchSemantic,
  updateMemory,
} from "./memory";
import {
  authorizationServerMetadata,
  exchangeCode,
  getClient,
  isRegisteredRedirect,
  issueCode,
  registerClient,
  sweepExpired,
} from "./oauth";
import {
  clearSessionCookie,
  issueSession,
  revokeSession,
  sessionCookie,
  SESSION_COOKIE_NAME,
} from "./session";
import { approvalPage } from "./pages";
import {
  clearSearchLog,
  deleteSearchLogEntry,
  listSearchLog,
  pruneSearchLog,
  recordSearch,
  searchLogStats,
} from "./searchlog";
import { escapeHtml, readCookie, timingSafeEqual, type MemoryKind } from "./utils";
import { VERSION } from "./version";

const PORT = Number(process.env.PORT ?? 8099);
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? `${import.meta.dir}/../public`;

const config: AuthConfig = {
  ownerPassphrase: process.env.OWNER_PASSPHRASE ?? "",
  apiToken: process.env.API_TOKEN || undefined,
};

if (!config.ownerPassphrase) {
  // Refuse to start rather than serve the corpus to anyone who finds the URL.
  // Supervisor shows a stopped add-on; the log line below says why.
  console.error(
    "[arra-memory] FATAL: owner_passphrase is not set. Open this add-on's " +
      "Configuration tab and set one (e.g. `openssl rand -base64 32`).",
  );
  process.exit(1);
}

/**
 * The origin every absolute URL is built from.
 *
 * Behind Home Assistant ingress the request arrives at a path prefix under HA's
 * own hostname, so the socket's own address is not what a client should be told
 * to call back. public_url overrides it for the tunnel case; otherwise trust the
 * forwarded headers, then the Host header.
 */
function originOf(request: Request): string {
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

/**
 * Whether THIS request arrived over TLS — not whether the add-on has a public
 * HTTPS URL configured.
 *
 * These are different, and conflating them silently breaks login. `Secure` is
 * derived from public_url once, and the browser then refuses to store the
 * session cookie on every plain-http connection: the sidebar and the LAN port.
 * The passphrase POST returns 200, no cookie is kept, and the UI stays on the
 * lock screen with a correct passphrase — which reads as "wrong password".
 *
 * x-forwarded-proto is what a tunnel or ingress sets; the socket's own scheme
 * is the fallback.
 */
const isSecure = (request: Request) => {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return new URL(request.url).protocol === "https:";
};

/**
 * CORS, for browser-based MCP clients and for any discovery a web app performs
 * from the page rather than its backend.
 *
 * The MCP endpoint is protected by a bearer token or OAuth on every request, so
 * a permissive origin costs nothing here — an attacker's page still cannot read
 * a response without a credential it does not have. What a missing preflight
 * DOES cost is the entire connection, silently, before a single byte of MCP is
 * exchanged.
 *
 * `mcp-session-id` and `mcp-protocol-version` are named explicitly: they are
 * MCP's own headers, and a browser drops them from a cross-origin request
 * unless they are both allowed on the way in and exposed on the way out.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "86400",
};

/**
 * One JSON-RPC message as a single SSE frame.
 *
 * `event: message` is what the Streamable HTTP transport names its data frames;
 * a bare `data:` line is accepted by some clients and ignored by others, so it
 * is spelled out. The trailing blank line terminates the frame and is required
 * — without it the client waits for a frame that never completes.
 */
function sseFrame(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 405 with the Allow header the spec expects a client to read. */
const methodNotAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method not allowed. This endpoint accepts POST only." },
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST", ...CORS_HEADERS } },
  );

/** RFC 9728 metadata. `resource` is the MCP endpoint itself, not the origin. */
function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["memory:read", "memory:write"],
    bearer_methods_supported: ["header"],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });

/**
 * A ring buffer of recent /mcp exchanges.
 *
 * claude.ai calls this server from its own backend, so nothing about that
 * request is visible from a browser, and Supervisor's add-on log endpoint
 * returns an empty string on this HAOS build. Without this there is no way to
 * see what a remote client actually sent — which is how three separate silent
 * failures survived as long as they did.
 *
 * Bodies are recorded truncated and the Authorization header is never stored,
 * only whether one was present and which scheme it used.
 */
const MCP_LOG_SIZE = 25;
const mcpLog: Array<Record<string, unknown>> = [];

function recordMcp(entry: Record<string, unknown>) {
  mcpLog.unshift({ at: new Date().toISOString(), ...entry });
  if (mcpLog.length > MCP_LOG_SIZE) mcpLog.length = MCP_LOG_SIZE;
}

const app = new Elysia()

  // Preflight for every path. Registered first so the SPA catch-all can never
  // answer an OPTIONS with an HTML page — the same way it was answering GET /mcp.
  .options("/*", () => new Response(null, { status: 204, headers: CORS_HEADERS }))

  // ── health ─────────────────────────────────────────────────────────────────
  // Deliberately public and deliberately empty of corpus data: this is what a
  // tunnel, a uptime check, or `just serves` hits to prove the add-on is alive.
  // Public and deliberately free of corpus data, but NOT free of identity:
  // "is it up" and "which build is up" are the same question in practice, and
  // an answer that omits the version sends you to the Supervisor UI to find out.
  .get("/api/health", () => ({
    status: "ok",
    service: "arra-memory",
    version: VERSION,
    // What is switched on, without revealing any of it. Enough to tell a
    // misconfigured deploy from a broken one at a glance.
    features: {
      semantic: Boolean(process.env.OLLAMA_URL?.trim()),
      embeddingModel: process.env.OLLAMA_URL?.trim()
        ? (process.env.EMBEDDING_MODEL?.trim() || "bge-m3")
        : null,
      searchLog: (process.env.SEARCH_LOG ?? "").trim().toLowerCase() === "true",
      replica: Boolean(process.env.TURSO_SYNC_URL?.trim()),
      apiToken: Boolean(process.env.API_TOKEN),
    },
  }))

  // ── discovery ──────────────────────────────────────────────────────────────
  .get("/.well-known/oauth-authorization-server", ({ request }) =>
    json(authorizationServerMetadata(originOf(request))),
  )
  // RFC 9728 locates a protected resource's metadata by appending the
  // resource's PATH to the well-known prefix. For an MCP endpoint at /mcp that
  // is /.well-known/oauth-protected-resource/mcp — the bare path is the form
  // for a resource at the origin root, and a client that follows the spec
  // looks for the suffixed one. Both are served: the suffixed path because it
  // is correct, the bare path because some clients ask for it anyway.
  .get("/.well-known/oauth-protected-resource", ({ request }) =>
    json(protectedResourceMetadata(originOf(request))),
  )
  .get("/.well-known/oauth-protected-resource/mcp", ({ request }) =>
    json(protectedResourceMetadata(originOf(request))),
  )

  // ── OAuth: dynamic client registration ─────────────────────────────────────
  .post("/oauth/register", async ({ request }) => {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_client_metadata" }, 400);
    }
    try {
      const client = await registerClient(body);
      return json(
        {
          client_id: client.clientId,
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        },
        201,
      );
    } catch (error) {
      return json(
        {
          error: "invalid_client_metadata",
          error_description: error instanceof Error ? error.message : "invalid",
        },
        400,
      );
    }
  })

  // ── OAuth: the approval page ───────────────────────────────────────────────
  // GET renders a passphrase form. The owner is the authorization decision;
  // there is no account system behind this.
  .get("/authorize", async ({ request }) => {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";

    const client = await getClient(clientId);
    if (!client || !isRegisteredRedirect(client, redirectUri)) {
      // Never redirect on a bad client or redirect_uri — that is precisely the
      // open-redirect this check exists to prevent. Fail on our own page.
      return new Response("Unknown client or unregistered redirect_uri.", {
        status: 400,
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response(
      approvalPage({
        clientName: client.clientName ?? client.clientId,
        params: {
          client_id: clientId,
          redirect_uri: redirectUri,
          state: url.searchParams.get("state") ?? "",
          code_challenge: url.searchParams.get("code_challenge") ?? "",
          code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
          scope: url.searchParams.get("scope") ?? "memory:read memory:write",
        },
      }),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  })

  .post("/authorize", async ({ request }) => {
    const form = await request.formData();
    const passphrase = String(form.get("passphrase") ?? "");
    const clientId = String(form.get("client_id") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    const state = String(form.get("state") ?? "");
    const codeChallenge = String(form.get("code_challenge") ?? "");
    const codeChallengeMethod = String(form.get("code_challenge_method") ?? "");
    const scope = String(form.get("scope") ?? "memory:read memory:write");

    const client = await getClient(clientId);
    if (!client || !isRegisteredRedirect(client, redirectUri)) {
      return new Response("Unknown client or unregistered redirect_uri.", { status: 400 });
    }

    if (!(await timingSafeEqual(passphrase, config.ownerPassphrase))) {
      return new Response(
        approvalPage({
          clientName: client.clientName ?? client.clientId,
          error: "That passphrase does not match. Try again.",
          params: {
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: codeChallengeMethod,
            scope,
          },
        }),
        { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    try {
      const code = await issueCode({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    } catch (error) {
      return new Response(
        error instanceof Error ? escapeHtml(error.message) : "Authorization failed.",
        { status: 400 },
      );
    }
  })

  // ── OAuth: token exchange ──────────────────────────────────────────────────
  .post("/oauth/token", async ({ request }) => {
    const form = await request.formData();
    if (String(form.get("grant_type")) !== "authorization_code") {
      return json({ error: "unsupported_grant_type" }, 400);
    }
    try {
      const result = await exchangeCode({
        code: String(form.get("code") ?? ""),
        clientId: String(form.get("client_id") ?? ""),
        redirectUri: String(form.get("redirect_uri") ?? ""),
        codeVerifier: String(form.get("code_verifier") ?? ""),
      });
      return json({
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: result.expiresIn,
        scope: result.scope,
      });
    } catch {
      // One opaque error for every failure mode. Telling a caller *which* check
      // failed hands an attacker a probing oracle.
      return json({ error: "invalid_grant" }, 400);
    }
  })

  // ── the web session ────────────────────────────────────────────────────────
  .post("/api/session", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
    if (!(await timingSafeEqual(String(body.passphrase ?? ""), config.ownerPassphrase))) {
      return json({ error: "invalid_passphrase" }, 401);
    }
    const token = await issueSession(config.ownerPassphrase);
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": sessionCookie(token, isSecure(request)),
      },
    });
  })

  .get("/api/session", async ({ request }) => {
    const auth = await authenticate(request, config);
    return json({ authenticated: auth.ok, method: auth.method ?? null });
  })

  .delete("/api/session", async ({ request }) => {
    await revokeSession(readCookie(request.headers.get("cookie"), SESSION_COOKIE_NAME));
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": clearSessionCookie(isSecure(request)),
      },
    });
  })

  // ── the corpus ─────────────────────────────────────────────────────────────
  .get("/api/memories", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));

    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? undefined;
    const kind = (url.searchParams.get("kind") as MemoryKind) || undefined;
    const memories = await searchMemories({
      query,
      kind,
      limit: Number(url.searchParams.get("limit")) || undefined,
      source: "web",
    });
    return json({ memories, count: memories.length });
  })

  .get("/api/memories/:id", async ({ request, params }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const memory = await getMemory(params.id);
    return memory ? json({ memory }) : json({ error: "not_found" }, 404);
  })

  .post("/api/memories", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    try {
      const body = (await request.json()) as any;
      const memory = await createMemory({ ...body, source: body.source ?? "web" });
      // Best-effort and deliberately not awaited into the response: the memory
      // is already durable, and a slow or dead embedding server must not make
      // the write appear to fail.
      void indexMemory(memory);
      return json({ memory }, 201);
    } catch (error) {
      return json(
        { error: "invalid", message: error instanceof Error ? error.message : "invalid" },
        400,
      );
    }
  })

  .patch("/api/memories/:id", async ({ request, params }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    try {
      const body = (await request.json()) as any;
      const memory = await updateMemory(params.id, body);
      return memory ? json({ memory }) : json({ error: "not_found" }, 404);
    } catch (error) {
      return json(
        { error: "invalid", message: error instanceof Error ? error.message : "invalid" },
        400,
      );
    }
  })

  .delete("/api/memories/:id", async ({ request, params }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const deleted = await deleteMemory(params.id);
    return deleted ? json({ id: params.id, deleted: true }) : json({ error: "not_found" }, 404);
  })

  // Semantic and hybrid recall. Degradation is REPORTED, never silent: the
  // response always says which mode actually ran and why, so a caller is never
  // left believing a keyword scan was a semantic search.
  .post("/api/search", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));

    const body = (await request.json().catch(() => ({}))) as any;
    const requestedMode: "keyword" | "semantic" | "hybrid" = body.mode ?? "hybrid";
    const query = String(body.query ?? "");
    const common = { kind: body.kind, project: body.project, limit: body.limit };

    if (requestedMode === "keyword" || !query.trim()) {
      const memories = await searchMemories({ query, ...common, tag: body.tag, source: "web" });
      return json({ requestedMode, effectiveMode: "keyword", fallback: null, memories });
    }

    const started = Date.now();
    try {
      // NoLog variants: hybrid is one user action running two passes, and both
      // recording themselves would double-count every hybrid search.
      const semantic = await searchSemanticNoLog({ query, ...common });
      if (requestedMode === "semantic") {
        void recordSearch({
          query, mode: "semantic", kind: body.kind, project: body.project,
          resultIds: semantic.memories.map((m) => m.id),
          durationMs: Date.now() - started,
          source: "web",
        });
        return json({
          requestedMode, effectiveMode: "semantic", fallback: null,
          memories: semantic.memories, distances: semantic.distances,
        });
      }

      // Hybrid: reciprocal rank fusion. Ranks rather than raw scores, because
      // BM25 and cosine distance are not on comparable scales and normalising
      // them against each other invents a precision neither one has.
      const keyword = await searchMemoriesNoLog({ query, ...common });
      const K = 60;
      const scores = new Map<string, number>();
      const byId = new Map<string, any>();
      keyword.forEach((m, i) => {
        scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (K + i + 1));
        byId.set(m.id, m);
      });
      semantic.memories.forEach((m, i) => {
        scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (K + i + 1));
        byId.set(m.id, m);
      });
      const merged = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, body.limit ?? 20)
        .map(([id]) => byId.get(id));

      void recordSearch({
        query, mode: "hybrid", kind: body.kind, project: body.project,
        resultIds: merged.map((m: any) => m.id),
        durationMs: Date.now() - started,
        source: "web",
      });

      return json({
        requestedMode, effectiveMode: "hybrid", fallback: null,
        memories: merged,
        counts: { keyword: keyword.length, semantic: semantic.memories.length },
      });
    } catch (error) {
      // Explicit semantic FAILS; hybrid degrades to keyword and names the reason.
      const reason = error instanceof Error ? error.message : "embedding failed";
      if (requestedMode === "semantic") {
        return json({ error: "semantic_unavailable", message: reason }, 503);
      }
      // Logged as keyword, not hybrid, because keyword is what actually ran —
      // the fallback reason is in the response for the caller to see.
      const memories = await searchMemories({ query, ...common, tag: body.tag, source: "web" });
      return json({
        requestedMode, effectiveMode: "keyword",
        fallback: { used: true, reason }, memories,
      });
    }
  })

  .post("/api/index/backfill", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const body = (await request.json().catch(() => ({}))) as any;
    return json({ indexed: await backfillEmbeddings(body.limit ?? 50) });
  })

  // ── the MCP tool surface, as the owner can see and shape it ────────────────
  .get("/api/tools", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    return json({ tools: await toolCatalog(), locked: [...UNDISABLEABLE] });
  })

  .patch("/api/tools/:name", async ({ request, params }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const body = (await request.json().catch(() => ({}))) as { disabled?: boolean };
    try {
      await setToolDisabled(params.name, Boolean(body.disabled));
      return json({ name: params.name, disabled: Boolean(body.disabled) });
    } catch (error) {
      return json(
        { error: "cannot_disable", message: error instanceof Error ? error.message : "refused" },
        400,
      );
    }
  })

  .post("/api/tools/enable-all", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    await enableAllTools();
    return json({ ok: true });
  })

  // ── the search log ─────────────────────────────────────────────────────────
  .get("/api/search-log", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const url = new URL(request.url);
    const [entries, stats] = await Promise.all([
      listSearchLog(Number(url.searchParams.get("limit")) || 50, url.searchParams.get("q") ?? undefined),
      searchLogStats(),
    ]);
    return json({ entries, stats });
  })

  .delete("/api/search-log/:id", async ({ request, params }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const deleted = await deleteSearchLogEntry(params.id);
    return deleted ? json({ id: params.id, deleted: true }) : json({ error: "not_found" }, 404);
  })

  // Bulk delete. `all` and `olderThanDays` are mutually exclusive here for the
  // same reason as in the MCP tool: an ambiguous request must not delete more
  // than the caller pictured.
  .delete("/api/search-log", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const url = new URL(request.url);
    const days = url.searchParams.get("olderThanDays");
    const all = url.searchParams.get("all") === "true";
    if (all === Boolean(days)) {
      return json({ error: "invalid", message: "Give exactly one of all=true or olderThanDays." }, 400);
    }
    if (all) return json({ deleted: await clearSearchLog() });
    const { removed, cutoff } = await pruneSearchLog(Number(days));
    return json({ deleted: removed, cutoff });
  })

  // What remote clients actually sent. Authenticated; see recordMcp above.
  .get("/api/debug/mcp-log", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    return json({ entries: mcpLog });
  })

  .get("/api/stats", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    const [stats, coverage] = await Promise.all([getMemoryStats(), embeddingCoverage()]);
    return json({ stats, embeddings: coverage });
  })

  // ── MCP ────────────────────────────────────────────────────────────────────
  .post("/mcp", async ({ request }) => {
    const headers = Object.fromEntries(
      [...request.headers.entries()].filter(([k]) => k !== "authorization" && k !== "cookie"),
    );
    const authHeader = request.headers.get("authorization");

    const auth = await authenticate(request, config);
    if (!auth.ok) {
      recordMcp({ outcome: "401", authPresented: authHeader ? authHeader.split(" ")[0] : null, headers });
      return unauthorized(originOf(request));
    }

    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
      recordMcp({
        outcome: "ok",
        method: body.method,
        authMethod: auth.method,
        accept: request.headers.get("accept"),
        protocolVersion: (body as any)?.params?.protocolVersion,
        clientInfo: (body as any)?.params?.clientInfo,
        headers,
      });
    } catch {
      recordMcp({ outcome: "parse-error", headers });
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    const response = await handleMcp(body);
    // A notification returns nothing at all — 202 with an empty body is the
    // correct answer, and sending a JSON-RPC envelope would be a violation.
    if (response === null) {
      return new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    // Streamable HTTP lets the server answer a POST with either a JSON body or
    // an SSE stream, and says to honour what the client asked for in Accept.
    //
    // Honouring it is not optional in practice. claude.ai sends
    // `Accept: application/json, text/event-stream`, and given a plain JSON
    // reply it authenticates successfully, reports the connector connected,
    // and then never surfaces a single tool — its bootstrap stream simply
    // carries no `event: tools` for this server while every SSE-answering
    // server it talks to has one. Measured 2026-08-28.
    const accept = request.headers.get("accept") ?? "";
    if (accept.includes("text/event-stream")) {
      return new Response(sseFrame(response), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          // Cloudflare buffers by default, which would hold a short stream
          // until the connection closes and defeat the point of streaming.
          "x-accel-buffering": "no",
          ...CORS_HEADERS,
        },
      });
    }

    return json(response);
  })

  // Streamable HTTP defines GET on the MCP endpoint as "open an SSE stream for
  // server-initiated messages", and requires a server that does not offer one
  // to answer 405 Method Not Allowed.
  //
  // This matters far more than it looks. Without these two routes the catch-all
  // SPA handler below answers GET /mcp with index.html and HTTP 200 — a client
  // probing for the stream is handed a React page and told it succeeded.
  // Measured against claude.ai on 2026-08-28: the connector authorized fine,
  // reported itself "connected", and then showed "no tools available" with no
  // error on either side.
  //
  // This server is stateless: there is no server-initiated stream and no
  // session to delete, so both verbs are an honest 405.
  .get("/mcp", () => methodNotAllowed())
  .delete("/mcp", () => methodNotAllowed())

  // ── the UI ─────────────────────────────────────────────────────────────────
  //
  // main.js and app.css have stable filenames, so a browser that cached them
  // keeps running the OLD app after an update — for as long as the cache says.
  // Observed live: a deployed build containing a new panel, a browser executing
  // the previous bundle, and the panel simply absent with nothing to see.
  //
  // The shell is therefore never cached and stamps the version onto each asset
  // URL, so every release is a different URL and the old entry is simply never
  // asked for again. The assets themselves keep a long cache precisely because
  // their URL now changes when their content does.
  .get("/*", async ({ request }) => {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    if (path !== "/index.html") {
      const file = Bun.file(`${PUBLIC_DIR}${path}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            // Safe to cache hard: the shell only ever requests these with the
            // current version in the query string.
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }
    }

    const shell = await Bun.file(`${PUBLIC_DIR}/index.html`).text();
    const stamped = shell
      .replace('"./main.js"', `"./main.js?v=${VERSION}"`)
      .replace('"./app.css"', `"./app.css?v=${VERSION}"`);

    return new Response(stamped, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        // The one document that must always be re-fetched — it is what points
        // at the current assets.
        "cache-control": "no-store, must-revalidate",
      },
    });
  });

// Expired codes and tokens are ignored on read; this only stops the tables
// growing. Hourly is far more often than necessary and costs nothing.
setInterval(() => void sweepExpired().catch(() => {}), 60 * 60 * 1000);

app.listen({ port: PORT, hostname: "0.0.0.0" });

console.log(`[arra-memory] listening on 0.0.0.0:${PORT}`);
console.log(
  `[arra-memory] auth: owner-session + oauth${config.apiToken ? " + api-token" : ""}`,
);
