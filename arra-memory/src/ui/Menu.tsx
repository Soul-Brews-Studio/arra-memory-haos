import { useEffect } from "react";

/**
 * A flat nav bar. Every destination is one click.
 *
 * This replaced a dropdown, which was the wrong trade: hiding four items behind
 * a menu saved a little header width and cost a click on every single use. A
 * menu earns itself when there are too many items to show or the items are
 * rare; neither is true here.
 *
 * The primary action stays visually distinct from navigation — writing a memory
 * is what the page is for, and it should not look like a peer of "Search log".
 */
export interface NavItem {
  label: string;
  title?: string;
  danger?: boolean;
  /** Marks the view currently on screen, so the bar reads as navigation. */
  active?: boolean;
  /**
   * Where this sits in the bar. Lower is further left; ties keep source order.
   *
   * Explicit weights rather than array position, so adding a destination is
   * choosing a number instead of finding the right line to insert at — and so
   * the order is stated once where the item is defined rather than implied by
   * how the array happens to be written. Leave gaps (10, 20, 30) so something
   * can land between two existing entries without renumbering anything.
   */
  weight?: number;
  onSelect: () => void;
}

export function NavBar({
  items,
  lang,
}: {
  items: NavItem[];
  /**
   * The language switch, in the bar itself.
   *
   * It used to live in Settings, which is wrong for this one control: someone
   * who lands on a page in a language they do not read cannot be asked to find
   * the settings page in order to fix that. It is the one preference that has
   * to be reachable without reading anything.
   */
  lang?: { label: string; title: string; onSelect: () => void };
}) {
  // Sorted here, not by the caller, so every bar in the app orders the same way.
  // Unweighted items default to 50 and fall in the middle rather than jumping to
  // the front, which is what an unset number would do if it defaulted to 0.
  const ordered = [...items].sort((a, b) => (a.weight ?? 50) - (b.weight ?? 50));

  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Archive">
      {ordered.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onSelect}
          title={item.title}
          aria-current={item.active ? "page" : undefined}
          className="rounded-lg border px-3 py-1.5 text-sm transition-colors"
          style={{
            borderColor: item.active ? "var(--color-ember)" : "var(--color-line)",
            background: item.active ? "var(--color-ember-soft)" : "transparent",
            color: item.danger
              ? "#f0928f"
              : item.active
                ? "var(--color-ember)"
                : "var(--color-dim)",
          }}
        >
          {item.label}
        </button>
      ))}

      {lang && (
        <button
          type="button"
          onClick={lang.onSelect}
          title={lang.title}
          className="ml-1 rounded-lg border border-line px-2.5 py-1.5 font-mono text-xs uppercase tracking-wide transition-colors hover:border-line-bright"
          style={{ color: "var(--color-faint)" }}
        >
          {lang.label}
        </button>
      )}
    </nav>
  );
}

/**
 * A full-page view's header.
 *
 * These started as drawers, became dialogs, and are now pages — because that is
 * what the content is. A search log with hundreds of rows read through a modal
 * means a scrolling region inside a scrolling region, and nothing behind it was
 * ever worth seeing anyway. A page gets the browser's own scrollbar, its own
 * back button, and the full width.
 */
export function Panel({
  title,
  eyebrow,
  subtitle,
  actions,
  onClose,
  nav,
  children,
}: {
  title: string;
  eyebrow: string;
  subtitle?: string;
  actions?: React.ReactNode;
  onClose: () => void;
  nav?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Escape still leaves — it is the reflex people have already built here, and
  // there is no cost to honouring it on a page.
  //
  // Except when a dialog is open on top. Both listeners are on `window`, so
  // stopPropagation from the dialog cannot help: one Escape would dismiss the
  // compose form AND navigate the page out from under it. Escape belongs to the
  // topmost layer, so the page yields while one exists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <header className="lamp border-b border-line">
        <div className="mx-auto max-w-4xl px-5 pb-5 pt-6">
          {/* The nav gets its own full-width row above the title.
              It used to sit opposite the title in a justify-between row, which
              left it roughly half the header to fit six buttons in — so it
              wrapped onto a second line and the whole bar changed height
              depending on how long the page title was. A nav that moves when
              you navigate is not a nav bar. Full width, one row, same place. */}
          <div className="mb-5">
            {nav ?? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-dim transition-colors hover:border-line-bright hover:text-ink"
              >
                ← Archive
              </button>
            )}
          </div>

          <div className="min-w-0">
            <p className="eyebrow mb-1.5">{eyebrow}</p>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-2 max-w-2xl text-sm text-dim">{subtitle}</p>}
          </div>
          {actions && <div className="mt-4">{actions}</div>}
        </div>
      </header>

      {/* No nested scroll container — the page scrolls, as a page should. */}
      <main className="mx-auto max-w-4xl px-5 py-6">{children}</main>
    </>
  );
}
