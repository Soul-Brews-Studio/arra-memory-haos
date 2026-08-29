# Arra Memory — Home Assistant add-on

A durable memory corpus that lives in your Home Assistant sidebar and answers to
Claude over MCP. Memories are stored in an embedded libSQL database under the
add-on's own `/data`, so they survive restarts and ride along in Home Assistant's
backups.

No Cloudflare account. No Turso account. No external service of any kind — the
database is a file on your own machine.

## Install

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add `https://github.com/Soul-Brews-Studio/arra-memory-haos`
3. Install **Arra Memory**, then open its **Configuration** tab and set an
   owner passphrase:
   ```bash
   openssl rand -base64 32
   ```
   The add-on refuses to start without one, rather than serving your memories
   to anyone who reaches it.
4. Start it. The sidebar gains a **Memory** panel.

## Configuration

| Option | Required | What it does |
|---|---|---|
| `owner_passphrase` | yes | Unlocks the web UI and approves MCP clients. |
| `api_token` | no | A static bearer token for scripts and MCP clients that read a config file. Leave blank to disable that path. |
| `search_log` | no | Record every search, including query text. Off by default — see below. |
| `turso_sync_url` / `turso_auth_token` | no | Turn the local database into a Turso embedded replica. |
| `public_url` | no | Set **only** when the add-on is published through a tunnel and a remote MCP client needs absolute OAuth URLs. Blank derives every URL from the request, which is correct for LAN and ingress. |

## Proving you are the owner

Different callers can prove they are the owner in different ways, and no single
mechanism serves them all.

| Method | Who uses it | How |
|---|---|---|
| Session cookie | The web UI | Passphrase → HMAC-signed cookie, 12h, revocable |
| Static bearer | curl, scripts, cron, anything headless | `Authorization: Bearer <api_token>` |
| OAuth 2.1 + PKCE | **claude.ai**, and Claude Code / Codex if you prefer it | Dynamic registration, then an approval page |

claude.ai cannot send a static header at all, so OAuth is the only door open to
it — that is why this add-on ships an authorization server. But the CLI clients
can use either, and OAuth is the better default wherever a browser is reachable:
nothing long-lived ends up in a config file or an environment variable, the grant
is scoped, and it is revocable server-side without touching the client.

Reach for a static token when there is no browser — cron, a headless box, a
container.

### The OAuth surface

| | |
|---|---|
| `/.well-known/oauth-authorization-server` | issuer, endpoints, `S256`, `authorization_code` |
| `/.well-known/oauth-protected-resource` | resource `<base>/mcp`, scopes `memory:read` `memory:write` |
| `/oauth/register` | Dynamic Client Registration — clients enrol themselves |
| `/authorize` · `/oauth/token` | approval page, then the code exchange |

**`issuer` must equal `public_url` exactly.** Clients compare the two and refuse
on any mismatch — which is why blanking `public_url` (see the wholesale-replace
warning under Configuration) breaks every OAuth client at once while leaving the
static-token path working, a confusing pair of symptoms.

### Connect Claude Code

```bash
# OAuth — nothing secret is stored in your config
claude mcp add arra-memory https://your-host/mcp --transport http -s user
claude mcp login arra-memory          # --no-browser for SSH/headless

# or a static token
claude mcp add arra-memory https://your-host/mcp --transport http -s user \
  --header "Authorization: Bearer <api_token>"
```

⚠️ **Put the positional arguments before `--header`.** It is variadic, so placed
first it swallows the name and URL and you get `error: missing required argument
'name'` even though you supplied both.

`claude mcp get arra-memory` reports `! Needs authentication` until the login
completes; that is the expected intermediate state, not a failure.

### Connect Codex

```bash
# OAuth
codex mcp add arra-memory --url https://your-host/mcp
codex mcp login arra-memory --scopes memory:read,memory:write \
  --oauth-client-registration dcr

# or a static token — note this stores the variable's NAME, not the value
codex mcp add arra-memory --url https://your-host/mcp \
  --bearer-token-env-var ARRA_TOKEN
```

⚠️ `--bearer-token-env-var` wants the **name of an environment variable**, not the
token. Pasting the token there produces `Environment variable <the-token-itself>
… is not set`, which is a confusing way to be told you supplied the wrong thing.

⚠️ If you export that variable from `~/.zshrc`, Codex will not see it: zsh sources
`.zshrc` only for **interactive** shells, and Codex starts its MCP clients from
one that is not. The symptom is `Environment variable … is not set` while the
same variable resolves perfectly in your terminal. Use `~/.zshenv`, and guard it
so every shell spawn does not pay for the lookup:

