import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import type { Skill, SkillScope } from "../types";

const SCOPE_CHIP: Record<SkillScope, string> = {
  builtin: "bg-zinc-800 text-zinc-300",
  global: "bg-sky-900 text-sky-200",
  project: "bg-emerald-900 text-emerald-200",
};

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);

  useEffect(() => {
    setSkills(null);
    setDetail(null);
    api
      .skills()
      .then(setSkills)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

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
          <span className="font-mono text-xs text-zinc-400">{detail.id}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${SCOPE_CHIP[detail.scope]}`}>
            {detail.scope}
          </span>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <Markdown source={detail.content ?? "*no SKILL.md content*"} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Skills</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
        {skills === null ? (
          <p className="text-zinc-600">Loading…</p>
        ) : skills.length === 0 ? (
          <p className="text-zinc-600">No skills found.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="px-2 py-1.5">id</th>
                <th className="px-2 py-1.5">scope</th>
                <th className="px-2 py-1.5">description</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr
                  key={skill.id}
                  onClick={() => {
                    setError(null);
                    api
                      .skill(skill.id)
                      .then(setDetail)
                      .catch((e: unknown) => setError(String(e)));
                  }}
                  className="cursor-pointer border-b border-zinc-800/60 hover:bg-zinc-900"
                >
                  <td className="px-2 py-2 font-mono text-xs text-zinc-300">{skill.id}</td>
                  <td className="px-2 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${SCOPE_CHIP[skill.scope]}`}>
                      {skill.scope}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-zinc-400">{skill.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
