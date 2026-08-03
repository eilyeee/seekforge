import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

/** Answer sent when the user dismisses the question without picking an option. */
export const DECLINED_ANSWER = "(the user declined to answer)";

type Props = {
  question: string;
  options: string[];
  /** The user may type an answer instead of picking one of `options`. */
  freeText?: boolean;
  onAnswer: (answer: string) => void;
};

/**
 * ask_user question prompt (question.request frame), mirroring the
 * PermissionModal layout: the options render as buttons; dismissing
 * (Escape / backdrop) answers with the declined sentinel so the agent
 * is never left blocked. Keyboard: 1-9 pick an option (TUI parity).
 *
 * An open question (`freeText`) also gets a text field, focused on open, for a
 * value only the user has. The options stay: they are how the user declines.
 */
export function QuestionModal({ question, options, freeText, onAnswer }: Props) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (freeText) inputRef.current?.focus();
  }, [freeText]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const n = Number(e.key);
      const option = n >= 1 && n <= 9 ? options[n - 1] : undefined;
      if (option !== undefined) onAnswer(option);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options, onAnswer]);

  return (
    <Modal
      wide
      onDismiss={() => onAnswer(DECLINED_ANSWER)}
      title={
        <>
          <span>{t("chat.question.title")}</span>
          <span className="ml-auto font-mono text-xs font-normal text-tertiary">ask_user</span>
        </>
      }
      footer={
        <Button size="sm" onClick={() => onAnswer(DECLINED_ANSWER)}>
          {t("chat.question.decline")}
        </Button>
      }
    >
      <p className="mb-4 whitespace-pre-wrap text-sm text-secondary">{question}</p>

      {freeText && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const answer = typed.trim();
            if (answer !== "") onAnswer(answer);
          }}
        >
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("chat.question.typePlaceholder")}
            className="focus-ring min-w-0 flex-1 rounded-lg border border-strong bg-surface px-3 py-2 text-sm text-primary"
          />
          <Button size="sm" variant="primary" type="submit" disabled={typed.trim() === ""}>
            {t("chat.question.send")}
          </Button>
        </form>
      )}

      <div className="flex flex-col gap-2">
        {options.map((option, i) => (
          <button
            key={`${i}-${option}`}
            type="button"
            onClick={() => onAnswer(option)}
            className="focus-ring rounded-lg border border-strong px-4 py-2 text-left text-sm text-primary transition-colors hover:border-accent/60 hover:bg-accent-muted/40"
          >
            <span className="mr-2 font-mono text-xs text-tertiary">{i + 1}.</span>
            {option}
          </button>
        ))}
      </div>
    </Modal>
  );
}
