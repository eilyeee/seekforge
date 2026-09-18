import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import type { PermissionRequest, PermissionRule } from "@seekforge/shared";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { TextArea } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { DiffBlock } from "../DiffBlock";
import { Markdown } from "../Markdown";

/** The rule verbatim — the same shape the CLI and TUI print, never a paraphrase. */
function describeRule(rule: PermissionRule): string {
  return rule.match === undefined ? `${rule.action} ${rule.tool}` : `${rule.action} ${rule.tool}: ${rule.match}`;
}

const PERMISSION_TONE: Record<string, BadgeTone> = {
  readonly: "neutral",
  write: "accent",
  execute: "warn",
  env: "warn",
  dangerous: "danger",
};

/** The tool whose approval request carries a plan to review rather than an action. */
export const EXIT_PLAN_TOOL = "exit_plan_mode";

/** The plan a plan-approval request carries: its preview text, else its description. */
export function planTextOf(request: PermissionRequest): string | null {
  if (request.toolName !== EXIT_PLAN_TOOL) return null;
  return request.preview?.diff || request.description;
}

/** Descriptions long enough to need their own scroll area are rendered as Markdown. */
export function isLongDescription(text: string): boolean {
  return text.length > 280 || text.includes("\n");
}

type Props = {
  request: PermissionRequest;
  /**
   * remember "session" allows this (and similar) for the rest of the run;
   * "always" also writes `request.rememberRule` to the server account's config.
   * `feedback` accompanies a refusal and is handed to the model.
   */
  onRespond: (approved: boolean, remember?: "session" | "always", selectedHunks?: number[], feedback?: string) => void;
};

/**
 * A refusal with an explanation. Collapsed to a single button until opened;
 * the reason travels with the denial so the model can adjust instead of
 * guessing why it was stopped.
 */
function DenyWithReason({
  open,
  reason,
  label,
  onOpen,
  onReason,
  onSubmit,
  alwaysOpen = false,
}: {
  open: boolean;
  reason: string;
  label: string;
  onOpen: () => void;
  onReason: (text: string) => void;
  onSubmit: () => void;
  alwaysOpen?: boolean;
}) {
  const t = useT();
  if (!open && !alwaysOpen) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="focus-ring mt-3 rounded text-2xs text-accent hover:text-accent-hover"
      >
        {label}
      </button>
    );
  }
  return (
    <div className="mt-3">
      <label className="mb-1 block text-2xs uppercase tracking-wider text-tertiary" htmlFor="permission-deny-reason">
        {t("chat.permission.reasonLabel")}
      </label>
      <TextArea
        id="permission-deny-reason"
        value={reason}
        rows={2}
        maxLength={4000}
        autoFocus={!alwaysOpen}
        placeholder={t("chat.permission.reasonPlaceholder")}
        onChange={(e) => onReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="text-xs"
      />
      {!alwaysOpen && (
        <div className="mt-1.5 flex justify-end">
          <Button size="sm" variant="danger" onClick={onSubmit}>
            {t("chat.permission.denyWithReasonSubmit")}
          </Button>
        </div>
      )}
    </div>
  );
}

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
 *
 * Plan review: an `exit_plan_mode` request shows its plan as Markdown with
 * Approve / Keep planning, and the reason box open.
 *
 * "Allow for session" / "Always allow" appear only when core says the answer
 * may be remembered (`sessionGrantable !== false`; `rememberRule` present).
 */
