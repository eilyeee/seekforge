import { useState } from "react";
import { api } from "../../lib/api";
import type { ChatItem } from "../../lib/events";
import { isImagePath, splitImageMarkers } from "../../lib/composer";
import { formatTokens, formatUsd } from "../../lib/usage";
import { Markdown } from "../Markdown";
import { PlanCard } from "./PlanCard";
import { ToolRow } from "./ToolRow";
import { IconSparkle, IconChevron, IconCornerDownRight } from "../ui";

/** The styled fallback chip shown for non-image markers or when an <img> fails. */
function ImageChipFallback({ label, path }: { label: string; path: string }) {
  return (
    <span
      title={path}
      className="mx-0.5 inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-subtle bg-surface-raised px-1.5 py-0.5 align-middle font-mono text-xs text-secondary"
    >
      <span aria-hidden className="text-tertiary">
        🖼
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * An `[image #N: path]` marker rendered as a real thumbnail: the raw upload
 * bytes via GET /api/raw, capped at ~200px, click-to-open in a new tab. On a
 * load error (missing file, mock mode) it degrades to the styled chip.
 */
function ImageChip({ n, path }: { n: number; path: string }) {
  const [failed, setFailed] = useState(false);
  const name = path.split("/").pop() || path;
  const src = api.rawUrl(path);
  if (failed) return <ImageChipFallback label={`#${n} ${name}`} path={path} />;
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      title={path}
      className="mx-0.5 inline-block max-w-[200px] align-middle"
    >
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className="max-h-[200px] max-w-[200px] rounded-md border border-subtle object-cover"
      />
    </a>
  );
}

/**
 * A changed/uploaded image file (the `file` chat item) rendered as a real
 * thumbnail with a filename caption, click-to-open, and styled-chip fallback.
 */
function ImageFileChip({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  const name = path.split("/").pop() || path;
  const src = api.rawUrl(path);
  if (failed) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 font-mono text-xs text-secondary">
        <span aria-hidden>🖼</span>
        <span>{path}</span>
      </div>
    );
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" title={path} className="inline-block">
      <img
        src={src}
        alt={name}
        onError={() => setFailed(true)}
        className="max-h-[200px] max-w-[200px] rounded-md border border-subtle object-cover"
      />
      <span className="mt-0.5 block max-w-[200px] truncate font-mono text-xs text-tertiary">{name}</span>
    </a>
  );
}

/**
 * Renders text that may contain `[image #N: path]` markers, turning image
 * markers into chips and leaving the rest as plain text. Whitespace is
 * preserved by the caller's `whitespace-pre-wrap`.
 */
function TextWithImages({ text }: { text: string }) {
  const segments = splitImageMarkers(text);
  if (segments.every((s) => s.kind === "text")) return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "image" ? (
          <ImageChip key={i} n={seg.marker.n} path={seg.marker.path} />
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Streamed chain-of-thought: a dim block, expanded while streaming and
 * collapsed to one line once the answer starts (click toggles).
 */
function ThinkingBlock({ item }: { item: Extract<ChatItem, { kind: "thinking" }> }) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? item.streaming;
  return (
    <div className="rounded border border-subtle bg-surface/40">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-tertiary hover:text-secondary"
      >
        <IconSparkle size={14} className={item.streaming ? "animate-pulse" : ""} />
        <span className="italic">thinking{item.streaming ? "…" : ""}</span>
        <span className="ml-auto text-tertiary">
          <IconChevron size={14} className={open ? "rotate-90" : ""} />
        </span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-subtle px-3 py-2 text-xs italic text-tertiary">
          {item.text}
        </div>
      )}
    </div>
  );
}

