import { useEffect, useState } from "react";
import type { ChatMessage, SessionStatus } from "@seekforge/shared";
import { api } from "../lib/api";
import { messagesToItems } from "../lib/messages";
import { formatUsd } from "../lib/usage";
import { useStore } from "../store";
import { ChatItems } from "../components/chat/ChatItems";
import type { SessionMeta } from "../types";

const STATUS_CHIP: Record<SessionStatus, string> = {
  idle: "bg-zinc-800 text-zinc-300",
  running: "bg-amber-900 text-amber-200",
  waiting_approval: "bg-orange-900 text-orange-200",
  completed: "bg-emerald-900 text-emerald-200",
  failed: "bg-red-900 text-red-200",
  cancelled: "bg-zinc-800 text-zinc-400",
};

type Detail = { meta: SessionMeta; messages: ChatMessage[] };

export function SessionsView() {
  const continueSession = useStore((s) => s.continueSession);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sessions()
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const openSession = (id: string) => {
    setError(null);
    api
      .session(id)
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
          <span className="font-mono text-xs text-zinc-400">{detail.meta.id}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_CHIP[detail.meta.status]}`}>
            {detail.meta.status}
          </span>
          <button
            type="button"
            onClick={() => continueSession(detail.meta, detail.messages)}
            className="ml-auto rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            Continue this session
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <ChatItems items={messagesToItems(detail.messages)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-800 px-4 py-2">
        <h1 className="text-sm font-semibold text-zinc-100">Sessions</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && <div className="mb-3 rounded border border-red-900 bg-red-950/40 p-2 text-xs text-red-300">{error}</div>}
        {sessions === null ? (
          <p className="text-zinc-600">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="text-zinc-600">No sessions yet.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => openSession(s.id)}
                  className="w-full rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left hover:border-zinc-700 hover:bg-zinc-900"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-zinc-500">{s.id}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${STATUS_CHIP[s.status]}`}>
                      {s.status}
                    </span>
                    {s.usage && (
                      <span className="ml-auto font-mono text-xs text-zinc-500">{formatUsd(s.usage.costUsd)}</span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-sm text-zinc-300">{s.task}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
