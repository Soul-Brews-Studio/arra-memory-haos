import { useEffect, useRef, useState } from "react";

/**
 * One menu instead of a row of buttons.
 *
 * The header had accumulated a button per panel, which is how a toolbar starts
 * and does not stop. Everything that is not the primary action — writing a
 * memory — lives behind one control, so the header keeps saying what the page
 * is for rather than listing what it can do.
 */
export function Menu({
  items,
}: {
  items: Array<{ label: string; hint?: string; danger?: boolean; onSelect: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape — a menu that only closes by
  // re-clicking its own button is a menu people fight with.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More"
        className="rounded-lg border border-line px-2.5 py-1.5 text-dim transition hover:border-line-bright hover:text-ink"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1.5 w-56 overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-xl"
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className="block w-full px-3 py-2 text-left transition-colors hover:bg-panel"
            >
              <span
                className="block text-sm"
                style={{ color: item.danger ? "#f0928f" : "var(--color-ink)" }}
              >
                {item.label}
              </span>
              {item.hint && (
                <span className="meta mt-0.5 block normal-case tracking-normal">{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
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
