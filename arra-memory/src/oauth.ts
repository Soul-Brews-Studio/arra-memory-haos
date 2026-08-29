import { db, ensureSchema, firstRow } from "./db";
import { OAUTH } from "./sql";
import { nowIso, nowSeconds, randomToken, sha256Base64Url } from "./utils";

/**
 * A minimal OAuth 2.1 authorization server — enough for an MCP client, and no
 * more.
 *
 * The hosted version leaned on @cloudflare/workers-oauth-provider. Off
 * Cloudflare, this file is what replaces it. It implements only what the MCP
 * spec actually requires of a remote server:
 *
 *   - Dynamic Client Registration (RFC 7591), because claude.ai registers
 *     itself rather than being configured by hand.
 *   - Authorization Code + PKCE S256 (RFC 7636). `plain` is refused outright;
 *     it offers no protection and OAuth 2.1 drops it.
 *   - Discovery at /.well-known/oauth-authorization-server (RFC 8414), which
 *     is how a client finds the three endpoints below.
 *
 * Deliberately absent: refresh tokens, client secrets, multi-user accounts,
 * consent scoping. One owner, one passphrase, one corpus.
 */

const CODE_TTL_SECONDS = 10 * 60; // one round trip, not a session
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface RegisteredClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

export interface TokenInfo {
  token: string;
  clientId: string;
  scope: string;
}

// ── discovery ─────────────────────────────────────────────────────────────────

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    // S256 only. Advertising "plain" would invite a client to use it.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["memory:read", "memory:write"],
  };
}

// ── dynamic client registration ───────────────────────────────────────────────

export async function registerClient(input: {
  client_name?: string;
  redirect_uris?: string[];
}): Promise<RegisteredClient> {
  await ensureSchema();

  const redirectUris = (input.redirect_uris ?? []).filter(
    (uri) => typeof uri === "string" && uri.length > 0,
  );
  if (redirectUris.length === 0) {
    throw new Error("redirect_uris is required");
  }

  const clientId = randomToken(16);
  const clientName = input.client_name?.slice(0, 120) ?? null;

  await db().execute({
    sql: OAUTH.clients.register,
    args: [clientId, clientName, JSON.stringify(redirectUris), nowIso()],
  });

  // No client_secret is issued: a public client cannot keep one, and PKCE is
  // what actually binds the code to the client that requested it.
  return { clientId, clientName, redirectUris };
}

export async function getClient(clientId: string): Promise<RegisteredClient | null> {
  await ensureSchema();
  const result = await db().execute({ sql: OAUTH.clients.byId, args: [clientId] });
  const row = firstRow<{
    client_id: string;
    client_name: string | null;
    redirect_uris: string;
  }>(result);
  if (!row) return null;

  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) redirectUris = parsed.filter((u) => typeof u === "string");
  } catch {
    redirectUris = [];
  }

  return { clientId: row.client_id, clientName: row.client_name, redirectUris };
}

/**
 * Exact-match only. Prefix matching is the classic open-redirect in OAuth: a
 * client registered for `https://x.com/cb` must not be able to receive a code
 * at `https://x.com/cb.attacker.net` or `https://x.com/cb/../elsewhere`.
 */
export function isRegisteredRedirect(
  client: RegisteredClient,
  redirectUri: string,
): boolean {
  return client.redirectUris.includes(redirectUri);
}

// ── authorization code ────────────────────────────────────────────────────────

export async function issueCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}): Promise<string> {
  await ensureSchema();

  if (input.codeChallengeMethod !== "S256") {
    throw new Error("code_challenge_method must be S256");
  }
  if (!input.codeChallenge) {
    throw new Error("code_challenge is required");
  }

  const code = randomToken(32);
  await db().execute({
    sql: OAUTH.codes.issue,
    args: [
      code,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.scope,
      nowSeconds() + CODE_TTL_SECONDS,
    ],
  });
  return code;
}

/**
 * Exchanges a code for a token.
 *
 * The code is deleted before the token is minted, whatever the outcome —
 * an authorization code is single-use, and a failed exchange must burn it too.
 * Otherwise an attacker who intercepts a code gets unlimited attempts at
 * guessing the verifier.
 */
export async function exchangeCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; scope: string; expiresIn: number }> {
  await ensureSchema();

  const result = await db().execute({
    sql: OAUTH.codes.consume,
    args: [input.code, nowSeconds()],
  });
  const row = firstRow<{
    code: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: string;
    scope: string;
  }>(result);

  if (!row) throw new Error("invalid_grant");

  await db().execute({ sql: OAUTH.codes.delete, args: [input.code] });

  // The code was issued to one client, for one redirect_uri. Both must match
  // the exchange, or a different client could redeem a code it observed.
  if (row.client_id !== input.clientId) throw new Error("invalid_grant");
  if (row.redirect_uri !== input.redirectUri) throw new Error("invalid_grant");

  // PKCE: only the requester knows the verifier whose SHA-256 is the challenge.
  const computed = await sha256Base64Url(input.codeVerifier);
  if (computed !== row.code_challenge) throw new Error("invalid_grant");

  const accessToken = randomToken(32);
  await db().execute({
    sql: OAUTH.tokens.issue,
    args: [
      accessToken,
      row.client_id,
      row.scope,
      nowIso(),
      nowSeconds() + TOKEN_TTL_SECONDS,
    ],
  });

  return { accessToken, scope: row.scope, expiresIn: TOKEN_TTL_SECONDS };
}

// ── bearer verification ───────────────────────────────────────────────────────

export async function verifyBearer(header: string | null): Promise<TokenInfo | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;

  await ensureSchema();
  const result = await db().execute({
    sql: OAUTH.tokens.verify,
    args: [token, nowSeconds()],
  });
  const row = firstRow<{ token: string; client_id: string; scope: string }>(result);

  return row ? { token: row.token, clientId: row.client_id, scope: row.scope } : null;
}

export async function revokeToken(token: string): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: OAUTH.tokens.revoke, args: [token] });
}

/** Housekeeping: drop codes and tokens already past their deadline. */
export async function sweepExpired(): Promise<void> {
  await ensureSchema();
  const now = nowSeconds();
  await db().batch(
    [
      { sql: OAUTH.codes.sweep, args: [now] },
      { sql: OAUTH.tokens.sweep, args: [now] },
    ],
    "write",
  );
}

/** Every registered client with its live-token count — the "who has access" view. */
export async function listClients(): Promise<
  Array<{
    clientId: string; clientName: string | null; createdAt: string;
    activeTokens: number; lastTokenAt: string | null; scope: string | null;
  }>
> {
  const rows = await db().execute({ sql: OAUTH.tokens.clients, args: [nowSeconds()] });
  return rows.rows.map((r: any) => ({
    clientId: String(r.client_id),
    clientName: r.client_name ? String(r.client_name) : null,
    createdAt: String(r.created_at),
    activeTokens: Number(r.active_tokens ?? 0),
    lastTokenAt: r.last_token_at ? String(r.last_token_at) : null,
    scope: r.scope ? String(r.scope) : null,
  }));
}

/**
 * Revoke everything a client holds — tokens and any pending codes.
 *
 * The registration row deliberately survives: it is the record that this
 * client existed, and the next connect re-authorizes without re-registering.
 * The effect is immediate because verifyBearer reads the tokens table on
 * every request; there is no cache to wait out.
 */
export async function revokeClient(clientId: string): Promise<void> {
  await db().execute({ sql: OAUTH.tokens.revokeClientTokens, args: [clientId] });
  await db().execute({ sql: OAUTH.tokens.revokeClientCodes, args: [clientId] });
}
