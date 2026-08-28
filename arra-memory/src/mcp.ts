import {
  createMemory,
  type CreateMemoryInput,
  deleteMemory,
  getMemory,
  getMemoryStats,
  listMonths,
  listProjects,
  listTags,
  searchInRange,
  searchMemories,
  updateMemory,
  type Memory,
} from "./memory";
import {
  clearSearchLog,
  deleteSearchLogEntry,
  listSearchLog,
  pruneSearchLog,
  searchLogStats,
} from "./searchlog";
import { disabledTools, setToolDisabled, UNDISABLEABLE } from "./tools";
import { RELATIVE_RANGES, resolveRange } from "./timerange";
import { MEMORY_KINDS, slugify, type MemoryKind } from "./utils";

/**
 * The MCP surface.
 *
 * Implemented directly against the JSON-RPC wire format rather than through the
 * SDK's transport layer: this add-on serves one stateless POST endpoint, and
 * hand-rolling that is a few dozen lines against an SDK transport built for
 * session management we do not want.
 *
 * The interesting part is that `tools/list` is not a constant. Base tools are
 * fixed, but the corpus also GENERATES tools: every project with memories in it
 * becomes its own `recall_<project>` tool. A model then sees the shape of the
 * archive in the tool list itself, instead of having to know that `project` is
 * a parameter and guess which values are real. `listChanged` is advertised so a
 * client knows the list is live, and re-reads it after writes.
 */

/**
 * Protocol versions this server will speak, newest first.
 *
 * The negotiation rule matters more than the list. A server MUST answer
 * `initialize` with a version the CLIENT can speak — echoing the client's
 * requested version when it is supported, and only falling back to its own
 * preference when it is not. Replying with a version the client does not know
 * is a silent, total failure: the client completes the handshake, reports
 * itself connected, and then never calls tools/list.
 *
 * Measured against claude.ai on 2026-08-28: it requested `2025-06-18`, this
 * server answered `2026-07-28` because the value was hard-coded, and the
 * connector showed "connected" with "no tools available" and no error anywhere.
 *
 * The wire format has not changed across these revisions for what this server
 * implements — initialize, tools/list, tools/call over JSON-RPC — so accepting
 * all of them is honest rather than merely permissive.
 */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25", // what claude.ai actually speaks — measured, not guessed
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

const PREFERRED_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/**
 * Echo the client's version when we can speak it; otherwise offer our own.
 *
 * The list above is explicit, but any well-formed YYYY-MM-DD revision is also
 * accepted. That is not laxness — this server implements three methods over
 * plain JSON-RPC (initialize, tools/list, tools/call) and none of them has
 * changed shape across any published revision. Refusing a version we would in
 * fact serve correctly costs the entire connection and says nothing useful.
 *
 * The list is still worth keeping: it documents what has actually been tested,
 * and it is what a reader checks first when a new client will not connect.
 */
function negotiateProtocol(requested: unknown): string {
  if (typeof requested !== "string") return PREFERRED_PROTOCOL_VERSION;
  if ((SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) return requested;
  return /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PREFERRED_PROTOCOL_VERSION;
}

/** How many projects may become their own tool. Beyond this, use the filter. */
const MAX_GENERATED_TOOLS = 12;

/** Prefix that marks a tool as corpus-generated rather than hand-written. */
const PROJECT_TOOL_PREFIX = "recall_project_";

/** Prefix for the time-window tools: search_today, search_2026_08, … */
const TIME_TOOL_PREFIX = "search_";

/** How many calendar months become their own tool. Older months stay reachable
 *  through `search_memories_between`, which takes explicit dates. */
const MAX_MONTH_TOOLS = 6;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const ok = (id: JsonRpcRequest["id"], result: unknown) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  result,
});

const fail = (id: JsonRpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

const toolError = (message: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: message }],
});

