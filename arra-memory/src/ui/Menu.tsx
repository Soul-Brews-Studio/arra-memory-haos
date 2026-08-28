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
export function NavBar({
  primary,
  items,
}: {
  primary?: { label: string; onSelect: () => void };
  items: Array<{
    label: string;
    title?: string;
    danger?: boolean;
    /** Marks the view currently on screen, so the bar reads as navigation. */
    active?: boolean;
    onSelect: () => void;
  }>;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Archive">
      {items.map((item) => (
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

      {primary && (
        <button
          type="button"
          onClick={primary.onSelect}
          className="ml-1 rounded-lg bg-ember px-3.5 py-1.5 text-sm font-semibold text-[#17130e] transition hover:brightness-110"
        >
          {primary.label}
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
        <div className="mx-auto max-w-4xl px-5 pb-5 pt-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow mb-1.5">{eyebrow}</p>
              <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
              {subtitle && <p className="mt-2 max-w-2xl text-sm text-dim">{subtitle}</p>}
            </div>
            {nav ?? (
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-sm text-dim transition-colors hover:border-line-bright hover:text-ink"
              >
                ← Archive
              </button>
            )}
          </div>
          {actions && <div className="mt-4">{actions}</div>}
        </div>
      </header>

      {/* No nested scroll container — the page scrolls, as a page should. */}
      <main className="mx-auto max-w-4xl px-5 py-6">{children}</main>
    </>
  );
}
