import { useEffect, useRef, useState } from "react";
import type { ChatState } from "./model.js";
import type { StatusLineInput } from "./statusline.js";
import { initialSchedulerState, tick } from "./statusline-scheduler.js";

type StatusLineState = Pick<ChatState, "approval" | "context" | "model" | "sessionId" | "totalUsage">;

function statusLineInput(state: StatusLineState, cwd: string): StatusLineInput {
  return {
    model: state.model,
    cwd,
    ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    costUsd: state.totalUsage.costUsd,
    approval: state.approval,
    totalTokens: state.totalUsage.promptTokens + state.totalUsage.completionTokens,
    ...(state.context ? { contextPercent: state.context.percent } : {}),
  };
}

export function useStatusLine(command: string | undefined, projectPath: string, state: StatusLineState): string | null {
  const [text, setText] = useState<string | null>(null);
  const schedulerRef = useRef(initialSchedulerState);
  const busyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!command) {
      schedulerRef.current = initialSchedulerState;
      setText(null);
      return;
    }
    let cancelled = false;

    const compute = (): void => {
      if (busyRef.current) return;
      busyRef.current = true;
      setImmediate(async () => {
        try {
          if (cancelled) return;
          const result = await tick(schedulerRef.current, command, statusLineInput(stateRef.current, projectPath));
          schedulerRef.current = result.state;
          if (!cancelled && result.recomputed) setText(result.state.lastOutput);
        } finally {
          busyRef.current = false;
        }
      });
    };

    compute();
    const id = setInterval(compute, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [command, projectPath, state.model, state.approval, state.sessionId, state.totalUsage, state.context]);

  return text;
}
