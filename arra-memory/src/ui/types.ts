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
  createdAt: string;
  updatedAt: string;
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
