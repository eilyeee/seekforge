import { useEffect, useState } from "react";
import type { PermissionRequest } from "@seekforge/shared";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { DiffBlock } from "../DiffBlock";

const PERMISSION_TONE: Record<string, BadgeTone> = {
  readonly: "neutral",
  write: "accent",
  execute: "warn",
  env: "warn",
  dangerous: "danger",
};

type Props = {
  request: PermissionRequest;
  /** remember "session" allows this (and similar) for the rest of the session. */
  onRespond: (approved: boolean, remember?: "session", selectedHunks?: number[]) => void;
};

/**
 * Permission prompt. SECURITY: always shows the raw command / path verbatim
 * in monospace — never only the model's paraphrase (prompt-injection defense,
 * see AGENTS.md). Dismissing (Escape / backdrop) counts as deny.
 * Keyboard: y = allow/accept, n = deny/reject (TUI parity).
 *
 * Edit-review: when `request.preview` is present (write tools) the modal renders
 * the proposed diff with Accept / Reject buttons (Reject → onRespond(false) =
 * no write). Non-preview requests keep the plain allow/deny modal.
 *
 * Per-hunk selection: when `request.hunks` has 2+ items, the modal shows a
 * checkbox list of hunks with Apply All / Skip All / Apply Selected buttons.
 * Single-hunk or no hunks preserves the original boolean allow/deny flow.
 */
export function PermissionModal({ request, onRespond }: Props) {
  const [selectedHunks, setSelectedHunks] = useState<Set<number> | null>(null);

  const hunks = request.hunks;
  const multiHunk = hunks && hunks.length >= 2;

  // Reset selection when the request changes (new modal opens).
  useEffect(() => {
    if (multiHunk) {
      // Start with none selected — user must explicitly pick.
      setSelectedHunks(new Set());
    } else {
      setSelectedHunks(null);
    }
  }, [multiHunk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (multiHunk) {
        if (e.key === "a") {
          // Select all hunks and apply.
          setSelectedHunks(new Set(hunks!.map((h) => h.index)));
          onRespond(true, undefined, hunks!.map((h) => h.index));
        }
        if (e.key === "n") onRespond(false);
        if (e.key === "y") {
          const selected = selectedHunks ?? new Set();
          if (selected.size > 0) {
            onRespond(true, undefined, [...selected].sort((a, b) => a - b));
          }
        }
      } else {
        if (e.key === "y") onRespond(true);
        if (e.key === "a") onRespond(true, "session");
        if (e.key === "n") onRespond(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRespond, multiHunk, selectedHunks, hunks]);

  const toggleHunk = (index: number) => {
    setSelectedHunks((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleApplySelected = () => {
    const selected = selectedHunks ?? new Set();
    if (selected.size > 0) {
      onRespond(true, undefined, [...selected].sort((a, b) => a - b));
    }
  };

  const preview = request.preview;

  // Multi-hunk edit review: show per-hunk checkbox list.
  if (multiHunk) {
    const selectedCount = selectedHunks?.size ?? 0;
    return (
      <Modal
        wide
        onDismiss={() => onRespond(false)}
        title={
          <>
            <span>Review {hunks!.length} edits in {preview?.path ?? request.path ?? "unknown"}</span>
            <Badge tone={PERMISSION_TONE[request.permission] ?? "neutral"}>{request.permission}</Badge>
            <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
          </>
        }
        footer={
          <>
            <Button onClick={() => onRespond(false)}>
              Skip all
              <kbd className="rounded bg-surface-overlay px-1 font-mono text-[10px] text-tertiary">n</kbd>
            </Button>
            <Button
              onClick={handleApplySelected}
              disabled={selectedCount === 0}
              variant="primary"
              autoFocus
            >
              Apply selected ({selectedCount}/{hunks!.length})
              {selectedCount > 0 && (
                <kbd className="rounded bg-white/20 px-1 font-mono text-[10px]">y</kbd>
              )}
            </Button>
            <Button
              variant="primary"
              onClick={() => onRespond(true, undefined, hunks!.map((h) => h.index))}
            >
              Apply all
              <kbd className="rounded bg-white/20 px-1 font-mono text-[10px]">a</kbd>
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-secondary">{request.description}</p>

        {preview && (
          <div className="mb-3 rounded-lg border border-subtle bg-surface/50 p-2">
            <DiffBlock diff={preview.diff} />
          </div>
        )}

        <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-tertiary">
          <span>Individual edits</span>
          <button
            className="ml-auto text-[10px] text-accent hover:text-accent-hover disabled:text-tertiary disabled:no-underline"
            disabled={selectedHunks !== null && selectedHunks.size === hunks!.length}
            onClick={() => setSelectedHunks(new Set(hunks!.map((h) => h.index)))}
          >
            Select all
          </button>
        </div>
        <ul className="flex flex-col gap-1.5">
          {hunks!.map((hunk) => {
            const checked = selectedHunks?.has(hunk.index) ?? false;
            return (
              <li key={hunk.index}>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-subtle bg-surface p-2 hover:bg-surface-overlay">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleHunk(hunk.index)}
                    className="mt-0.5 accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-tertiary">
                      Edit #{hunk.index + 1}
                    </div>
                    <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-primary">
                      {hunk.preview}
                    </pre>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </Modal>
    );
  }

  // Single preview: edit review with Accept/Reject buttons.
  if (preview) {
    return (
      <Modal
        wide
        onDismiss={() => onRespond(false)}
        title={
          <>
            <span>Review change: {preview.path}</span>
            <Badge tone={PERMISSION_TONE[request.permission] ?? "neutral"}>{request.permission}</Badge>
            <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
          </>
        }
        footer={
          <>
            <Button onClick={() => onRespond(false)}>
              Reject
              <kbd className="rounded bg-surface-overlay px-1 font-mono text-[10px] text-tertiary">n</kbd>
            </Button>
            <Button variant="primary" onClick={() => onRespond(true)} autoFocus>
              Accept
              <kbd className="rounded bg-white/20 px-1 font-mono text-[10px]">y</kbd>
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-secondary">{request.description}</p>
        <DiffBlock diff={preview.diff} />
      </Modal>
    );
  }

  // Plain permission prompt (no preview).
  return (
    <Modal
      wide
      onDismiss={() => onRespond(false)}
      title={
        <>
          <span>Permission required</span>
          <Badge tone={PERMISSION_TONE[request.permission] ?? "neutral"}>{request.permission}</Badge>
          <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
        </>
      }
      footer={
        <>
          <Button onClick={() => onRespond(false)}>
            Deny
            <kbd className="rounded bg-surface-overlay px-1 font-mono text-[10px] text-tertiary">n</kbd>
          </Button>
          <Button onClick={() => onRespond(true, "session")}>
            Allow for session
            <kbd className="rounded bg-surface-overlay px-1 font-mono text-[10px] text-tertiary">a</kbd>
          </Button>
          <Button variant="primary" onClick={() => onRespond(true)} autoFocus>
            Allow once
            <kbd className="rounded bg-white/20 px-1 font-mono text-[10px]">y</kbd>
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-secondary">{request.description}</p>

      {request.command !== undefined && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-tertiary">raw command</div>
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2.5 font-mono text-xs text-warn">
            {request.command}
          </pre>
        </div>
      )}
      {request.path !== undefined && (
        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-tertiary">raw path</div>
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2.5 font-mono text-xs text-accent-hover">
            {request.path}
          </pre>
        </div>
      )}
    </Modal>
  );
}
