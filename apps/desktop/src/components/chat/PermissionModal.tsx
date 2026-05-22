import { useEffect } from "react";
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
  onRespond: (approved: boolean, remember?: "session") => void;
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
 */
export function PermissionModal({ request, onRespond }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "y") onRespond(true);
      if (e.key === "a") onRespond(true, "session");
      if (e.key === "n") onRespond(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRespond]);

  const preview = request.preview;
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
