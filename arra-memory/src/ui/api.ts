import type { Memory, MemoryKind, MemoryStats } from "./types";

/**
 * The browser's view of the API.
 *
 * Every call sends the session cookie and nothing else — the UI never holds a
 * bearer token. `credentials: "same-origin"` is required rather than incidental:
 * the add-on is served through Home Assistant's ingress path, and without it the
 * cookie is dropped on exactly the requests that need it.
 */

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`.${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    // A 401 is not an error the UI reports — it means "show the lock screen",
    // and App treats it that way. Anything else is worth a message.
    const body = await response.json().catch(() => ({}) as any);
    throw new ApiError(body.message ?? body.error ?? response.statusText, response.status);
  }

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

export { ApiError };

export const api = {
  session: {
    check: () =>
      call<{ authenticated: boolean; method: string | null }>("/api/session"),
    open: (passphrase: string) =>
      call<{ ok: true }>("/api/session", {
        method: "POST",
        body: JSON.stringify({ passphrase }),
      }),
    close: () => call<{ ok: true }>("/api/session", { method: "DELETE" }),
  },

  memories: {
    search: (params: { q?: string; kind?: MemoryKind | ""; limit?: number }) => {
      const search = new URLSearchParams();
      if (params.q) search.set("q", params.q);
      if (params.kind) search.set("kind", params.kind);
      if (params.limit) search.set("limit", String(params.limit));
      const qs = search.toString();
      return call<{ memories: Memory[]; count: number }>(
        `/api/memories${qs ? `?${qs}` : ""}`,
      );
    },

    create: (input: {
      content: string;
      title?: string;
      kind?: MemoryKind;
      tags?: string[];
      importance?: number;
    }) =>
      call<{ memory: Memory }>("/api/memories", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    update: (id: string, input: Partial<Memory>) =>
      call<{ memory: Memory }>(`/api/memories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),

    remove: (id: string) =>
      call<{ id: string; deleted: boolean }>(`/api/memories/${id}`, {
        method: "DELETE",
      }),
  },

  stats: () => call<{ stats: MemoryStats }>("/api/stats"),
};
