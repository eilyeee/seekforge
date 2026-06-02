import { useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { ChatItem } from "../../lib/events";
import { extractDiff } from "../../lib/diff";
import { DiffBlock } from "../DiffBlock";
import { IconChevron } from "../ui";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** TUI-style status dot: ⏺ accent while running, green ok, red error. */
function StatusDot({ status }: { status: ToolItem["status"] }) {
  const cls =
    status === "running" ? "animate-pulse text-accent" : status === "ok" ? "text-ok" : "text-danger";
  return <span className={`${cls} select-none`}>⏺</span>;
}

/** Indented follow-up line with the ⎿ connector, mirroring the TUI. */
function ResultLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2 pl-[3px]">
      <span className="select-none font-mono text-xs leading-5 text-tertiary">⎿</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return (
    <pre className="max-h-60 overflow-auto rounded-lg border border-subtle bg-surface p-2 font-mono text-xs text-secondary">
      {text}
    </pre>
  );
}

/**
 * Tool call row in the TUI's ⏺ / ⎿ visual language: status dot + name on the
 * first line, results indented under a ⎿ connector. Click toggles the raw
 * args / result JSON.
 */
export function ToolRow({ item }: { item: ToolItem }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const diff = item.result?.ok ? extractDiff(item.result.data) : null;

  return (
    <div className="rounded-xl border border-subtle bg-surface-raised px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring group flex w-full items-center gap-2 rounded-lg text-left font-mono text-xs"
      >
        <StatusDot status={item.status} />
        <span className="truncate text-primary">{item.name}</span>
        {item.status === "error" && item.result?.error && (
          // Wrap (don't hard-truncate) when expanded so the full error is
          // readable on touchpad/no-hover; collapsed it stays a single line.
          <span className={`text-danger/80 ${open ? "min-w-0 break-words" : "truncate"}`}>
            {item.result.error.message}
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-tertiary transition-opacity ${
            item.status === "error" ? "opacity-100" : "opacity-60 group-hover:opacity-100"
          }`}
        >
          <IconChevron size={14} className={open ? "rotate-90" : ""} />
        </span>
      </button>

      {open && (
        <ResultLine>
          <div className="space-y-2 py-1">
            {item.args !== undefined && (
              <div>
                <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("chat.tool.args")}</div>
                <Json value={item.args} />
              </div>
            )}
            {item.result !== undefined && (
              <div>
                <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("chat.tool.result")}</div>
                {diff ? <DiffBlock diff={diff} /> : <Json value={item.result} />}
              </div>
            )}
          </div>
        </ResultLine>
      )}

      {/* Live output tail while the command is still running */}
      {item.status === "running" && item.tail !== undefined && (
        <ResultLine>
          <pre className="overflow-x-auto py-0.5 font-mono text-2xs leading-snug text-tertiary">
            {item.tail.replace(/\n+$/, "")}
          </pre>
        </ResultLine>
      )}

      {/* Diffs are important enough to show even when collapsed */}
      {!open && diff && (
        <ResultLine>
          <div className="py-1">
            <DiffBlock diff={diff} />
          </div>
        </ResultLine>
      )}
    </div>
  );
}
