/**
 * Rich composer: slash-command palette, @ file picker (fed by GET
 * /api/files), image paste/drag-drop (POST /api/upload → "[image #N: path]"
 * markers), and per-workspace ↑/↓ input history. All non-DOM logic lives in
 * lib/composer.ts (unit tested); send/queue semantics stay in the store —
 * this component only calls `onSend`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { api } from "../../lib/api";
import { IconSparkle } from "../ui/icons";
import {
  atBottomEdge,
  atToken,
  atTopEdge,
  createHistoryNav,
  filterCommands,
  insertAtPath,
  insertImageMarker,
  listImageMarkers,
  loadHistory,
  pushHistory,
  removeImageMarker,
  slashQuery,
  type ComposerCommand,
  type HistoryNav,
} from "../../lib/composer";

export type { ComposerCommand };

export type ComposerProps = {
  value: string;
  onChange: (text: string) => void;
  /** Sends the task (the parent owns the store's send/queue semantics). */
  onSend: (task: string) => void;
  disabled: boolean;
  /**
   * Blocks sending (send button + Enter) without disabling the input, e.g. while
   * the socket is reconnecting. Typing/editing stays enabled so the draft is
   * preserved; `sendBlockedHint` explains why sending is unavailable.
   */
  sendBlocked?: boolean;
  sendBlockedHint?: string;
  placeholder: string;
  /** Web-relevant slash commands; actions are the parent's callbacks. */
  commands: ComposerCommand[];
  /** Workspace id this tab is bound to ("" = the server's default). */
  workspaceId: string;
  /** Thinking-mode toggle surfaced as a composer pill (omit to hide it). */
  thinking?: boolean;
  onToggleThinking?: () => void;
};

const MAX_VISIBLE = 8;
const FILE_QUERY_DEBOUNCE_MS = 150;

/** Shared style for the composer's labeled trigger pills (@ files, / commands). */
const PILL =
  "focus-ring inline-flex items-center gap-1 rounded-lg border border-subtle px-2 py-1 text-xs text-secondary transition-colors hover:bg-surface-overlay hover:text-primary disabled:opacity-50";

