import { useState } from "react";
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
 *                AMENDED 2026-08-29: flat stopped scaling. On a 19,687-memory
 *                corpus the project row alone was ~40 chips over 15 lines and
 *                the filter bar displaced the content it filters. A wide row
 *                now shows its TOP values inline — facets are sorted by count,
 *                so the head of the list is the part worth seeing without a
 *                click — and folds only the tail behind "+N", which expands to
 *                one value per line, counts right-aligned. A TICKED value in
 *                the tail is promoted into the visible head: collapsing must
 *                never hide active filter state.
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

/**
 * A row wider than this folds — per facet, because chip WIDTH varies more than
 * chip count. Ten tags fit one line; ten projects are ten full repo URLs and
 * take four. The unit that matters is lines consumed, and count is only a
 * proxy for it, so the proxy is tuned per key.
 */
const FOLD_AT: Record<FacetKey, number> = {
  kind: 10,
  workspace: 8,
  project: 4,      // repo URLs — the widest values on the page
  createdBy: 8,
  tag: 10,
};

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
      {rows.map((row) => {
        const chip = (v: { value: string; count: number }, cls = "chip") => {
          const on = selected(row.key).includes(v.value);
          return (
            <button
              key={v.value}
              type="button"
              className={cls}
              aria-pressed={on}
              onClick={() => toggle(row.key, v.value)}
              // The kind row is the one place colour carries meaning rather
              // than state, so an unticked kind chip keeps its hue.
              style={row.key === "kind" && !on ? { color: kindColor(v.value) } : undefined}
            >
              <span>{v.value}</span>
              <span className="chip-count">{v.count}</span>
            </button>
          );
        };

        if (row.values.length <= FOLD_AT[row.key]) {
          return (
            // A GRID, not a wrapping flex row. With label and chips inline,
            // an overflowing row wrapped to the container's left edge — under
            // the LABEL — so multi-line rows lost the very alignment the
            // fixed-width label existed to provide. Two columns: the label
            // owns the first, the chips wrap inside the second.
            <div key={row.key} className="facet-row">
              <span className="eyebrow">{row.label}</span>
              <div className="flex flex-wrap items-baseline gap-1.5">
                {row.values.map((v) => chip(v))}
              </div>
            </div>
          );
        }

        return (
          <WideRow
            key={row.key}
            label={row.label}
            values={row.values}
            top={FOLD_AT[row.key]}
            isTicked={(v) => selected(row.key).includes(v)}
            chip={chip}
          />
        );
      })}

      {anySelected && (
        <div className="facet-row">
          <span className="eyebrow" />
          <div>
            <button
              type="button"
              onClick={onClear}
              className="chip"
              style={{ color: "var(--color-faint)" }}
            >
              {t("archive.clear")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A wide facet row: the head inline, the tail behind "+N".
 *
 * Facets arrive sorted by count, so the first `top` values are exactly the
 * ones a reader wants without clicking — hiding the whole row behind a fold
 * made the best chips cost a click too, which inverted the point. Only the
 * tail folds. A ticked value sitting in the tail is PROMOTED into the head:
 * active filter state must never be invisible.
 *
 * React state rather than <details>, because the expanded tail has to render
 * as a full-width block BELOW the chip flow — a details element in the flex
 * flow would reflow the head chips around its own box when it opens.
 */
function WideRow({
  label, values, top, isTicked, chip,
}: {
  label: string;
  values: Array<{ value: string; count: number }>;
  top: number;
  isTicked: (value: string) => boolean;
  chip: (v: { value: string; count: number }, cls?: string) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const head = values.slice(0, top);
  const promoted = values.slice(top).filter((v) => isTicked(v.value));
  const tail = values.slice(top).filter((v) => !isTicked(v.value));
  const hidden = tail.reduce((n, v) => n + v.count, 0);
  return (
    <div className="facet-row">
      <span className="eyebrow">{label}</span>
      {/* ONE list, head and tail alike. Rendering the head as wrapped chips and
          the tail as table rows put two different UIs in one row: expanding
          changed the shape of what was already on screen instead of simply
          continuing it. Same row UI throughout — the toggle only decides how
          far down the list goes. */}
      <div className="facet-fold-list">
        {head.map((v) => chip(v, "chip chip-line"))}
        {promoted.map((v) => chip(v, "chip chip-line"))}
        {open && tail.map((v) => chip(v, "chip chip-line"))}
        {tail.length > 0 && (
          <button
            type="button"
            className="chip chip-line facet-more"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span>
              <span className="facet-more-marker">▸</span>
              {open ? t("facet.less") : `+${tail.length} ${t("facet.more")}`}
            </span>
            {/* The hidden COUNT, in the count column — so the price of leaving
                it folded is legible without opening it. */}
            <span className="meta">{open ? "" : hidden}</span>
          </button>
        )}
      </div>
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
