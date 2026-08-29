import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Panel } from "./Menu";
import { Appearance } from "./Appearance";
import { t } from "./i18n";
import type { SettingsInfo, SettingField } from "./types";

/**
 * The add-on's options, editable where editing them is honest.
 *
 * On Home Assistant OS this deliberately renders READ-ONLY and points at the
 * Configuration tab. Supervisor rewrites its own options on every change, so an
 * edit made here would appear to save and then vanish the next time anyone
 * touched that tab. A form that loses your work is worse than one that declines
 * it, so the server refuses the write and this explains why rather than hiding
 * the fields.
 *
 * Everywhere else — plain Docker, a VPS, a compose stack — this IS the
 * configuration surface, because there is no Supervisor to provide one.
 *
 * Three things are shown that Supervisor's own form does not show, and each
 * exists because its absence caused a real confusion:
 *
 *   · WHERE a value came from. A field showing the right value for the wrong
 *     reason is indistinguishable from a correct one until you change it and
 *     nothing happens.
 *   · WHETHER it is pinned by the environment. Those cannot be changed here,
 *     so they are disabled rather than accepted and silently ignored.
 *   · That a change needs a RESTART. Options take effect at start; implying
 *     otherwise invites "I changed it and it did nothing".
 */
export function Settings({ onClose, nav }: { onClose: () => void; nav?: React.ReactNode }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setInfo(await api.settings.get());
      setDraft({});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const dirty = Object.keys(draft).length > 0;

  async function save() {
    if (!dirty) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.settings.patch(draft);
      setInfo(r);
      setDraft({});
      // Report the ignored keys rather than letting the field sit there showing
      // a value the server will never use.
      const parts: string[] = [];
      if (r.written?.length) parts.push(`Saved ${r.written.length}.`);
      if (r.ignored?.length) parts.push(`Ignored ${r.ignored.join(", ")} — ${r.ignoredReason}.`);
      if (r.restartRequired) parts.push("Restart the add-on for this to take effect.");
      setNote(parts.join(" ") || "Nothing changed.");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title={t("settings.options.title")}
      eyebrow={t("settings.options.eyebrow")}
      subtitle={t("settings.options.subtitle")}
      onClose={onClose}
      nav={nav}
      actions={
        info?.writable ? (
          <>
            <button className="btn" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "…" : t("settings.save")}
            </button>
            {dirty && (
              <button className="btn ghost" disabled={busy} onClick={() => setDraft({})}>
                {t("settings.revert")}
              </button>
            )}
          </>
        ) : null
      }
    >
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}

      {info && !info.writable && (
        // Not an error — this is the correct state on HAOS, and the reason
        // names the place that CAN change these.
        <p className="note warn">{info.reason}</p>
      )}

      {/* Appearance lives HERE, not with the tools. It moved to the tool page
          by accident in 0.24.0 when Settings became the options form — a theme
          is something you set, not a tool you expose to a client. */}
      <Appearance />

      <div className="settings-form">
        {info?.settings.map((f) => (
          <Field
            key={f.key}
            field={f}
            editable={Boolean(info.writable) && !f.pinnedByEnv}
            value={draft[f.key] ?? (f.secret ? "" : f.value)}
            revealed={Boolean(reveal[f.key])}
            onReveal={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
            dirty={f.key in draft}
          />
        ))}
      </div>
    </Panel>
  );
}

function Field({
  field, editable, value, revealed, onReveal, onChange, dirty,
}: {
  field: SettingField;
  editable: boolean;
  value: string;
  revealed: boolean;
  onReveal: () => void;
  onChange: (v: string) => void;
  dirty: boolean;
}) {
  const set = field.value !== "";
  return (
    <label className={`setting${editable ? "" : " locked"}${dirty ? " dirty" : ""}`}>
      <span className="setting-key">
        {field.key}
        {field.pinnedByEnv && (
          // The single most useful thing on this page: it explains why editing
          // would do nothing, instead of letting you find out by trying.
          <em className="pin" title={t("settings.pinned.title")}>{t("settings.pinned")}</em>
        )}
      </span>

      <span className="setting-input">
        <input
          type={field.secret && !revealed ? "password" : "text"}
          value={value}
          disabled={!editable}
          spellCheck={false}
          autoComplete="off"
          // A secret is never sent to the browser, so the box starts empty and
          // its placeholder says whether one is set and how long it is.
          placeholder={field.secret ? (set ? field.value : t("settings.unset")) : t("settings.unset")}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
        {field.secret && editable && (
          <button type="button" className="btn ghost tiny" onClick={onReveal}>
            {revealed ? t("settings.hide") : t("settings.show")}
          </button>
        )}
      </span>

      <span className="setting-meta">
        {t(`settings.source.${field.source}`)}
        {field.restartRequired && <> · {t("settings.restart")}</>}
      </span>
    </label>
  );
}
