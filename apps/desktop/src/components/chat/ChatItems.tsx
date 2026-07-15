import { useState } from "react";
import { useT } from "../../lib/i18n";
import { api } from "../../lib/api";
import type { ChatItem } from "../../lib/events";
import { teamLayers } from "../../lib/team";
import { isImagePath, splitImageMarkers } from "../../lib/composer";
import { formatTokens, formatUsd } from "../../lib/usage";
import { Markdown } from "../Markdown";
import { PlanCard } from "./PlanCard";
import { ToolRow } from "./ToolRow";
import { Badge, Button, IconArrowRight, IconSparkle, IconChevron, IconCornerDownRight, Input } from "../ui";

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
  const t = useT();
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? item.streaming;
  return (
    <div className="rounded-xl border border-subtle bg-surface-raised">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        className="focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-tertiary hover:text-secondary"
      >
        <IconSparkle size={14} className={item.streaming ? "animate-pulse text-accent" : ""} />
        <span className="italic">{item.streaming ? t("chat.thinking.streaming") : t("chat.thinking")}</span>
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

function SubagentBlock({
  item,
  onSteer,
  onCancel,
}: {
  item: Extract<ChatItem, { kind: "subagent" }>;
  onSteer?: (dispatchId: string, message: string) => void;
  onCancel?: (dispatchId: string) => void;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const running = item.status === "running";
  const send = () => {
    const trimmed = message.trim();
    if (!trimmed || !onSteer) return;
    onSteer(item.dispatchId, trimmed);
    setMessage("");
  };
  const tone = item.status === "done" ? "ok" : item.status === "failed" ? "danger" : item.status === "cancelled" ? "warn" : "accent";
  return (
    <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2.5 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <IconCornerDownRight size={14} className="shrink-0 text-tertiary" />
        <span className="truncate font-mono font-semibold text-secondary">{item.agentId}</span>
        <span className="font-mono text-2xs text-tertiary">{item.dispatchId}</span>
        <Badge tone={tone}>{t(`chat.subagent.status.${item.status}`)}</Badge>
        {running && onCancel && (
          <Button
            variant="danger"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => onCancel(item.dispatchId)}
            title={t("chat.subagent.cancelTitle")}
          >
            {t("chat.subagent.cancel")}
          </Button>
        )}
      </div>
      <p className="mt-1.5 break-words text-secondary">{item.task}</p>
      {item.subSessionId && <div className="mt-1 font-mono text-2xs text-tertiary">{item.subSessionId}</div>}
      {item.steps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.steps.map((step, index) => (
            <span key={`${index}-${step}`} className="rounded border border-subtle bg-surface px-1.5 py-0.5 font-mono text-2xs text-tertiary">
              {step}
            </span>
          ))}
        </div>
      )}
      {item.resultSummary && (
        <div className={`mt-2 whitespace-pre-wrap border-l-2 pl-2 ${item.status === "failed" ? "border-danger text-danger" : "border-strong text-secondary"}`}>
          {item.resultSummary}
        </div>
      )}
      {item.error && <div className="mt-1 font-mono text-2xs text-danger">[{item.error.code}] {item.error.message}</div>}
      {item.control && (
        <div className="mt-1 font-mono text-2xs text-ok">
          {t(`chat.subagent.${item.control.operation}Accepted`)}
        </div>
      )}
      {running && onSteer && (
        <div className="mt-2 flex items-center gap-1.5">
          <Input
            value={message}
            maxLength={4000}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={t("chat.subagent.steerPlaceholder")}
            aria-label={t("chat.subagent.steerPlaceholder")}
            className="h-8 min-w-0 text-xs"
          />
          <Button size="sm" onClick={send} disabled={!message.trim()} title={t("chat.subagent.steerTitle")}>
            <IconArrowRight size={14} />
            {t("chat.subagent.steer")}
          </Button>
        </div>
      )}
    </div>
  );
}

