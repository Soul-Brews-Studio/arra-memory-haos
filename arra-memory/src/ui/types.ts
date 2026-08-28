/** Shared shapes between the API and the UI. Mirrors src/memory.ts. */

/**
 * Kind is free text, matching workspace, project and tags.
 *
 * These four are what the compose form suggests, not what it permits — see
 * SUGGESTED_KINDS in utils.ts for why the enum went away.
 */
export const SUGGESTED_KINDS = ["learn", "enlighten", "retro", "artifact"] as const;

export type MemoryKind = string;

export interface Memory {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  source: string;
  importance: number;
  /** The team-level namespace. Empty means unfiled, not a workspace named "none". */
  workspace: string;
  project: string;
  url: string;
  /** Which agent or person wrote it. Empty on anything written anonymously. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How the corpus is divided, as the server derives it.
 *
 * There is no workspaces table on the server either — these come from a GROUP
 * BY over the memories themselves, so the list is always exactly what has been
 * written and never a registry that drifted.
 */
export interface WorkspaceFacet {
  workspace: string;
  count: number;
  projects: number;
  agents: number;
  latest: string;
}

export interface ProjectFacet {
  project: string;
  count: number;
  latest: string;
}

export interface AgentFacet {
  agent: string;
  count: number;
  latest: string;
}

/** Every chip row, as /api/facets returns it in one request. */
export interface Facets {
  kinds: Array<{ kind: string; count: number }>;
  workspaces: WorkspaceFacet[];
  unassigned: number;
  projects: ProjectFacet[];
  agents: AgentFacet[];
  tags: Array<{ tag: string; count: number }>;
  total: number;
}

/**
 * What the archive is narrowed to.
 *
 * Arrays, not strings: a chip row is multi-select, and "either of these
 * workspaces" is one question rather than two searches a caller has to merge.
 * Empty everywhere means the whole corpus, which is the default.
 */
export interface Scope {
  kind: string[];
  workspace: string[];
  project: string[];
  createdBy: string[];
}

export const EMPTY_SCOPE: Scope = { kind: [], workspace: [], project: [], createdBy: [] };

export interface MemoryStats {
  total: number;
  kinds: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  latestUpdatedAt: string | null;
}

/** Which authentication proved the caller — surfaced so the UI can say so. */
export type AuthMethod = "owner-session" | "api-token" | "oauth";


export interface SearchLogEntry {
  id: string;
  query: string;
  mode: string;
  kind: string;
  workspace: string;
  project: string;
  tag: string;
  resultCount: number;
  resultIds: string[];
  durationMs: number;
  source: string;
  createdAt: string;
}

export interface SearchLogStats {
  enabled: boolean;
  total: number;
  oldest: string | null;
  newest: string | null;
}

export interface EmbeddingCoverage {
  total: number;
  embedded: number;
  model: string | null;
  enabled: boolean;
}

/** /api/health — public, and the fastest way to see which build is running. */
export interface Health {
  status: string;
  service: string;
  version: string;
  features: {
    semantic: boolean;
    embeddingModel: string | null;
    searchLog: boolean;
    replica: boolean;
    apiToken: boolean;
  };
}

export interface ToolInfo {
  name: string;
  description: string;
  /** Produced from the corpus (a project or a time window), not from source. */
  generated: boolean;
  project: string | null;
  destructive: boolean;
  disabled: boolean;
}
