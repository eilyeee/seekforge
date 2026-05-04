import { useEffect } from "react";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

/** Answer sent when the user dismisses the question without picking an option. */
export const DECLINED_ANSWER = "(the user declined to answer)";

type Props = {
  question: string;
  options: string[];
  onAnswer: (answer: string) => void;
};

/**
 * ask_user question prompt (question.request frame), mirroring the
 * PermissionModal layout: the options render as buttons; dismissing
 * (Escape / backdrop) answers with the declined sentinel so the agent
 * is never left blocked. Keyboard: 1-9 pick an option (TUI parity).
 */
export function QuestionModal({ question, options, onAnswer }: Props) {
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
          <span>The agent has a question</span>
          <span className="ml-auto font-mono text-xs font-normal text-tertiary">ask_user</span>
        </>
      }
      footer={
        <Button size="sm" onClick={() => onAnswer(DECLINED_ANSWER)}>
          Decline to answer
        </Button>
      }
    >
      <p className="mb-4 whitespace-pre-wrap text-sm text-secondary">{question}</p>

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
