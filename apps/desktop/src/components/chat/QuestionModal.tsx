import { useEffect } from "react";

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
 * is never left blocked.
 */
export function QuestionModal({ question, options, onAnswer }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAnswer(DECLINED_ANSWER);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => onAnswer(DECLINED_ANSWER)}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-100">The agent has a question</span>
          <span className="ml-auto font-mono text-xs text-zinc-500">ask_user</span>
        </div>

        <p className="mb-4 whitespace-pre-wrap text-sm text-zinc-300">{question}</p>

        <div className="flex flex-col gap-2">
          {options.map((option, i) => (
            <button
              key={`${i}-${option}`}
              type="button"
              onClick={() => onAnswer(option)}
              className="rounded border border-zinc-700 px-4 py-2 text-left text-sm text-zinc-200 hover:border-emerald-700 hover:bg-zinc-800"
            >
              <span className="mr-2 font-mono text-xs text-zinc-500">{i + 1}.</span>
              {option}
            </button>
          ))}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => onAnswer(DECLINED_ANSWER)}
            className="rounded border border-zinc-700 px-4 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Decline to answer
          </button>
        </div>
      </div>
    </div>
  );
}
