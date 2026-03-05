import { useEffect } from "react";
import type { PermissionRequest } from "@seekforge/shared";

const PERMISSION_BADGE: Record<string, string> = {
  readonly: "bg-zinc-700 text-zinc-200",
  write: "bg-sky-900 text-sky-200",
  execute: "bg-amber-900 text-amber-200",
  env: "bg-orange-900 text-orange-200",
  dangerous: "bg-red-900 text-red-200",
};

type Props = {
  request: PermissionRequest;
  onRespond: (approved: boolean) => void;
};

/**
 * Permission prompt. SECURITY: always shows the raw command / path verbatim
 * in monospace — never only the model's paraphrase (prompt-injection defense,
 * see AGENTS.md). Dismissing (Escape / backdrop) counts as deny.
 */
export function PermissionModal({ request, onRespond }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRespond(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRespond]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => onRespond(false)}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">Permission required</span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
              PERMISSION_BADGE[request.permission] ?? PERMISSION_BADGE.readonly
            }`}
          >
            {request.permission}
          </span>
          <span className="ml-auto font-mono text-xs text-zinc-500">{request.toolName}</span>
        </div>

        <p className="mb-3 text-sm text-zinc-300">{request.description}</p>

        {request.command !== undefined && (
          <div className="mb-3">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">raw command</div>
            <pre className="overflow-x-auto rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-amber-300">
              {request.command}
            </pre>
          </div>
        )}
        {request.path !== undefined && (
          <div className="mb-3">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">raw path</div>
            <pre className="overflow-x-auto rounded border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-sky-300">
              {request.path}
            </pre>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onRespond(false)}
            className="rounded border border-zinc-700 px-4 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onRespond(true)}
            className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