/** One memory rendered for a model to read: header, body, then provenance. */
function render(memory: Memory): string {
  const tags = memory.tags.length ? ` #${memory.tags.join(" #")}` : "";
  const provenance = [
    `id: ${memory.id}`,
    `importance: ${memory.importance}/5`,
    memory.project && `project: ${memory.project}`,
    memory.url && `url: ${memory.url}`,
    `source: ${memory.source}`,
    memory.createdBy && `by: ${memory.createdBy}`,
    `updated: ${memory.updatedAt}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return [`[${memory.kind}] ${memory.title}${tags}`, memory.content, provenance].join("\n");
}

// ── static tools ──────────────────────────────────────────────────────────────

const KIND_ENUM = { type: "string", enum: [...MEMORY_KINDS] };

const PROVENANCE_PROPS = {
  project: {
    type: "string",
    description: "Project this belongs to, e.g. github.com/owner/repo.",
  },
  url: { type: "string", description: "Reference URL. Must be http or https." },
  createdBy: { type: "string", description: "Who or what produced this memory." },
};

const BASE_TOOLS = [
  {
    name: "remember",
    description:
      "Persist a durable memory. Use for facts, decisions, lessons, people, projects, or context worth recalling later.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 12000 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        kind: KIND_ENUM,
        tags: { type: "array", items: { type: "string" }, maxItems: 10 },
        importance: { type: "integer", minimum: 1, maximum: 5 },
        ...PROVENANCE_PROPS,
      },
      required: ["content"],
    },
  },
  {
    name: "recall_memories",
    description:
      "Recall memories by keyword across titles, content, and tags, optionally narrowed by kind, project, or tag. An empty query returns the most recent important memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 240 },
        kind: KIND_ENUM,
        project: { type: "string" },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "read_memory",
    description: "Read one exact memory by its stable id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "revise_memory",
    description: "Revise fields on an existing memory, preserving its id and creation time.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string", minLength: 1, maxLength: 160 },
        content: { type: "string", minLength: 1, maxLength: 12000 },
        kind: KIND_ENUM,
        tags: { type: "array", items: { type: "string" }, maxItems: 10 },
        importance: { type: "integer", minimum: 1, maximum: 5 },
        ...PROVENANCE_PROPS,
      },
      required: ["id"],
    },
  },
  {
    name: "forget_memory",
    description:
      "Permanently delete one memory by id. Use only when the owner clearly asks to forget it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  {
    name: "memory_stats",
    description: "Summarize the corpus: total, counts by kind, top tags, last update.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_projects",
    description:
      "List every project in the corpus with its memory count. Each of these also appears as its own recall tool.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  {
    name: "list_tags",
    description: "List every tag in the corpus with how often it is used.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  {
    name: "list_search_log",
    description:
      "List recent searches with the query text, what was returned, and when. Only populated when the search log is enabled in the add-on configuration.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        query: { type: "string", description: "Only entries whose query contains this." },
      },
    },
  },
  {
    name: "forget_search_log",
    description:
      "Delete search log entries: one by id, everything older than N days, or all of it. Exactly one of id/olderThanDays/all must be given.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Delete exactly this entry." },
        olderThanDays: {
          type: "integer",
          minimum: 0,
          description: "Delete entries older than this many days, e.g. 30.",
        },
        all: { type: "boolean", description: "Delete every entry. Irreversible." },
      },
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  {
    name: "list_tools",
    description:
      "List every tool this connector can offer, whether it is currently enabled, and whether it was generated from the corpus rather than defined in source.",
    inputSchema: {
      type: "object",
      properties: {
        includeDisabled: {
          type: "boolean",
          description: "Include tools that are switched off. Defaults to true.",
        },
      },
    },
  },
  {
    name: "toggle_tool",
    description:
      "Switch one tool on or off. A disabled tool is hidden from tools/list and refused if called. Nothing is deleted — re-enabling brings it straight back.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool to change." },
        enabled: {
          type: "boolean",
          description: "true to switch on, false to switch off. Omit to flip it.",
        },
      },
      required: ["name"],
    },
  },
  {
    // The escape hatch behind the generated time tools: any window at all,
    // including ones older than the months offered as their own tools.
    name: "search_memories_between",
    description:
      "Search memories created between two dates (ISO-8601, e.g. 2026-01-01). Use the named search_* tools for common windows; use this for anything else.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date, inclusive. ISO-8601." },
        to: { type: "string", description: "End date, inclusive. ISO-8601." },
        query: { type: "string", maxLength: 240 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["from", "to"],
    },
  },
];

// ── generated tools ───────────────────────────────────────────────────────────

/**
 * Builds the live tool list: the static tools above, plus one recall tool per
 * project actually present in the corpus.
 *
 * Slug collisions are resolved by keeping the busiest project — two projects
 * that slugify identically would otherwise produce two tools with one name,
 * and a client is entitled to treat that as malformed.
 */
async function buildToolList() {
  const [projects, months] = await Promise.all([
    listProjects(MAX_GENERATED_TOOLS * 2),
    listMonths(MAX_MONTH_TOOLS),
  ]);

  const taken = new Set<string>();
  const generated: Array<Record<string, unknown>> = [];

  // One recall tool per project actually in the corpus.
  for (const facet of projects) {
    if (generated.length >= MAX_GENERATED_TOOLS) break;
    const slug = slugify(facet.project);
    if (!slug || taken.has(slug)) continue;
    taken.add(slug);

    generated.push({
      name: `${PROJECT_TOOL_PREFIX}${slug}`,
      description: `Recall memories filed under “${facet.project}” (${facet.count} stored). Optionally narrow with a keyword query.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 240 },
          kind: KIND_ENUM,
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
      // The literal project string travels with the tool so dispatch does not
      // have to reverse the slug — slugify is lossy and not invertible.
      _project: facet.project,
    });
  }

  const timeSchema = {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 240 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  };

  // The relative windows are always offered: "what did we decide last week" is
  // a question worth answering even against an empty corpus.
  for (const [key, range] of Object.entries(RELATIVE_RANGES)) {
    generated.push({
      name: `${TIME_TOOL_PREFIX}${key}`,
      description: `Search memories created in ${range.label}. Optionally narrow with a keyword query.`,
      inputSchema: timeSchema,
    });
  }

  // Calendar months are offered only where the corpus has something, so a
  // model is never handed a tool that can only return nothing.
  for (const { month, count } of months) {
    const token = month.replace("-", "_"); // 2026-08 → 2026_08
    generated.push({
      name: `${TIME_TOOL_PREFIX}${token}`,
      description: `Search the ${count} memories created in ${month}.`,
      inputSchema: timeSchema,
    });
  }

  // A span across the two most recent months, which is the range people ask
  // for most often after "this month" and cannot express with one month tool.
  if (months.length >= 2) {
    const [newest, older] = months;
    generated.push({
      name: `${TIME_TOOL_PREFIX}${older.month.replace("-", "_")}_to_${newest.month.replace("-", "_")}`,
      description: `Search memories created from ${older.month} through ${newest.month}.`,
      inputSchema: timeSchema,
    });
  }

  const all = [...BASE_TOOLS, ...generated];
  const off = await disabledTools();

  return {
    // What a client sees: everything the owner has not switched off.
    tools: all.filter((t: any) => !off.has(t.name)),
    generated,
    // What the UI sees: every tool that COULD exist, with its state, so a
    // disabled tool is still listed and can be switched back on.
    catalog: all.map((t: any) => ({
      name: t.name,
      description: t.description,
      generated: Boolean(t._project) || (t.name.startsWith(TIME_TOOL_PREFIX) && t.name !== "search_memories_between"),
      project: t._project ?? null,
      destructive: Boolean(t.annotations?.destructiveHint),
      disabled: off.has(t.name),
    })),
  };
}

