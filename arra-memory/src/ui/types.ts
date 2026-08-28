/** Shared shapes between the API and the UI. Mirrors src/memory.ts. */

export const MEMORY_KINDS = [
  "note",
  "decision",
  "lesson",
  "context",
  "person",
  "project",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

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

export interface MemoryStats {
  total: number;
  kinds: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  latestUpdatedAt: string | null;
}

/** Which authentication proved the caller — surfaced so the UI can say so. */
export type AuthMethod = "owner-session" | "api-token" | "oauth";

export const KIND_COLOR: Record<MemoryKind, string> = {
  note: "var(--color-kind-note)",
  decision: "var(--color-kind-decision)",
  lesson: "var(--color-kind-lesson)",
  context: "var(--color-kind-context)",
  person: "var(--color-kind-person)",
  project: "var(--color-kind-project)",
};

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