```bash
if [ -z "${ARRA_TOKEN:-}" ]; then
  export ARRA_TOKEN="$(pass show path/to/token 2>/dev/null)"
fi
```

### Connect claude.ai

claude.ai needs a public HTTPS URL — it cannot reach a LAN or VPN address, and it
cannot send a static bearer header. Publish the add-on through a Cloudflare
Tunnel (which dials outward and opens no inbound port), set `public_url` to that
hostname, then in **Settings → Customize → Connectors → Add custom connector**
paste `https://your-host/mcp`. Approve with your owner passphrase on the page
that appears.

Step 2 of that form should read **"Authentication: Always required — Detected"**.
That word *Detected* means claude.ai successfully fetched the discovery documents
above. If it says anything else, the server side is wrong and no amount of
clicking will fix it.

### Verifying a connection, and what does not count

A client printing `Successfully logged in` is **not** proof. It can appear with
no visible browser step at all — if that browser already holds an owner session,
the approval page redirects immediately and the flow completes silently. It
really did work in that case, but the message alone cannot tell you so.

Four checks that do settle it:

```bash
# 1. discovery is public and the issuer matches
curl -s https://your-host/.well-known/oauth-authorization-server

# 2. an unauthenticated call is refused
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://your-host/mcp     # 401

# 3. a real initialize succeeds with your credential
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://your-host/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# 4. call a tool through the client itself
```

Check 2 matters as much as check 3: a 200 proves the server is reachable, not
that anything is being enforced.

Two things that look like auth failures and are not:

- **Codex storing nothing in `~/.codex/auth.json`.** OAuth credentials go to the
  OS keyring (on macOS, the login keychain, under `<server-name>|<hash>`).
  Grepping `auth.json` finds nothing and looks exactly like a failed login.
- **`MCP tool call requires approval, but approval policy is never`.** That is
  the client's own approval gate. The give-away is that the log still shows
  `mcp: <server>/<tool> started` — the server connected and listed its tools
  fine.

## Reaching it

Ingress and the LAN port are the add-on's own doors; the other two are just
different routes to the same port, and none of them weakens the auth in front of
it. Prefer the narrowest one that reaches your client.

| Path | Address | Who it is for |
|---|---|---|
| Ingress | the sidebar panel | The browser UI, authenticated by Home Assistant |
| LAN | `http://<ha-host>:8099` | Clients on the same network |
| VPN | `http://<host>.<your-mesh>:8099` | Other peers on a private mesh — never leaves the overlay |
| Public | `https://<your-tunnel-host>` | claude.ai, which has no other option |

A private mesh such as NetBird or Tailscale needs nothing from this add-on: if
the Home Assistant host is already a peer, the add-on's port is reachable over
the mesh the moment it is published.

**Everything except `/api/health` and the OAuth discovery documents requires
authentication on every path, including the public one.** Discovery has to be
public — it is how an MCP client learns where `/authorize` lives.

## The tool list is not a constant

Most MCP servers expose a fixed set of tools. This one generates tools from what
is actually in the corpus, so a model sees the shape of the archive in the tool
list itself instead of having to guess parameter values.

**Always present:** `remember`, `recall_memories`, `read_memory`,
`revise_memory`, `forget_memory`, `memory_stats`, `list_projects`, `list_tags`,
`search_memories_between`

**Generated from your projects** — one per project that has memories:

```
recall_project_laris_co_haos_oracle
```

**Generated time windows** — relative ones always, calendar months only where
memories exist:

```
search_today          search_last_7days     search_last_3weeks
search_yesterday      search_last_2weeks    search_last_1month
search_last_3months   search_last_6months   search_last_1year
search_2026_08        search_2026_07_to_2026_08
```

Any month parses on demand, so `search_2026_01` works even though January is too
old to be offered as a generated tool. `search_memories_between` takes explicit
dates for anything else.

## Search

Full-text search over an FTS5 **trigram** index, ranked by BM25 with titles
weighted above content.

Trigram is not a stylistic choice. FTS5's default `unicode61` tokenizer splits
on whitespace, and Thai does not use it — so `unicode61` swallows an entire Thai
sentence as one token and searching for a word inside it returns nothing.
Measured on this engine before the decision was made:

| Query | Corpus | `unicode61` | `trigram` |
|---|---|---|---|
| `ความจำ` | `ระบบความจำสำหรับผู้ช่วยเอไอ` | **0 rows** | **1 row** |