/** The annotated catalog, for the UI and for /api/tools. */
export async function toolCatalog() {
  return (await buildToolList()).catalog;
}

// ── tool dispatch ─────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, any>) {
  // A generated tool is the same recall with its project pre-bound. Resolve it
  // against the live list rather than un-slugging, so a tool that no longer
  // exists reports that instead of silently searching the wrong project.
  if (name.startsWith(PROJECT_TOOL_PREFIX)) {
    const { generated } = await buildToolList();
    const tool = generated.find((t) => t.name === name);
    if (!tool) {
      return toolError(
        `No project tool named ${name}. The corpus may have changed — call list_projects or re-read tools/list.`,
      );
    }
    return recall({ ...args, project: tool._project as string });
  }

  // A time tool is a range query with its window pre-bound. The suffix is
  // parsed rather than looked up, so `search_2026_03` works even though March
  // is too old to have been offered as a generated tool.
  if (name.startsWith(TIME_TOOL_PREFIX)) {
    const range = resolveRange(name.slice(TIME_TOOL_PREFIX.length));
    if (range) {
      const memories = await searchInRange({
        fromIso: range.fromIso,
        toIso: range.toIso,
        query: args.query,
        limit: args.limit ?? 20,
        label: range.label,
        source: "mcp",
      });

      const body = memories.length
        ? memories.map((m, i) => `${i + 1}. ${render(m)}`).join("\n\n")
        : `No memories from ${range.label}${args.query ? ` matching “${args.query}”` : ""}.`;
      return {
        ...text(body),
        structuredContent: {
          window: range.label,
          from: range.fromIso,
          to: range.toIso,
          matchMode: "keyword",
          count: memories.length,
          memories,
        },
      };
    }
    // Falls through: `search_memories_between` also starts with this prefix.
  }

  switch (name) {
    case "remember": {
      const memory = await createMemory({
        ...(args as CreateMemoryInput),
        source: args.source ?? "claude",
        createdBy: args.createdBy ?? "claude",
      });
      return { ...text(`Remembered.\n\n${render(memory)}`), structuredContent: { memory } };
    }

    case "recall_memories":
      return recall(args);

    case "read_memory": {
      const memory = await getMemory(args.id);
      if (!memory) return toolError(`Memory ${args.id} was not found.`);
      return { ...text(render(memory)), structuredContent: { memory } };
    }

    case "revise_memory": {
      const { id, ...updates } = args;
      if (Object.keys(updates).length === 0) {
        return toolError("Provide at least one field to revise.");
      }
      const memory = await updateMemory(id, updates);
      if (!memory) return toolError(`Memory ${id} was not found.`);
      return { ...text(`Revised.\n\n${render(memory)}`), structuredContent: { memory } };
    }

    case "forget_memory": {
      const deleted = await deleteMemory(args.id);
      if (!deleted) return toolError(`Memory ${args.id} was not found.`);
      return {
        ...text(`Forgot memory ${args.id}.`),
        structuredContent: { id: args.id, deleted: true },
      };
    }

    case "memory_stats": {
      const stats = await getMemoryStats();
      return { ...text(JSON.stringify(stats, null, 2)), structuredContent: { stats } };
    }

    case "list_projects": {
      const projects = await listProjects(args.limit ?? 20);
      const body = projects.length
        ? projects
            .map((p) => `${p.project} — ${p.count} memories, last ${p.latest}`)
            .join("\n")
        : "No memories carry a project yet.";
      return { ...text(body), structuredContent: { projects } };
    }

    case "list_tags": {
      const tags = await listTags(args.limit ?? 50);
      const body = tags.length
        ? tags.map((t) => `${t.tag} (${t.count})`).join(", ")
        : "No tags yet.";
      return { ...text(body), structuredContent: { tags } };
    }

    case "list_search_log": {
      const entries = await listSearchLog(args.limit ?? 50, args.query);
      const stats = await searchLogStats();
      if (!stats.enabled) {
        return {
          ...text(
            "The search log is switched off. Enable `search_log` in this add-on's configuration to start recording queries.",
          ),
          structuredContent: { enabled: false, entries: [] },
        };
      }
      const body = entries.length
        ? entries
            .map(
              (e) =>
                `${e.createdAt}  “${e.query || "(empty)"}”  → ${e.resultCount} result(s), ${e.durationMs}ms${e.mode !== "keyword" ? `, ${e.mode}` : ""}`,
            )
            .join("\n")
        : "No searches recorded yet.";
      return { ...text(body), structuredContent: { enabled: true, stats, entries } };
    }

    case "forget_search_log": {
      // Exactly one mode, so an ambiguous call cannot delete more than intended.
      const modes = [args.id, args.olderThanDays, args.all].filter(
        (v) => v !== undefined && v !== null && v !== false,
      );
      if (modes.length !== 1) {
        return toolError("Give exactly one of: id, olderThanDays, or all.");
      }
      if (args.id) {
        const ok2 = await deleteSearchLogEntry(String(args.id));
        return ok2
          ? { ...text(`Deleted search log entry ${args.id}.`), structuredContent: { deleted: 1 } }
          : toolError(`No search log entry with id ${args.id}.`);
      }
      if (args.all === true) {
        const removed = await clearSearchLog();
        return { ...text(`Cleared the whole search log (${removed} entries).`), structuredContent: { deleted: removed } };
      }
      const { removed, cutoff } = await pruneSearchLog(Number(args.olderThanDays));
      return {
        ...text(`Pruned ${removed} search log entries older than ${args.olderThanDays} days (before ${cutoff}).`),
        structuredContent: { deleted: removed, cutoff },
      };
    }

    case "list_tools": {
      const catalog = await toolCatalog();
      const includeDisabled = args.includeDisabled !== false;
      const shown = includeDisabled ? catalog : catalog.filter((t: any) => !t.disabled);
      const line = (t: any) =>
        `${t.disabled ? "off" : "on "}  ${t.name}${t.generated ? "  (generated)" : ""}${
          UNDISABLEABLE.has(t.name) ? "  [always on]" : ""
        }`;
      return {
        ...text(
          `${shown.length} tools\n\n` + shown.map(line).join("\n"),
        ),
        structuredContent: { tools: shown, locked: [...UNDISABLEABLE] },
      };
    }

    case "toggle_tool": {
      const target = String(args.name ?? "");
      const catalog = await toolCatalog();
      const known = catalog.find((t: any) => t.name === target);
      if (!known) {
        return toolError(
          `No tool named ${target}. Call list_tools to see what exists — generated tools change with the corpus.`,
        );
      }
      // Omitting `enabled` flips it, which is what "toggle" means; passing it
      // makes the call idempotent for a client that wants a known end state.
      const enable = args.enabled === undefined ? known.disabled : Boolean(args.enabled);
      try {
        await setToolDisabled(target, !enable);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "That tool cannot be changed.");
      }
      return {
        ...text(`${target} is now ${enable ? "enabled" : "disabled"}.`),
        structuredContent: { name: target, enabled: enable },
      };
    }

    case "search_memories_between": {
      // Dates arrive as whatever the model produced. Normalising through Date
      // means "2026-01-01" and a full timestamp both work, and an unparseable
      // value is reported rather than silently matching everything.
      const from = new Date(args.from);
      const to = new Date(args.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return toolError("from and to must be ISO-8601 dates, e.g. 2026-01-01.");
      }

      // A date with no time means the WHOLE day, so `to` has to be its last
      // instant. Left as midnight, `from: 2026-08-27, to: 2026-08-27` is a
      // zero-width range that matches nothing — which reads as "no memories
      // that day" rather than as the bug it is. Found by asking for a single
      // day that definitely had memories and getting back zero.
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
      if (dateOnly.test(String(args.to).trim())) {
        to.setUTCHours(23, 59, 59, 999);
      }

      if (from > to) {
        return toolError("from must not be later than to.");
      }
      const memories = await searchInRange({
        fromIso: from.toISOString(),
        toIso: to.toISOString(),
        query: args.query,
        limit: args.limit ?? 20,
        label: `${args.from} to ${args.to}`,
        source: "mcp",
      });
      const body = memories.length
        ? memories.map((m, i) => `${i + 1}. ${render(m)}`).join("\n\n")
        : `No memories between ${args.from} and ${args.to}.`;
      return {
        ...text(body),
        structuredContent: {
          from: from.toISOString(),
          to: to.toISOString(),
          matchMode: "keyword",
          count: memories.length,
          memories,
        },
      };
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function recall(args: Record<string, any>) {
  const memories = await searchMemories({
    query: args.query,
    kind: args.kind as MemoryKind | undefined,
    project: args.project,
    tag: args.tag,
    limit: args.limit ?? 10,
    source: "mcp",
  });


  const scope = [
    args.project && `project “${args.project}”`,
    args.kind && `kind ${args.kind}`,
    args.tag && `tag ${args.tag}`,
  ]
    .filter(Boolean)
    .join(", ");

  const body = memories.length
    ? memories.map((m, i) => `${i + 1}. ${render(m)}`).join("\n\n")
    : `No memories matched${args.query ? ` “${args.query}”` : ""}${scope ? ` in ${scope}` : ""}.`;

  return {
    ...text(body),
    // matchMode is stated rather than implied: a model should know this is
    // literal keyword matching and not assume semantic recall found everything.
    structuredContent: {
      query: args.query ?? "",
      matchMode: "keyword",
      project: args.project ?? "",
      count: memories.length,
      memories,
    },
  };
}

// ── JSON-RPC entry point ──────────────────────────────────────────────────────

export async function handleMcp(request: JsonRpcRequest): Promise<unknown | null> {
  const { method, id, params = {} } = request;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateProtocol((params as any).protocolVersion),
        // listChanged tells the client the tool list is live — which it is, as
        // writing a memory under a new project adds a tool.
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "Arra Memory", version: "0.1.0" },
      });

    // Notifications carry no id and MUST NOT be answered — returning a response
    // to one is a protocol violation the client is entitled to reject.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list": {
      const { tools } = await buildToolList();
      // Strip the private field before it goes on the wire: `_project` is our
      // dispatch aid, not part of the client's contract.
      return ok(id, {
        tools: tools.map(({ _project, ...tool }: any) => tool),
      });
    }

    case "tools/call": {
      const name = String((params as any).name ?? "");
      const args = ((params as any).arguments ?? {}) as Record<string, any>;
      // Hiding a tool from the list is not enough — a client that cached an
      // older list would still be able to call it.
      if ((await disabledTools()).has(name)) {
        return ok(id, toolError(`${name} is switched off for this connector.`));
      }
      try {
        return ok(id, await callTool(name, args));
      } catch (error) {
        // Tool failures are reported inside a successful JSON-RPC result, not
        // as a transport error: the model should see and reason about them.
        const message = error instanceof Error ? error.message : "tool failed";
        return ok(id, toolError(message));
      }
    }

    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
