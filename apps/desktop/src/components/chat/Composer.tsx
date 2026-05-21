/**
 * Rich composer: slash-command palette, @ file picker (fed by GET
 * /api/files), image paste/drag-drop (POST /api/upload → "[image #N: path]"
 * markers), and per-workspace ↑/↓ input history. All non-DOM logic lives in
 * lib/composer.ts (unit tested); send/queue semantics stay in the store —
 * this component only calls `onSend`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
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
  placeholder: string;
  /** Web-relevant slash commands; actions are the parent's callbacks. */
  commands: ComposerCommand[];
  /** Workspace id this tab is bound to ("" = the server's default). */
  workspaceId: string;
};

const MAX_VISIBLE = 8;
const FILE_QUERY_DEBOUNCE_MS = 150;

/** Maps a pasted blob without a usable filename to an upload name by MIME. */
function uploadName(file: File): string | null {
  if (/\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[
    file.type
  ];
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

export function Composer({ value, onChange, onSend, disabled, placeholder, commands, workspaceId }: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    if (!task || disabled) return;
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
        <div className="absolute bottom-full left-3 right-3 z-10 mb-1 max-h-64 overflow-y-auto rounded border border-strong bg-surface-raised shadow-lg">
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
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {pendingImages.map((marker) => {
            const name = marker.path.split("/").pop() || marker.path;
            return (
              <span
                key={`${marker.n}:${marker.path}`}
                title={marker.path}
                className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-secondary"
              >
                <span aria-hidden className="text-tertiary">
                  🖼
                </span>
                <span className="truncate">
                  #{marker.n} {name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove image #${marker.n}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeImage(marker)}
                  className="ml-0.5 rounded text-tertiary hover:text-danger"
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      )}

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
        className={`w-full resize-none rounded border bg-surface-raised px-3 py-2 text-sm text-primary placeholder:text-tertiary focus:border-accent focus:outline-none disabled:opacity-50 ${
          dragOver ? "border-accent" : "border-strong"
        }`}
      />

      {(uploading > 0 || uploadError) && (
        <div className="mt-1 text-xs">
          {uploading > 0 && <span className="text-tertiary">uploading image…</span>}
          {uploadError && <span className="text-danger">upload failed: {uploadError}</span>}
        </div>
      )}
    </div>
  );
}