Trigram indexes every three-character sequence, so it needs no word boundaries
at all — and it is the one FTS5 tokenizer that can also accelerate
`LIKE '%needle%'`. The costs are honest: roughly 2–3× storage on indexed text,
and queries shorter than three characters fall back to a scan.

If the index is ever unavailable, search degrades to a table scan rather than
reporting an empty corpus.

### Semantic search (optional)

Point `ollama_url` at an Ollama server and `POST /api/search` gains two more
modes. The server does not need to be the Home Assistant machine — a box on your
LAN or private mesh is usually the better place, since a HAOS host rarely has
room for a model.

| Mode | What it does |
|---|---|
| `keyword` | Trigram FTS5 only |
| `semantic` | Vector nearest-neighbour only. **Fails** if embeddings are unavailable |
| `hybrid` (default) | Both, fused by reciprocal rank. Degrades to keyword and says why |

The default model is `bge-m3`, and the reason is worth stating: it is genuinely
multilingual. Measured on a real corpus, a Thai sentence scores **0.84** cosine
similarity against its own English translation and **0.32** against unrelated
Thai. That means recall works *across* languages — an English query finds a Thai
memory. Verified end to end: the query "finding notes written in another language
by meaning" returned a Thai memory sharing **zero characters** with it as the top
hit, ahead of two English memories.

Vectors are stored in libSQL's native `F32_BLOB(1024)` with a
`libsql_vector_idx` ANN index — no extension, no separate vector database.

Three failure rules, all verified:

- A write **always** succeeds even when the embedding server is down. Indexing is
  best-effort and never blocks the memory.
- `hybrid` degrades to `keyword` and reports `fallback.reason`. It never silently
  pretends a keyword scan was semantic.
- `semantic` **fails with 503** rather than degrading, because a caller who asked
  for semantic specifically deserves to know it did not happen.

#### When a memory gets embedded

Embedding is a property of the write, not something a caller opts into. Since
**0.22.0** it happens inside `createMemory` and `updateMemory`, so every surface
gets it for free:

| You do this | Embedded? |
|---|---|
| `remember` over MCP (claude.ai, Claude Code) | ✅ on write |
| `POST /api/memories` (the web UI) | ✅ on write |
| `revise_memory` / `PATCH`, **title or content changed** | ✅ re-embedded |
| `revise_memory` / `PATCH`, only tags/importance/project/url | — not needed |
| Anything written before you configured `ollama_url` | via backfill |

Two details that follow from that:

- **The write returns before the vector lands.** Indexing is fire-and-forget by
  contract, so a `remember` that answers instantly has not necessarily been
  embedded *yet* — it will be, within a second or so. Only `ollama_url` being
  unset or unreachable makes it never happen, and a write still succeeds then.
- **A metadata-only edit does not re-embed.** The embedded text is
  `title\n\ncontent`; a tag cannot move the vector, so it does not pay for a
  round trip to the model.

`POST /api/index/backfill` covers the remaining case — memories written before
embeddings were switched on, or when the model changed. It selects rows whose
embedding is `NULL` **or** whose `embedding_model` differs, so it is safe to
re-run and cheap when there is nothing to do:

```bash
curl -X POST http://<host>:8099/api/index/backfill \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"limit":50}'
# → {"indexed":7}
```

> **Historical note, worth knowing if you run an older build.** Before 0.22.0,
> indexing was a *call-site* concern and only the REST handler did it — so every
> memory written over MCP went in unvectorised, and revising a memory left the
> old vector in place forever. That second case could not be repaired by
> backfill: a revised row has a non-null vector from a matching model, so it
> matches neither half of the `pending` predicate, and its vector went on
> describing text that no longer existed. If you are upgrading from ≤0.21.0, run
> the backfill once for the unvectorised rows; anything revised under an old
> build needs its title or content touched again to be re-embedded.

**Reaching the Ollama server from inside the add-on.** An add-on container sits
on Home Assistant's own Docker bridge. It can reach your LAN, but it has *no
route to a VPN overlay* even when the Home Assistant host itself is a mesh peer —
the mesh client runs in a different namespace. Use the server's LAN address
(`http://192.168.1.x:11434`), not its mesh name. Learned by watching backfill
return `{"indexed":0}` against a mesh address that answered perfectly from
elsewhere.

## Seeing and shaping the tool surface

The **tools** panel lists every tool the connector offers, split into the ones
defined in source and the ones generated from the corpus. That split is
otherwise invisible unless you go reading a client's tool picker, and it is the
part that changes on its own as memories are written.

