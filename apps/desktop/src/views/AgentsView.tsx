import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Markdown } from "../components/Markdown";
import type { AgentInfo, AgentScope } from "../types";

const SCOPE_CHIP: Record<AgentScope, string> = {
  builtin: "bg-zinc-800 text-zinc-300",
  global: "bg-sky-900 text-sky-200",
  project: "bg-emerald-900 text-emerald-200",
};

function ModeChip({ mode }: { mode: AgentInfo["mode"] }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
        mode === "ask" ? "bg-violet-900 text-violet-200" : "bg-amber-900 text-amber-200"
      }`}
    >
      {mode === "ask" ? "read-only" : "edit"}
    </span>
  );
}

function ScopeChip({ scope }: { scope: AgentScope }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${SCOPE_CHIP[scope]}`}>{scope}</span>;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="font-mono text-xs text-zinc-300">{value}</div>
    </div>
  );
}

export function AgentsView() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [detail, setDetail] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .agents()
      .then(setAgents)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const openAgent = (id: string) => {
    setError(null);
    api
      .agent(id)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)));
  };

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2">
          <button
            type="button"
            onClick={() => setDetail(null)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            ← Back
          </button>
          <span className="text-sm font-semibold text-zinc-100">{detail.name}</span>
          <span className="font-mono text-xs text-zinc-500">{detail.id}</span>
          <ScopeChip scope={detail.scope} />
          <ModeChip mode={detail.mode} />
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-2xl space-y-4">
            <p className="text-sm text-zinc-300">{detail.description}</p>
            <div className="grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900/60 p-3">
              <Field label="model" value={detail.model ?? "(default)"} />
              <Field label="max turns" value={String(detail.maxTurns ?? 15)} />
              <Field label="triggers" value={detail.triggers.join(", ") || "—"} />
              <Field label="tools" value={detail.tools?.join(", ") ?? "all tools"} />
              {detail.own && <Field label="owns" value={detail.own} />}
              {detail.doNotTouch && <Field label="do not touch" value={detail.doNotTouch} />}
              {detail.boundary && <Field label="boundary" value={detail.boundary} />}
            </div>
            {detail.body && (
              <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-300">
                <Markdown source={detail.body} />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Agents</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
        {agents === null ? (
          <p className="text-zinc-600">Loading…</p>
        ) : agents.length === 0 ? (
          <p className="text-zinc-600">No agents configured.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-2 py-1.5">id</th>
                <th className="px-2 py-1.5">scope</th>
                <th className="px-2 py-1.5">mode</th>
                <th className="px-2 py-1.5">model</th>
                <th className="px-2 py-1.5">description</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr
                  key={a.id}
                  onClick={() => openAgent(a.id)}
                  className="cursor-pointer border-b border-zinc-800/60 hover:bg-zinc-900"
                >
                  <td className="px-2 py-2 font-mono text-xs text-zinc-200">{a.id}</td>
                  <td className="px-2 py-2">
                    <ScopeChip scope={a.scope} />
                  </td>
                  <td className="px-2 py-2">
                    <ModeChip mode={a.mode} />
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-zinc-400">{a.model ?? "—"}</td>
                  <td className="max-w-md truncate px-2 py-2 text-xs text-zinc-400">{a.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