function TeamBlock({ item }: { item: Extract<ChatItem, { kind: "team" }> }) {
  const t = useT();
  const [mode, setMode] = useState<"list" | "dag">("list");
  const tone = item.status === "done" ? "ok" : item.status === "failed" ? "danger" : item.status === "cancelled" ? "warn" : "accent";
  const memberRow = (member: typeof item.members[number]) => {
    const memberTone = member.status === "done" ? "ok" : member.status === "failed" ? "danger" : member.status === "cancelled" || member.status === "skipped" ? "warn" : member.status === "running" ? "accent" : "neutral";
    return (
      <div key={member.id} className="min-w-0 rounded-md border border-subtle bg-surface px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono font-semibold text-secondary">{member.id}</span>
          <span className="truncate font-mono text-2xs text-tertiary">{member.agentId}</span>
          <Badge tone={memberTone}>{member.status}</Badge>
        </div>
        <p className="mt-1 break-words text-secondary">{member.task}</p>
        {member.dependsOn.length > 0 && <p className="mt-1 font-mono text-2xs text-tertiary">{t("chat.team.dependsOn")}: {member.dependsOn.join(", ")}</p>}
        {member.dispatchId && <p className="mt-1 font-mono text-2xs text-tertiary">{member.dispatchId}</p>}
        {member.reason && <p className="mt-1 text-2xs text-warn">{member.reason}</p>}
      </div>
    );
  };
  return (
    <div className="rounded-lg border border-subtle bg-surface-raised px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <IconCornerDownRight size={14} className="text-tertiary" />
        <span className="font-semibold text-primary">{t("chat.team.title")}</span>
        <Badge tone={tone}>{item.status}</Badge>
        <span className="font-mono text-2xs text-tertiary">{t("chat.team.concurrency", { count: item.maxConcurrency })}</span>
        <span className="font-mono text-2xs text-tertiary">{item.failurePolicy}</span>
        <div className="ml-auto inline-flex rounded-md border border-subtle p-0.5">
          <button type="button" className={`rounded px-2 py-0.5 ${mode === "list" ? "bg-surface-overlay text-primary" : "text-tertiary"}`} onClick={() => setMode("list")}>{t("chat.team.list")}</button>
          <button type="button" className={`rounded px-2 py-0.5 ${mode === "dag" ? "bg-surface-overlay text-primary" : "text-tertiary"}`} onClick={() => setMode("dag")}>{t("chat.team.dag")}</button>
        </div>
      </div>
      {mode === "list" ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{item.members.map(memberRow)}</div>
      ) : (
        <div className="mt-2 flex min-w-0 gap-3 overflow-x-auto pb-1">
          {teamLayers(item.members).map((layer, index) => (
            <div key={index} className="w-56 shrink-0 space-y-2">
              <div className="font-mono text-2xs text-tertiary">{t("chat.team.stage", { index: index + 1 })}</div>
              {layer.map(memberRow)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ItemView({
  item,
  onBacktrack,
  onSubagentSteer,
  onSubagentCancel,
}: {
  item: ChatItem;
  onBacktrack?: (itemId: number) => void;
  onSubagentSteer?: (dispatchId: string, message: string) => void;
  onSubagentCancel?: (dispatchId: string) => void;
}) {
  const t = useT();
  switch (item.kind) {
    case "user":
      return (
        <div className="group flex items-start justify-end gap-1.5">
          {onBacktrack && (
            <button
              type="button"
              onClick={() => onBacktrack(item.id)}
              title={t("chat.rewindTitle")}
              className="focus-ring mt-1 rounded-lg border border-subtle px-1.5 py-0.5 text-xs text-tertiary opacity-0 hover:bg-surface-overlay hover:text-primary group-hover:opacity-100"
            >
              ↺
            </button>
          )}
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-accent px-4 py-2.5 text-white shadow-sm">
            <TextWithImages text={item.text} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="max-w-[95%] leading-relaxed text-primary">
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
        <div className="rounded-xl border border-subtle bg-surface-raised px-3 py-2 text-xs">
          <div className="flex items-center gap-1 font-mono font-semibold text-secondary">
            <IconCornerDownRight size={14} className="inline-block align-middle text-tertiary" /> {item.agentId}
          </div>
          <ul className="mt-1 space-y-0.5">
            {item.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-1.5 pl-4 font-mono text-tertiary">
                <span aria-hidden className="text-tertiary/60">•</span>
                <span className="break-all">{step}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "subagent":
      return <SubagentBlock item={item} onSteer={onSubagentSteer} onCancel={onSubagentCancel} />;
    case "team":
      return <TeamBlock item={item} />;
    case "file": {
      const isImage = isImagePath(item.path) && item.path.includes(".seekforge/uploads/");
      if (isImage) return <ImageFileChip path={item.path} />;
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-overlay px-2.5 py-0.5 font-mono text-xs text-secondary">
          <span aria-hidden className="text-tertiary">±</span>
          <span>{item.path}</span>
        </div>
      );
    }
    case "compacted":
      return (
        <div className="rounded-xl border border-dashed border-strong px-3 py-2 text-center text-xs text-tertiary">
          {t("chat.contextCompacted", { droppedTurns: item.droppedTurns, summaryTokens: item.summaryTokens })}
        </div>
      );
    case "microcompacted":
      return (
        <div className="rounded-xl border border-dashed border-subtle px-3 py-1.5 text-center text-xs text-tertiary">
          {t("chat.microCompacted", { clearedResults: item.clearedResults })}
        </div>
      );
    case "notice":
      return (
        <div
          className={`rounded-xl border px-3 py-1.5 text-xs ${
            item.level === "warn"
              ? "border-warn/40 bg-warn/10 text-warn"
              : "border-subtle bg-surface-overlay/50 text-secondary"
          }`}
        >
          {item.message}
        </div>
      );
    case "report":
      return (
        <div className="rounded-xl border border-ok/40 bg-ok/10 px-4 py-3 text-xs text-secondary">
          <div className="flex items-center gap-1.5">
            <span aria-hidden className="text-ok">⏺</span>
            <span className="font-semibold text-ok">{t("chat.sessionCompleted")}</span>
            {item.report.changedFiles.length > 0 && (
              <span className="text-tertiary"> · {t("chat.filesChanged", { n: item.report.changedFiles.length })}</span>
            )}
            <span className="text-tertiary">
              {" "}
              · {formatTokens(item.report.usage.promptTokens + item.report.usage.completionTokens)} {t("chat.tokens")} ·{" "}
              {formatUsd(item.report.usage.costUsd)}
            </span>
          </div>
          <div className="mt-1.5 font-mono text-tertiary">{item.report.verification}</div>
        </div>
      );
    case "failed": {
      // Genuine, recoverable failures (not user cancels) get the exact resume
      // command; the loop sets recoverable + sessionId on the error.
      const resumeId = item.error.recoverable ? item.error.sessionId : undefined;
      return (
        <div className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-sm">
          <span className="font-mono text-xs text-danger">[{item.error.code}]</span>{" "}
          <span className="text-danger">{item.error.message}</span>
          {item.error.hint && <div className="mt-1 text-xs text-danger/80">→ {item.error.hint}</div>}
          {resumeId && (
            <div className="mt-1 text-xs text-danger/80">
              {t("chat.resumeInfo.prefix")} <span className="font-mono text-danger">/resume {resumeId}</span> {t("chat.resumeInfo.suffix")}
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
  onSubagentSteer,
  onSubagentCancel,
}: {
  items: ChatItem[];
  onBacktrack?: (itemId: number) => void;
  onSubagentSteer?: (dispatchId: string, message: string) => void;
  onSubagentCancel?: (dispatchId: string) => void;
}) {
  const firstUserId = items.find((i) => i.kind === "user")?.id;
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <ItemView
          key={item.id}
          item={item}
          onBacktrack={item.kind === "user" && item.id !== firstUserId ? onBacktrack : undefined}
          onSubagentSteer={onSubagentSteer}
          onSubagentCancel={onSubagentCancel}
        />
      ))}
    </div>
  );
}
