import { kvGet, kvPut } from "./kv";

/**
 * Which tools the owner has switched off.
 *
 * Disabling is not deleting. A generated tool exists because memories carry
 * that project; switching it off hides it from `tools/list` and leaves every
 * memory untouched. Re-enable it and it comes straight back — which is the
 * whole reason this is a preference and not a mutation of the corpus.
 *
 * Two things this is genuinely for:
 *   - A project with three memories does not need its own tool cluttering a
 *     model's list.
 *   - Turning off `remember`, `revise_memory` and `forget_memory` makes the
 *     connector read-only for a client you do not want writing to the archive.
 *
 * Stored as one JSON array in the kv table rather than a column per tool, so
 * the set survives a tool being generated, disabled, and generated again under
 * the same name.
 */

const KEY = "disabled-tools";

/**
 * Tools that may never be disabled.
 *
 * `list_projects` and `list_tags` are how a model discovers the corpus once its
 * generated tools are gone; hiding them turns a narrowed tool list into a dead
 * end. `memory_stats` is the same argument for the corpus as a whole.
 */
export const UNDISABLEABLE = new Set(["list_projects", "list_tags", "memory_stats"]);

export async function disabledTools(): Promise<Set<string>> {
  const raw = await kvGet(KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : []);
  } catch {
    // A corrupt value must not disable everything, or a bad write locks the
    // whole surface off with no way back through the same interface.
    return new Set();
  }
}

export async function setToolDisabled(name: string, disabled: boolean): Promise<Set<string>> {
  if (disabled && UNDISABLEABLE.has(name)) {
    throw new Error(`${name} cannot be disabled — it is how the corpus is discovered.`);
  }
  const current = await disabledTools();
  if (disabled) current.add(name);
  else current.delete(name);
  // No TTL: this is a preference, not a session.
  await kvPut(KEY, JSON.stringify([...current]));
  return current;
}

export async function enableAllTools(): Promise<void> {
  await kvPut(KEY, "[]");
}