function ItemView({ item, onBacktrack }: { item: ChatItem; onBacktrack?: (itemId: number) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="group flex items-start justify-end gap-1.5">
          {onBacktrack && (
            <button
              type="button"
              onClick={() => onBacktrack(item.id)}
              title="Rewind the conversation to just before this message"
              className="mt-1 rounded border border-strong px-1.5 py-0.5 text-xs text-tertiary opacity-0 hover:bg-surface-overlay hover:text-primary group-hover:opacity-100"
            >
              ↺
            </button>
          )}
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg border border-accent/40 bg-accent-muted px-3 py-2 text-primary">
            <TextWithImages text={item.text} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[95%]">
          <Markdown source={item.text} />
          {item.streaming && <span className="ml-0.5 animate-pulse text-accent">▌</span>}
        </div>
      );
    case "thinking":
      return <ThinkingBlock item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "plan":
      return <PlanCard items={item.items} />;
    case "substep":
      return (
        <div className="rounded border border-subtle bg-surface/40 px-3 py-1.5 text-xs">
          <span className="font-mono font-semibold text-secondary">
            <IconCornerDownRight size={14} className="inline-block align-middle" /> {item.agentId}
          </span>
          <span className="ml-2 font-mono text-tertiary">{item.steps.join(" · ")}</span>
        </div>
      );
    case "file": {
      const isImage = isImagePath(item.path) && item.path.includes(".seekforge/uploads/");
      if (isImage) return <ImageFileChip path={item.path} />;
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 font-mono text-xs text-secondary">
          <span aria-hidden>±</span>
          <span>{item.path}</span>
        </div>
      );
    }
    case "compacted":
      return (
        <div className="rounded border border-dashed border-strong px-3 py-1.5 text-center text-xs text-tertiary">
          context compacted — {item.droppedTurns} turns summarized into ~{item.summaryTokens} tokens
        </div>
      );
    case "microcompacted":
      return (
        <div className="rounded border border-dashed border-subtle px-3 py-1 text-center text-xs text-tertiary">
          context micro-compacted — {item.clearedResults} old tool result(s) cleared
        </div>
      );
    case "report":
      return (
        <div className="rounded border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-secondary">
          <span className="font-semibold text-ok">session completed</span>
          {item.report.changedFiles.length > 0 && (
            <span> · {item.report.changedFiles.length} file(s) changed</span>
          )}
          <span>
            {" "}
            · {formatTokens(item.report.usage.promptTokens + item.report.usage.completionTokens)} tokens ·{" "}
            {formatUsd(item.report.usage.costUsd)}
          </span>
          <div className="mt-1 font-mono text-tertiary">{item.report.verification}</div>
        </div>
      );
    case "failed": {
      // Genuine, recoverable failures (not user cancels) get the exact resume
      // command; the loop sets recoverable + sessionId on the error.
      const resumeId = item.error.recoverable ? item.error.sessionId : undefined;
      return (
        <div className="rounded border border-danger/50 bg-danger/10 px-3 py-2 text-sm">
          <span className="font-mono text-xs text-danger">[{item.error.code}]</span>{" "}
          <span className="text-danger">{item.error.message}</span>
          {item.error.hint && <div className="mt-1 text-xs text-danger/80">→ {item.error.hint}</div>}
          {resumeId && (
            <div className="mt-1 text-xs text-danger/80">
              → resume with <span className="font-mono text-danger">/resume {resumeId}</span> (your file
              changes and completed steps are preserved; checkpoints intact)
            </div>
          )}
        </div>
      );
    }
  }
}

/**
 * Shared renderer for live chat and read-only session transcripts.
 * `onBacktrack` (live chat only) puts a ↺ rewind button on every user bubble
 * except the first — turn 0 is the original task and is not backtrackable.
 */
export function ChatItems({
  items,
  onBacktrack,
}: {
  items: ChatItem[];
  onBacktrack?: (itemId: number) => void;
}) {
  const firstUserId = items.find((i) => i.kind === "user")?.id;
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <ItemView
          key={item.id}
          item={item}
          onBacktrack={item.kind === "user" && item.id !== firstUserId ? onBacktrack : undefined}
        />
      ))}
    </div>
  );
}
