import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge, TextArea } from "../ui";
import type { SlashCommand } from "../../types";

/** Expands a command body, replacing every $ARGUMENTS with the given args. */
export function expandCommand(command: SlashCommand, args: string): string {
  return command.body.split("$ARGUMENTS").join(args);
}

/**
 * Claude-style argument prompt for a parameterized custom slash command: a small
 * modal with the command name, an arguments field, and a live preview of the
 * resulting prompt. Confirm inserts the expanded prompt into the composer.
 */
export function CommandArgsDialog({
  command,
  onSubmit,
  onCancel,
}: {
  command: SlashCommand;
  onSubmit: (expanded: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [args, setArgs] = useState("");
  const preview = expandCommand(command, args || "…");

  // ConfirmDialog's confirm button is autoFocus and mounts after this field, so
  // it would otherwise steal focus. Focus the args field after that initial
  // commit so the user can type immediately.
  const argsRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    argsRef.current?.focus();
  }, []);

  return (
    <ConfirmDialog
      title={`/${command.name}`}
      confirmLabel={t("chat.cmdArgs.insert")}
      onConfirm={() => onSubmit(expandCommand(command, args))}
      onCancel={onCancel}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Badge tone={command.scope === "user" ? "accent" : "ok"}>{command.scope}</Badge>
          {command.description && <span className="text-xs text-tertiary">{command.description}</span>}
        </div>
        <label className="block">
          <span className="mb-1 block text-2xs uppercase tracking-wider text-tertiary">
            {t("chat.cmdArgs.label")}
          </span>
          <TextArea
            ref={argsRef}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter confirms, like the composer.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit(expandCommand(command, args));
            }}
            rows={2}
            placeholder={t("chat.cmdArgs.placeholder")}
            className="w-full"
          />
        </label>
        <div>
          <span className="mb-1 block text-2xs uppercase tracking-wider text-tertiary">
            {t("chat.cmdArgs.preview")}
          </span>
          <pre className="max-h-40 overflow-auto rounded-lg border border-subtle bg-surface-overlay/50 px-3 py-2 text-xs text-secondary whitespace-pre-wrap break-words">
            {preview}
          </pre>
        </div>
      </div>
    </ConfirmDialog>
  );
}
