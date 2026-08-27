import { Elysia } from "elysia";
import { authenticate, unauthorized, type AuthConfig } from "./auth";
import { handleMcp, type JsonRpcRequest } from "./mcp";
import {
  createMemory,
  deleteMemory,
  getMemory,
  getMemoryStats,
  searchMemories,
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
import { escapeHtml, readCookie, timingSafeEqual, type MemoryKind } from "./utils";

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

const isSecure = (request: Request) => originOf(request).startsWith("https://");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const app = new Elysia()

  // ── health ─────────────────────────────────────────────────────────────────
  // Deliberately public and deliberately empty of corpus data: this is what a
  // tunnel, a uptime check, or `just serves` hits to prove the add-on is alive.
  .get("/api/health", () => ({ status: "ok", service: "arra-memory" }))

  // ── discovery ──────────────────────────────────────────────────────────────
  .get("/.well-known/oauth-authorization-server", ({ request }) =>
    json(authorizationServerMetadata(originOf(request))),
  )
  .get("/.well-known/oauth-protected-resource", ({ request }) => {
    const origin = originOf(request);
    return json({
      resource: origin,
      authorization_servers: [origin],
      scopes_supported: ["memory:read", "memory:write"],
    });
  })

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
    const memories = await searchMemories({
      query: url.searchParams.get("q") ?? undefined,
      kind: (url.searchParams.get("kind") as MemoryKind) || undefined,
      limit: Number(url.searchParams.get("limit")) || undefined,
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

  .get("/api/stats", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));
    return json({ stats: await getMemoryStats() });
  })

  // ── MCP ────────────────────────────────────────────────────────────────────
  .post("/mcp", async ({ request }) => {
    const auth = await authenticate(request, config);
    if (!auth.ok) return unauthorized(originOf(request));

    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    const response = await handleMcp(body);
    // A notification returns nothing at all — 202 with an empty body is the
    // correct answer, and sending a JSON-RPC envelope would be a violation.
    return response === null ? new Response(null, { status: 202 }) : json(response);
  })

  // ── the UI ─────────────────────────────────────────────────────────────────
  .get("/*", async ({ request }) => {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${PUBLIC_DIR}${path}`);
    if (await file.exists()) return new Response(file);
    // Single-page app: unknown paths render the shell and let the client route.
    return new Response(Bun.file(`${PUBLIC_DIR}/index.html`), {
      headers: { "content-type": "text/html; charset=utf-8" },
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
