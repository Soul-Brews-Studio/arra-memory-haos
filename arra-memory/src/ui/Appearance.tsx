import { LANGS, t, useLang, type Lang } from "./i18n";
import { THEMES, useTheme } from "./theme";

/**
 * Theme and language, at the top of Settings.
 *
 * Both are per-browser preferences rather than server configuration — two people
 * opening the same add-on should not have to agree on a palette, and the person
 * who reads it in English is often not the person who set it to Thai. So both
 * live in localStorage and both are also URL parameters, which is what makes an
 * English or light-theme view a link you can send.
 */
export function Appearance() {
  const [theme, setTheme] = useTheme();
  const [lang, setLang] = useLang();

  return (
    <section className="mb-8 flex flex-col gap-6">
      <div>
        <p className="eyebrow mb-2">{t("settings.theme")}</p>
        <div className="flex flex-wrap gap-2">
          {THEMES.map((item) => {
            const on = item.id === theme;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTheme(item.id)}
                aria-pressed={on}
                title={item.note}
                className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors"
                style={{
                  borderColor: on ? "var(--color-ember)" : "var(--color-line)",
                  background: on ? "var(--color-ember-soft)" : "transparent",
                }}
              >
                {/* Two swatches — the ground and the accent — because those are
                    the two decisions a theme actually makes, and a single dot
                    cannot show the contrast between them. */}
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full border"
                  style={{ background: item.swatch[0], borderColor: "var(--color-line-bright)" }}
                >
                  <span
                    className="size-2.5 rounded-full"
                    style={{ background: item.swatch[1] }}
                  />
                </span>
                <span className="min-w-0">
                  <span
                    className="block text-sm"
                    style={{ color: on ? "var(--color-ember)" : "var(--color-ink)" }}
                  >
                    {item.label}
                  </span>
                  <span className="meta block truncate">{item.note}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="eyebrow mb-2">{t("lang.label")}</p>
        <div className="flex flex-wrap gap-1.5">
          {LANGS.map((code) => (
            <button
              key={code}
              type="button"
              className="chip"
              aria-pressed={code === lang}
              onClick={() => setLang(code as Lang)}
            >
              {t(code === "th" ? "lang.th" : "lang.en")}
            </button>
          ))}
        </div>
        {/* Said plainly, because it is the one rule that keeps a bilingual corpus
            honest: the container is translated, the contents never are. */}
        <p className="meta mt-2 max-w-lg">{t("settings.langNote")}</p>
      </div>
    </section>
  );
}
