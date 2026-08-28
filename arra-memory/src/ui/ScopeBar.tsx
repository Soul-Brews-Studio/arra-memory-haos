import { useEffect, useState } from "react";
import { api } from "./api";
import type { AgentFacet, ProjectFacet, WorkspaceFacet } from "./types";
import type { Scope } from "./App";

/**
 * The archive's scope: workspace, then project, then agent.
 *
 * Three selects rather than a page of their own, because scoping is something
 * you do WHILE reading the list — a filter you have to navigate away to change
 * stops being a filter and becomes a mode.
 *
 * The projects list is fetched per workspace rather than held for the whole
 * corpus. That is the hierarchy doing real work: choosing a workspace narrows
 * what the project select can even offer, so the two controls cannot be set to
 * a combination that matches nothing.
 *
 * "All" is a real option in every select and the default in all three. Leaving
 * one alone must never narrow anything — workspace and agent are filters, not
 * boundaries, and a scope you did not choose is not a scope.
 */
export function ScopeBar({
  scope,
  workspaces,
  agents,
  onChange,
  onClear,
}: {
  scope: Scope;
  workspaces: WorkspaceFacet[];
  agents: AgentFacet[];
  onChange: (scope: Scope) => void;
  onClear: () => void;
}) {
  const [projects, setProjects] = useState<ProjectFacet[]>([]);

  useEffect(() => {
    if (!scope.workspace) {
      setProjects([]);
      return;
    }
    let live = true;
    api.workspaces
      .get(scope.workspace)
      .then((r) => live && setProjects(r.projects))
      // A failure here loses the project select, not the archive. The list
      // behind it is already on screen and still correct.
      .catch(() => live && setProjects([]));
    return () => {
      live = false;
    };
  }, [scope.workspace]);

  const active = Boolean(scope.workspace || scope.project || scope.createdBy);

  // Nothing to divide by and nothing selected: the corpus has one undivided
  // pile, and three "all" dropdowns over it are furniture, not a control.
  if (!active && workspaces.length === 0 && agents.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select
        label="Workspace"
        value={scope.workspace}
        allLabel="every workspace"
        options={workspaces.map((w) => ({ value: w.workspace, label: w.workspace, count: w.count }))}
        onChange={(workspace) =>
          // Changing workspace clears project: a project belongs to a workspace,
          // and keeping the old one selected would ask for a pair that does not
          // exist and silently return nothing.
          onChange({ ...scope, workspace, project: "" })
        }
      />

      {scope.workspace && projects.length > 0 && (
        <Select
          label="Project"
          value={scope.project}
          allLabel="every project"
          options={projects.map((p) => ({ value: p.project, label: p.project, count: p.count }))}
          onChange={(project) => onChange({ ...scope, project })}
        />
      )}

      {agents.length > 0 && (
        <Select
          label="Agent"
          value={scope.createdBy}
          allLabel="every agent"
          options={agents.map((a) => ({ value: a.agent, label: a.agent, count: a.count }))}
          onChange={(createdBy) => onChange({ ...scope, createdBy })}
        />
      )}

      {active && (
        <button
          type="button"
          onClick={onClear}
          className="rounded-lg border border-line px-2.5 py-1 font-mono text-[0.68rem] text-dim transition-colors hover:border-ember hover:text-ember"
        >
          clear scope
        </button>
      )}
    </div>
  );
}

function Select({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  allLabel: string;
  options: Array<{ value: string; label: string; count: number }>;
  onChange: (value: string) => void;
}) {
  const id = `scope-${label.toLowerCase()}`;
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="eyebrow">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[14rem] rounded-lg border px-2 py-1 text-sm"
        style={{
          borderColor: value ? "var(--color-ember)" : "var(--color-line)",
          background: value ? "var(--color-ember-soft)" : "var(--color-ground)",
          color: value ? "var(--color-ember)" : "var(--color-dim)",
        }}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label} ({option.count})
          </option>
        ))}
      </select>
    </div>
  );
}