Any tool can be switched off. A disabled tool is hidden from `tools/list` **and
refused if a client with a cached list calls it anyway** — hiding alone would
not be a control. Nothing is deleted: the memories behind a generated tool are
untouched, and re-enabling brings it straight back.

Two things this is actually for:

- A project with three memories does not need its own tool cluttering a model's list.
- Turning off `remember`, `revise_memory` and `forget_memory` makes the
  connector **read-only** for a client you do not want writing to the archive.

`list_projects`, `list_tags` and `memory_stats` cannot be disabled — they are
how a model discovers the corpus once its generated tools are gone, and hiding
them turns a narrowed list into a dead end.

## The search log

Off by default. Turn on `search_log` and every recall is recorded — **the query
text and which memories came back**, with timings.

That default is not timidity. A search log is often more revealing than the
corpus it searches: what someone looked for says more than what they wrote down.
Enable it when *"what was I searching for last week"* is worth more to you than
not keeping that record.

Result **ids** are stored, result **content** is not — the memories are in the
table next door, and copying their text would double the blast radius of a leak
for nothing.

Every search records itself, from every route: `recall_memories`, each generated
project tool, every time window, `search_memories_between`, the web UI, and
hybrid recall. The recording lives **inside the search functions**, not at their
call sites — there are seven ways to reach a search, and a log wired up per
caller is one forgotten call away from answering "what did I search for" with a
confident, partial lie.

The `mode` column records what actually ran, not what was asked for: a hybrid
search that degraded to keyword is logged as `keyword`, because that is the
search that happened.

| Tool | Does |
|---|---|
| `list_search_log` | Recent searches, optionally filtered by query substring |
| `forget_search_log` | Delete one by `id`, everything `olderThanDays`, or `all` |

`forget_search_log` requires **exactly one** of those three, so an ambiguous call
cannot delete more than intended. Recording is fire-and-forget and can never
fail a search — a log that breaks what it observes is worse than no log.

## Surviving the machine — Turso embedded replica

Set `turso_sync_url` and `turso_auth_token` and the add-on becomes a libSQL
**embedded replica**: the local file stays the read path, so every query is
still answered from disk with no network in the hot path, while libSQL
replicates against Turso in the background.

The point is survival. The Home Assistant machine can be lost entirely and the
corpus is still in Turso. Leave both blank for a purely local database — which
is the default, and needs no account anywhere.

`turso_sync_interval` (seconds, default 60) is the trade: low enough that
another client sees a write soon, high enough that an idle add-on is not
chattering at the network.

## A memory

| Field | Notes |
|---|---|
| `content` | 1–12,000 characters |
| `title` | Inferred from the first line when omitted |
| `kind` | `note`, `decision`, `lesson`, `context`, `person`, `project` |
| `tags` | Up to 10, deduplicated case-insensitively |
| `importance` | 1–5 |
| `project` | Free-form, e.g. `github.com/owner/repo`. Generates a recall tool. |
| `url` | Reference link. `http`/`https` only. |
| `createdBy` | Who or what produced it |

## Where things live

```
arra-memory/
├── config.yaml      the add-on contract: ingress, sidebar panel, /data
├── Dockerfile       HA base + Bun (musl), builds the UI into the image
├── run.sh           reads Supervisor options, never bakes them into a layer
└── src/
    ├── sql.ts       every statement in the add-on, in one file
    ├── db.ts        libSQL client, schema, migrations
    ├── memory.ts    the corpus
    ├── kv.ts        the Cloudflare KV replacement — three operations, one table
    ├── oauth.ts     OAuth 2.1 + PKCE + dynamic client registration
    ├── session.ts   HMAC owner sessions, revocable
    ├── auth.ts      one gate, three keys
    ├── mcp.ts       the MCP surface, including the generated tools
    ├── timerange.ts what search_last_3weeks actually means
    ├── pages.tsx    the OAuth approval page (server-rendered, auto-escaping)
    └── ui/          the React + Tailwind archive
```

Every SQL statement lives in `sql.ts` and nothing else in the codebase writes
one, so the complete surface that touches the database can be read in one
sitting. Every statement is parameterised; there is no string interpolation in
that file and there must never be.

## Development

```bash
cd arra-memory
bun install
bun run build:ui

DATABASE_URL="file:./dev.db" \
OWNER_PASSPHRASE="dev-passphrase" \
API_TOKEN="dev-token" \
  bun src/server.ts
```

```bash
bun run typecheck
bun test
```

## License

MIT
