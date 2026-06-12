import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge, TextArea } from "../ui";
import type { SlashCommand } from "../../types";

/** True when the body interpolates args ($ARGUMENTS or positional $1..$9). */
export function commandTakesArgs(body: string): boolean {
  return body.includes("$ARGUMENTS") || /\$[1-9]/.test(body);
}

/** True when the body embeds a !`shell` injection (expanded server-side). */
export function commandHasShell(body: string): boolean {
  return /!`[^`]+`/.test(body);
}

/**
 * Expands a command body: positional `$1`..`$9` from the whitespace-split args,
 * then every `$ARGUMENTS` with the full string. Mirrors core's expandUserCommand.
 */
export function expandCommand(command: SlashCommand, args: string): string {
  const positional = args.trim() === "" ? [] : args.trim().split(/\s+/);
  return command.body
    .replace(/\$([1-9])/g, (_, d: string) => positional[Number(d) - 1] ?? "")
    .split("$ARGUMENTS")
    .join(args);
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
  /** Receives the raw args string; the caller expands (client- or server-side). */
  onSubmit: (args: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [args, setArgs] = useState("");
  const preview = expandCommand(command, args || "…");
  const hasShell = commandHasShell(command.body);

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
      onConfirm={() => onSubmit(args)}
      onCancel={onCancel}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={command.scope === "user" ? "accent" : "ok"}>{command.scope}</Badge>
          {command.model && <Badge tone="neutral">{command.model}</Badge>}
          {command.allowedTools && command.allowedTools.length > 0 && (
            <Badge tone="neutral">{command.allowedTools.length} tools</Badge>
          )}
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
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit(args);
            }}
            rows={2}
            placeholder={command.argumentHint || t("chat.cmdArgs.placeholder")}
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
          {hasShell && <p className="mt-1 text-2xs text-tertiary">{t("chat.cmdArgs.shellHint")}</p>}
        </div>
      </div>
    </ConfirmDialog>
  );
}