export function PermissionModal({ request, onRespond }: Props) {
  const tModal = useT();
  const [selectedHunks, setSelectedHunks] = useState<Set<number> | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const reason = reasonText ?? "";

  const hunks = request.hunks;
  const multiHunk = hunks && hunks.length >= 2;
  const plan = planTextOf(request);
  const grantable = request.sessionGrantable !== false && plan === null;

  // Reset selection when the request changes (new modal opens).
  useEffect(() => {
    if (multiHunk) {
      // Start with none selected — user must explicitly pick.
      setSelectedHunks(new Set());
    } else {
      setSelectedHunks(null);
    }
    setReasonOpen(false);
    setReasonText("");
  }, [multiHunk, request]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (multiHunk) {
        if (e.key === "a") {
          // Select all hunks and apply.
          setSelectedHunks(new Set(hunks!.map((h) => h.index)));
          onRespond(
            true,
            undefined,
            hunks!.map((h) => h.index),
          );
        }
        if (e.key === "n") onRespond(false);
        if (e.key === "y") {
          const selected = selectedHunks ?? new Set();
          if (selected.size > 0) {
            onRespond(
              true,
              undefined,
              [...selected].sort((a, b) => a - b),
            );
          }
        }
      } else {
        if (e.key === "y") onRespond(true);
        if (e.key === "a" && grantable) onRespond(true, "session");
        if (e.key === "n") onRespond(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRespond, multiHunk, selectedHunks, hunks, grantable]);

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
      onRespond(
        true,
        undefined,
        [...selected].sort((a, b) => a - b),
      );
    }
  };

  const deny = () => onRespond(false, undefined, undefined, reason.trim() === "" ? undefined : reason);
  const reasonField = (label: string, alwaysOpen = false) => (
    <DenyWithReason
      open={reasonOpen === true}
      reason={reason}
      label={label}
      onOpen={() => setReasonOpen(true)}
      onReason={setReasonText}
      onSubmit={deny}
      alwaysOpen={alwaysOpen}
    />
  );

  const preview = request.preview;

  const description = isLongDescription(request.description) ? (
    <div className="mb-3 max-h-48 overflow-y-auto rounded-lg border border-subtle bg-surface/50 p-2.5 text-sm text-secondary">
      <Markdown source={request.description} />
    </div>
  ) : (
    <p className="mb-3 text-sm text-secondary">{request.description}</p>
  );
  const approvalNotice = (() => {
    const key =
      request.approvalReason === "policy_rule"
        ? "chat.permission.policyRule"
        : request.approvalReason === "hook"
          ? "chat.permission.hook"
          : request.approvalReason === "sandbox_escalation"
            ? "chat.permission.sandboxEscalation"
            : request.approvalReason === "plan"
              ? "chat.permission.plan"
              : request.permission === "env"
                ? "chat.permission.autoException"
                : null;
    if (key === null) return null;
    const danger = request.approvalReason === "sandbox_escalation";
    return (
      <p
        className={`mb-3 rounded-lg border p-2 text-xs text-secondary ${
          danger ? "border-danger/40 bg-danger/10" : "border-warn/30 bg-warn/10"
        }`}
      >
        {tModal(key)}
      </p>
    );
  })();

  // Plan review: the plan is the request.
  if (plan !== null) {
    return (
      <Modal
        wide
        onDismiss={() => onRespond(false)}
        title={
          <>
            <span>{tModal("chat.permission.reviewPlan")}</span>
            <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
          </>
        }
        footer={
          <>
            <Button onClick={deny}>
              {tModal("chat.permission.keepPlanning")}
              <kbd className="rounded bg-surface-overlay px-1 font-mono text-2xs text-tertiary">n</kbd>
            </Button>
            <Button variant="primary" onClick={() => onRespond(true)} autoFocus>
              {tModal("chat.permission.approvePlan")}
              <kbd className="rounded bg-white/20 px-1 font-mono text-2xs">y</kbd>
            </Button>
          </>
        }
      >
        {approvalNotice}
        <div className="max-h-[55vh] overflow-y-auto rounded-lg border border-subtle bg-surface/50 p-3 text-sm leading-relaxed text-secondary">
          <Markdown source={plan} />
        </div>
        {reasonField(tModal("chat.permission.denyWithReason"), true)}
      </Modal>
    );
  }

  // Multi-hunk edit review: show per-hunk checkbox list.
  if (multiHunk) {
    const selectedCount = selectedHunks?.size ?? 0;
    return (
      <Modal
        wide
        onDismiss={() => onRespond(false)}
        title={
          <>
            <span>
              {tModal("chat.permission.reviewEdits", {
                count: hunks!.length,
                path: preview?.path ?? request.path ?? tModal("chat.permission.reviewEditsFallback"),
              })}
            </span>
            <Badge tone={PERMISSION_TONE[request.permission] ?? "neutral"}>{request.permission}</Badge>
            <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
          </>
        }
        footer={
          <>
            <Button onClick={deny}>
              {tModal("chat.permission.skipAll")}
              <kbd className="rounded bg-surface-overlay px-1 font-mono text-2xs text-tertiary">n</kbd>
            </Button>
            <Button onClick={handleApplySelected} disabled={selectedCount === 0} variant="primary" autoFocus>
              {tModal("chat.permission.applySelected", { selected: selectedCount, total: hunks!.length })}
              {selectedCount > 0 && <kbd className="rounded bg-white/20 px-1 font-mono text-2xs">y</kbd>}
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                onRespond(
                  true,
                  undefined,
                  hunks!.map((h) => h.index),
                )
              }
            >
              {tModal("chat.permission.applyAll")}
              <kbd className="rounded bg-white/20 px-1 font-mono text-2xs">a</kbd>
            </Button>
          </>
        }
      >
        {description}
        {approvalNotice}

        {preview && (
          <div className="mb-3 rounded-lg border border-subtle bg-surface/50 p-2">
            <DiffBlock diff={preview.diff} />
          </div>
        )}

        <div className="mb-1 flex items-center gap-2 text-2xs uppercase tracking-wider text-tertiary">
          <span>{tModal("chat.permission.individualEdits")}</span>
          <button
            type="button"
            className="focus-ring ml-auto rounded text-2xs text-accent hover:text-accent-hover disabled:text-tertiary disabled:no-underline"
            disabled={selectedHunks !== null && selectedHunks.size === hunks!.length}
            onClick={() => setSelectedHunks(new Set(hunks!.map((h) => h.index)))}
          >
            {tModal("chat.permission.selectAll")}
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
                    <div className="font-mono text-2xs text-tertiary">
                      {tModal("chat.permission.editNumber", { n: hunk.index + 1 })}
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
        {reasonField(tModal("chat.permission.rejectWithReason"))}
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
            <span>{tModal("chat.permission.reviewChange", { path: preview.path })}</span>
            <Badge tone={PERMISSION_TONE[request.permission] ?? "neutral"}>{request.permission}</Badge>
            <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
          </>
        }
        footer={
          <>
            <Button onClick={deny}>
              {tModal("chat.permission.reject")}
              <kbd className="rounded bg-surface-overlay px-1 font-mono text-2xs text-tertiary">n</kbd>
            </Button>
            <Button variant="primary" onClick={() => onRespond(true)} autoFocus>
              {tModal("chat.permission.accept")}
              <kbd className="rounded bg-white/20 px-1 font-mono text-2xs">y</kbd>
            </Button>
          </>
        }
      >
        {description}
        {approvalNotice}
        <DiffBlock diff={preview.diff} />
        {reasonField(tModal("chat.permission.rejectWithReason"))}
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
          <span>{tModal("chat.permission.permissionRequired")}</span>
          <Badge tone={PERMISSION_TONE[request.permission] ?? "neutral"}>{request.permission}</Badge>
          <span className="ml-auto font-mono text-xs font-normal text-tertiary">{request.toolName}</span>
        </>
      }
      footer={
        <>
          <Button onClick={deny}>
            {tModal("chat.permission.deny")}
            <kbd className="rounded bg-surface-overlay px-1 font-mono text-2xs text-tertiary">n</kbd>
          </Button>
          {grantable && (
            <Button onClick={() => onRespond(true, "session")}>
              {tModal("chat.permission.allowSession")}
              <kbd className="rounded bg-surface-overlay px-1 font-mono text-2xs text-tertiary">a</kbd>
            </Button>
          )}
          {/* Offered only when core proposed a rule. A frontend must never
              invent one: the text below IS what gets written. */}
          {grantable && request.rememberRule && (
            <Button onClick={() => onRespond(true, "always")} title={describeRule(request.rememberRule)}>
              {tModal("chat.permission.allowAlways")}
            </Button>
          )}
          <Button variant="primary" onClick={() => onRespond(true)} autoFocus>
            {tModal("chat.permission.allowOnce")}
            <kbd className="rounded bg-white/20 px-1 font-mono text-2xs">y</kbd>
          </Button>
        </>
      }
    >
      {description}
      {approvalNotice}

      {grantable && request.rememberRule && (
        <div className="mb-3">
          <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">
            {tModal("chat.permission.rememberRuleLabel")}
          </div>
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2.5 font-mono text-xs text-secondary">
            {describeRule(request.rememberRule)}
          </pre>
        </div>
      )}
      {request.command !== undefined && (
        <div className="mb-3">
          <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">
            {tModal("chat.permission.rawCommand")}
          </div>
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2.5 font-mono text-xs text-warn">
            {request.command}
          </pre>
        </div>
      )}
      {request.path !== undefined && (
        <div className="mb-3">
          <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">
            {tModal("chat.permission.rawPath")}
          </div>
          <pre className="overflow-x-auto rounded-lg border border-subtle bg-surface p-2.5 font-mono text-xs text-accent-hover">
            {request.path}
          </pre>
        </div>
      )}
      {!grantable && <p className="mb-1 text-2xs text-tertiary">{tModal("chat.permission.notGrantable")}</p>}
      {reasonField(tModal("chat.permission.denyWithReason"))}
    </Modal>
  );
}
