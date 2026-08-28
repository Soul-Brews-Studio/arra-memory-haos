import { t } from "./i18n";
import type { Facets, Scope } from "./types";

/**
 * The filter bar. One idiom, everything visible, nothing to open.
 *
 * This replaced three idioms sharing one header — a text input, two-to-three
 * `<select>` dropdowns that hid their options until clicked and materialised a
 * third only after you picked a workspace, and a row of seven pills for kind.
 * Three ways to say "narrow this", in 295px of a 911px viewport, before a single
 * memory was visible. That inconsistency was the whole of why the page felt
 * wrong.
 *
 * The rules, and each one is a rule the old bar broke:
 *
 *   FLAT       — every row is present at once. Project chips do not wait for a
 *                workspace to be chosen; a control that appears in response to
 *                another control is a nested choice.
 *   NO CHOICES — nothing opens. A chip is its own option and its own state.
 *   MARKS      — chips toggle. Within a row it is OR ("either workspace"),
 *                across rows it is AND, which is what ticking boxes means.
 *   REDUNDANT  — a memory matching three chips shows under all three. Nothing is
 *                deduplicated into a hierarchy.
 *   ZERO MARKS — means everything, and that is the default.
 *
 * Counts are corpus-wide and deliberately do NOT track the current selection.
 * Chips that shrink and vanish as you tick them make the bar jump under the
 * cursor and hide the chip you need to untick.
 */

type FacetKey = "kind" | "workspace" | "project" | "createdBy" | "tag";

interface Row {
  key: FacetKey;
  label: string;
  values: Array<{ value: string; count: number }>;
}

export function Chips({
  facets,
  scope,
  tags,
  onChange,
  onClear,
}: {
  facets: Facets;
  scope: Scope;
  /** Selected tags, kept beside scope because tags are not a scope column. */
  tags: string[];
  onChange: (next: { scope: Scope; tags: string[] }) => void;
  onClear: () => void;
}) {
  const rows: Row[] = ([
    {
      key: "kind",
      label: t("facet.kind"),
      values: facets.kinds.map((k) => ({ value: k.kind, count: k.count })),
    },
    {
      key: "workspace",
      label: t("facet.workspace"),
      values: facets.workspaces.map((w) => ({ value: w.workspace, count: w.count })),
    },
    {
      key: "project",
      label: t("facet.project"),
      values: facets.projects.map((p) => ({ value: p.project, count: p.count })),
    },
    {
      key: "createdBy",
      label: t("facet.agent"),
      values: facets.agents.map((a) => ({ value: a.agent, count: a.count })),
    },
    {
      key: "tag",
      label: t("facet.tag"),
      values: facets.tags.map((x) => ({ value: x.tag, count: x.count })),
    },
  ] satisfies Row[]).filter((r) => r.values.length > 0);

  const selected = (key: FacetKey): string[] =>
    key === "tag" ? tags : (scope[key] ?? []);

  const toggle = (key: FacetKey, value: string) => {
    const on = selected(key);
    const next = on.includes(value) ? on.filter((v) => v !== value) : [...on, value];
    if (key === "tag") onChange({ scope, tags: next });
    else onChange({ scope: { ...scope, [key]: next }, tags });
  };

  const anySelected =
    tags.length > 0 ||
    scope.kind.length > 0 ||
    scope.workspace.length > 0 ||
    scope.project.length > 0 ||
    scope.createdBy.length > 0;

  // Nothing to divide by and nothing ticked: an empty corpus does not need a
  // filter bar explaining that it is empty.
  if (!rows.length && !anySelected) return null;

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-wrap items-baseline gap-1.5">
          {/* Fixed-width label column so the chips line up down the left edge
              and the rows read as a table rather than as five ragged lines. */}
          <span className="eyebrow w-20 shrink-0">{row.label}</span>
          {row.values.map((v) => {
            const on = selected(row.key).includes(v.value);
            return (
              <button
                key={v.value}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={() => toggle(row.key, v.value)}
                // The kind row is the one place colour carries meaning rather
                // than state, so an unticked kind chip keeps its hue.
                style={
                  row.key === "kind" && !on
                    ? { color: kindColor(v.value) }
                    : undefined
                }
              >
                <span>{v.value}</span>
                <span className="chip-count">{v.count}</span>
              </button>
            );
          })}
        </div>
      ))}

      {anySelected && (
        <div className="flex items-baseline gap-1.5">
          <span className="eyebrow w-20 shrink-0" />
          <button
            type="button"
            onClick={onClear}
            className="chip"
            style={{ color: "var(--color-faint)" }}
          >
            {t("archive.clear")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A colour for a kind.
 *
 * Four kinds have a declared token; anything else gets a hue derived from the
 * word itself. Kind is free text now, so a fixed map would leave every kind
 * someone invents rendered in the same grey — and the point of colouring kinds
 * is that the corpus is scannable by shape of thought. Deterministic, so a kind
 * keeps its colour across sessions and machines.
 */
export function kindColor(kind: string): string {
  const known: Record<string, string> = {
    learn: "var(--color-kind-learn)",
    enlighten: "var(--color-kind-enlighten)",
    retro: "var(--color-kind-retro)",
    artifact: "var(--color-kind-artifact)",
  };
  if (known[kind]) return known[kind]!;

  let hash = 0;
  for (let i = 0; i < kind.length; i++) hash = (hash * 31 + kind.charCodeAt(i)) | 0;
  // Saturation and lightness fixed so a generated hue sits with the declared
  // ones rather than shouting past them.
  return `hsl(${Math.abs(hash) % 360} 42% 68%)`;
}