/** Maps a pasted blob without a usable filename to an upload name by MIME. */
function uploadName(file: File): string | null {
  if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[file.type];
  return ext ? `pasted.${ext}` : null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL yields "data:<mime>;base64,<data>" — strip the prefix.
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * A pending image attachment: a real thumbnail (GET /api/raw) capped at
 * ~200px with a filename caption, click-to-open, and a removable ✕ (stripping
 * the marker from the text — the send-marker contract is preserved). On an
 * <img> load error it degrades to the styled chip.
 */
function PendingImageChip({
  marker,
  workspaceId,
  onRemove,
}: {
  marker: { n: number; path: string };
  workspaceId: string;
  onRemove: () => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const name = marker.path.split("/").pop() || marker.path;
  const src = api.rawUrl(marker.path, workspaceId);
  const removeButton = (
    <button
      type="button"
      aria-label={t("chat.composer.removeImage", { n: marker.n })}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRemove}
      className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-subtle bg-surface-raised text-xs text-tertiary hover:text-danger"
    >
      ✕
    </button>
  );
  if (failed) {
    return (
      <span
        title={marker.path}
        className="relative inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-secondary"
      >
        <span aria-hidden className="text-tertiary">
          🖼
        </span>
        <span className="truncate">
          #{marker.n} {name}
        </span>
        {removeButton}
      </span>
    );
  }
  return (
    <span className="relative inline-block">
      <a href={src} target="_blank" rel="noopener noreferrer" title={marker.path} className="block">
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          className="max-h-[200px] max-w-[200px] rounded-md border border-subtle object-cover"
        />
        <span className="mt-0.5 block max-w-[200px] truncate font-mono text-xs text-tertiary">{name}</span>
      </a>
      {removeButton}
    </span>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  sendBlocked = false,
  sendBlockedHint,
  placeholder,
  commands,
  workspaceId,
  thinking,
  onToggleThinking,
}: ComposerProps) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  /** Esc dismissed the dropdown; cleared on the next text change. */
  const [dismissed, setDismissed] = useState(false);
  const [sel, setSel] = useState(0);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Latest value for async insertions (uploads resolve after re-renders).
  const valueRef = useRef(value);
  valueRef.current = value;
  // Caret to restore after a programmatic text change.
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => {
    if (pendingCaret.current !== null && textareaRef.current) {
      textareaRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  // History: readline ↑/↓ over the per-workspace localStorage entries. The
  // nav is rebuilt lazily on first ↑ after a send/edit/workspace change.
  const navRef = useRef<HistoryNav | null>(null);
  useEffect(() => {
    navRef.current = null;
  }, [workspaceId]);

  // --- active dropdown ------------------------------------------------------
  const slash = dismissed || disabled ? null : slashQuery(value, caret);
  const at = dismissed || disabled || slash !== null ? null : atToken(value, caret);

  const slashItems = useMemo(
    () => (slash === null ? [] : filterCommands(slash, commands).slice(0, MAX_VISIBLE)),
    [slash, commands],
  );

  // Debounced /api/files fetch for the @ picker.
  const atQuery = at?.query ?? null;
  useEffect(() => {
    if (atQuery === null) {
      setFileResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .files(atQuery, workspaceId)
        .then((res) => {
          if (!cancelled) setFileResults(res.files.slice(0, MAX_VISIBLE));
        })
        .catch(() => {
          if (!cancelled) setFileResults([]);
        });
    }, FILE_QUERY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atQuery, workspaceId]);

  const dropdown: { kind: "slash" | "file"; count: number } | null =
    slash !== null && slashItems.length > 0
      ? { kind: "slash", count: slashItems.length }
      : at !== null && fileResults.length > 0
        ? { kind: "file", count: fileResults.length }
        : null;

  // Clamp/reset the selection whenever the candidate list changes.
  const dropdownSignature = `${dropdown?.kind ?? ""}:${slash ?? ""}:${atQuery ?? ""}`;
  useEffect(() => {
    setSel(0);
  }, [dropdownSignature]);
  const selIndex = dropdown ? Math.min(sel, dropdown.count - 1) : 0;

  // Pending image attachments: the `[image #N: path]` markers currently in the
  // input, surfaced as removable chips. The markers stay in the text (the
  // send-marker contract), so removing a chip just strips its marker.
  const pendingImages = useMemo(() => listImageMarkers(value), [value]);

  // --- actions --------------------------------------------------------------

  const applyChange = (text: string, nextCaret: number) => {
    pendingCaret.current = nextCaret;
    onChange(text);
  };

  const removeImage = (marker: { n: number; path: string }) => {
    const next = removeImageMarker(value, marker);
    applyChange(next, next.length);
  };

  const pickSlash = (index: number) => {
    const cmd = slashItems[index];
    if (!cmd) return;
    onChange("");
    setDismissed(false);
    cmd.run();
  };

  const pickFile = (index: number) => {
    const path = fileResults[index];
    if (!path || !at) return;
    const out = insertAtPath(value, at, caret, path);
    applyChange(out.text, out.caret);
  };

  const send = () => {
    const task = value.trim();
    if (!task || disabled || sendBlocked) return;
    pushHistory(localStorage, workspaceId, task);
    navRef.current = null;
    onSend(task);
  };

  const recallHistory = (dir: "up" | "down"): string | null => {
    if (!navRef.current) {
      if (dir === "down") return null; // nothing below the draft
      navRef.current = createHistoryNav(loadHistory(localStorage, workspaceId));
    }
    return dir === "up" ? navRef.current.up(valueRef.current) : navRef.current.down();
  };

  const uploadImages = async (files: Iterable<File>) => {
    setUploadError(null);
    for (const file of files) {
      const name = uploadName(file);
      if (!name) continue; // not an image we support
      setUploading((n) => n + 1);
      try {
        const dataBase64 = await fileToBase64(file);
        const { path } = await api.upload(name, dataBase64, workspaceId);
        const el = textareaRef.current;
        const pos = el ? el.selectionStart : valueRef.current.length;
        const end = el ? el.selectionEnd : pos;
        const out = insertImageMarker(valueRef.current, pos, end, path);
        applyChange(out.text, out.caret);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  /** Insert a trigger token (/ or @) at the caret and open its palette. */
  const insertToken = (token: string) => {
    if (disabled) return;
    const el = textareaRef.current;
    const start = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : start;
    const before = value.slice(0, start);
    const needsSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsSpace ? " " : "") + token;
    setDismissed(false);
    applyChange(before + insert + value.slice(end), start + insert.length);
    el?.focus();
  };

  const openFilePicker = () => {
    if (!disabled) fileInputRef.current?.click();
  };

  // --- DOM events -----------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return; // IME composition (CJK input)

    if (dropdown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((selIndex + 1) % dropdown.count);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((selIndex - 1 + dropdown.count) % dropdown.count);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        if (dropdown.kind === "slash") pickSlash(selIndex);
        else pickFile(selIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
      return;
    }

    const el = e.currentTarget;
    if (e.key === "ArrowUp" && atTopEdge(value, el.selectionStart)) {
      const recalled = recallHistory("up");
      if (recalled !== null) {
        e.preventDefault();
        applyChange(recalled, recalled.length);
      }
      return;
    }
    if (e.key === "ArrowDown" && atBottomEdge(value, el.selectionEnd)) {
      const recalled = recallHistory("down");
      if (recalled !== null) {
        e.preventDefault();
        applyChange(recalled, recalled.length);
      }
    }
  };

  // Fires on user edits only (programmatic value changes bypass the DOM
  // event), so manual typing restarts history navigation.
  const onTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDismissed(false);
    setCaret(e.target.selectionStart);
    navRef.current = null;
    onChange(e.target.value);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => uploadName(f) !== null);
    if (images.length === 0) return;
    e.preventDefault();
    void uploadImages(images);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    void uploadImages(e.dataTransfer.files);
  };

  return (
    <div
      className="relative border-t border-subtle p-3"
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {dropdown && (
        <div className="absolute bottom-full left-3 right-3 z-10 mb-1 max-h-64 overflow-y-auto rounded-lg border border-strong bg-surface-raised shadow-lg">
          {dropdown.kind === "slash"
            ? slashItems.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep the textarea focused
                    pickSlash(i);
                  }}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs ${
                    i === selIndex ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay"
                  }`}
                >
                  <span className="font-mono">/{cmd.name}</span>
                  <span className="truncate text-tertiary">{cmd.hint}</span>
                </button>
              ))
            : fileResults.map((path, i) => (
                <button
                  key={path}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickFile(i);
                  }}
                  className={`block w-full truncate px-3 py-1.5 text-left font-mono text-xs ${
                    i === selIndex ? "bg-surface-overlay text-primary" : "text-secondary hover:bg-surface-overlay"
                  }`}
                >
                  {path}
                </button>
              ))}
        </div>
      )}

      {pendingImages.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-2">
          {pendingImages.map((marker) => (
            <PendingImageChip
              key={`${marker.n}:${marker.path}`}
              marker={marker}
              workspaceId={workspaceId}
              onRemove={() => removeImage(marker)}
            />
          ))}
        </div>
      )}

      <div
        className={`flex flex-col rounded-xl border bg-surface-raised transition-colors focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40 ${
          dragOver ? "border-accent" : "border-strong"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          disabled={disabled}
          placeholder={placeholder}
          rows={3}
          className="w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-primary placeholder:text-tertiary focus:outline-none"
        />

        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
          <button
            type="button"
            onClick={() => insertToken("@")}
            disabled={disabled}
            title={t("chat.composer.mention")}
            className={PILL}
          >
            <span className="font-mono text-accent">@</span>
            {t("chat.composer.fileLabel")}
          </button>
          <button
            type="button"
            onClick={() => insertToken("/")}
            disabled={disabled}
            title={t("chat.composer.slash")}
            className={PILL}
          >
            <span className="font-mono text-accent">/</span>
            {t("chat.composer.cmdLabel")}
          </button>
          {onToggleThinking && (
            <button
              type="button"
              onClick={onToggleThinking}
              disabled={disabled}
              aria-pressed={thinking}
              title={t("chat.composer.thinkLabel")}
              className={`focus-ring inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors disabled:opacity-50 ${
                thinking
                  ? "border-accent/60 bg-accent-muted text-accent-hover"
                  : "border-subtle text-secondary hover:bg-surface-overlay hover:text-primary"
              }`}
            >
              <IconSparkle size={13} />
              {t("chat.composer.thinkLabel")}
            </button>
          )}

          {(uploading > 0 || uploadError) && (
            <span className="ml-1 truncate text-2xs">
              {uploading > 0 && <span className="text-tertiary">{t("chat.composer.uploading")}</span>}
              {uploadError && (
                <span className="text-danger">{t("chat.composer.uploadFailed", { error: uploadError })}</span>
              )}
            </span>
          )}

          {sendBlocked && sendBlockedHint ? (
            <span className="ml-auto truncate pr-1 text-2xs text-warn" title={sendBlockedHint}>
              {sendBlockedHint}
            </span>
          ) : (
            <span className="ml-auto hidden pr-1 text-2xs text-tertiary sm:inline">{t("chat.composer.sendHint")}</span>
          )}
          <button
            type="button"
            onClick={openFilePicker}
            disabled={disabled}
            title={t("chat.composer.attach")}
            aria-label={t("chat.composer.attach")}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg border border-subtle text-tertiary hover:bg-surface-overlay hover:text-secondary disabled:opacity-50"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            type="button"
            onClick={send}
            disabled={disabled || sendBlocked || value.trim().length === 0}
            title={sendBlocked && sendBlockedHint ? sendBlockedHint : t("chat.composer.send")}
            aria-label={t("chat.composer.send")}
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void uploadImages(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
