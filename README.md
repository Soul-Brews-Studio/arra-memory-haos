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
| `public_url` | no | Set **only** when the add-on is published through a tunnel and a remote MCP client needs absolute OAuth URLs. Blank derives every URL from the request, which is correct for LAN and ingress. |

## Three ways in

Different callers can prove they are the owner in different ways, and no single
mechanism serves them all.

| Method | Who uses it | How |
|---|---|---|
| Session cookie | The web UI | Passphrase → HMAC-signed cookie, 12h, revocable |
| Static bearer | curl, scripts, Claude Code, Codex | `Authorization: Bearer <api_token>` |
| OAuth 2.1 + PKCE | **claude.ai connectors** | Dynamic registration, then an approval page |

claude.ai cannot send a static header at all — OAuth is the only door open to
it, and that is the entire reason this add-on ships an authorization server.

### Connect Claude Code or Codex

```bash
claude mcp add --transport http arra-memory http://homeassistant.local:8099/mcp \
  --header "Authorization: Bearer <api_token>"

codex mcp add arra-memory --url http://homeassistant.local:8099/mcp
```

### Connect claude.ai

Publish the add-on at a public HTTPS hostname (a Cloudflare Tunnel does this
without opening a port), set `public_url` to that hostname, then in **Settings →
Connectors → Add custom connector** paste `https://your-host/mcp`. Approve with
your owner passphrase on the page that appears.

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
