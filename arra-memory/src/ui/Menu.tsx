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
  primary: { label: string; onSelect: () => void };
  items: Array<{ label: string; title?: string; danger?: boolean; onSelect: () => void }>;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-1.5" aria-label="Archive">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onSelect}
          title={item.title}
          className="rounded-lg border border-line px-3 py-1.5 text-sm transition-colors hover:border-line-bright"
          style={{ color: item.danger ? "#f0928f" : "var(--color-dim)" }}
          onMouseEnter={(e) => {
            if (!item.danger) e.currentTarget.style.color = "var(--color-ink)";
          }}
          onMouseLeave={(e) => {
            if (!item.danger) e.currentTarget.style.color = "var(--color-dim)";
          }}
        >
          {item.label}
        </button>
      ))}

      <button
        type="button"
        onClick={primary.onSelect}
        className="ml-1 rounded-lg bg-ember px-3.5 py-1.5 text-sm font-semibold text-[#17130e] transition hover:brightness-110"
      >
        {primary.label}
      </button>
    </nav>
  );
}

/**
 * A centred dialog, the same shape the compose form already uses.
 *
 * The panels this replaces slid in from the right, which put a second scrolling
 * region beside the page's own and made the archive behind them unreadable
 * without being dismissed. A dialog is honest about being modal.
 */
export function Panel({
  title,
  eyebrow,
  subtitle,
  actions,
  onClose,
  children,
}: {
  title: string;
  eyebrow: string;
  subtitle?: string;
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel"
      >
        <header className="border-b border-line px-6 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="eyebrow mb-1">{eyebrow}</p>
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              {subtitle && <p className="mt-1.5 text-sm text-dim">{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              className="shrink-0 rounded p-1.5 text-faint transition-colors hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {actions && <div className="mt-3">{actions}</div>}
        </header>

        {/* The one scrolling region, inside the dialog. */}
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>
  );
}
