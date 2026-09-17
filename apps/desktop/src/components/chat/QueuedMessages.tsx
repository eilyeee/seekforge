import { useState } from "react";
import { useT } from "../../lib/i18n";
import type { QueuedMessage } from "../../lib/tabs";
import { Button, TextArea } from "../ui";

type Props = {
  queue: QueuedMessage[];
  /** Held after an interrupted run until the user resumes. */
  paused?: boolean;
  onResume?: () => void;
  onEdit: (id: number, text: string) => void;
  onRemove: (id: number) => void;
};

/**
 * Messages typed while a run is active. Each one goes out as the next turn,
 * oldest first, once the run ends; until then it can be edited or dropped.
 */
export function QueuedMessages({ queue, paused = false, onResume, onEdit, onRemove }: Props) {
  const t = useT();
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  if (queue.length === 0) return null;
  return (
    <section aria-label={t("chat.queue.label")} className="border-t border-subtle px-3 pt-2">
      <div className="mb-1 flex items-center gap-2 text-2xs uppercase tracking-wider text-tertiary">
        <span>{t("chat.queue.title", { count: queue.length })}</span>
        <span className="normal-case tracking-normal">
          {paused ? t("chat.queue.pausedHint") : t("chat.queue.hint")}
        </span>
        {paused && onResume && (
          <Button size="sm" variant="primary" className="ml-auto normal-case tracking-normal" onClick={onResume}>
            {t("chat.queue.resume")}
          </Button>
        )}
      </div>
      <ol className="space-y-1">
        {queue.map((message, index) => (
          <li
            key={message.id}
            className="flex items-start gap-2 rounded-lg border border-subtle bg-surface-raised px-2 py-1.5 text-xs"
          >
            <span className="mt-0.5 font-mono text-2xs text-tertiary">{index + 1}</span>
            {editing?.id === message.id ? (
              <div className="min-w-0 flex-1">
                <TextArea
                  value={editing.text}
                  rows={2}
                  autoFocus
                  aria-label={t("chat.queue.editLabel")}
                  onChange={(e) => setEditing({ id: message.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      onEdit(message.id, editing.text);
                      setEditing(null);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(null);
                    }
                  }}
                  className="text-xs"
                />
                <div className="mt-1 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      onEdit(message.id, editing.text);
                      setEditing(null);
                    }}
                  >
                    {t("chat.queue.save")}
                  </Button>
                  <Button size="sm" onClick={() => setEditing(null)}>
                    {t("action.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-secondary">{message.text}</p>
                <button
                  type="button"
                  onClick={() => setEditing({ id: message.id, text: message.text })}
                  className="focus-ring rounded px-1 text-2xs text-accent hover:text-accent-hover"
                >
                  {t("chat.queue.edit")}
                </button>
                <button
                  type="button"
                  aria-label={t("chat.queue.remove")}
                  title={t("chat.queue.remove")}
                  onClick={() => onRemove(message.id)}
                  className="focus-ring rounded px-1 text-tertiary hover:text-danger"
                >
                  ×
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
