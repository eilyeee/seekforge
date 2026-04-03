/**
 * Scripted mock WebSocket: replays start → plan → tool calls →
 * permission.request → deltas → completed, so the whole Chat view is
 * exercisable without the real server.
 */
import type { ClientFrame, ServerFrame, WsClientHandlers, WsClient } from "../lib/ws-types";
import type { StreamEvent } from "../lib/events";

const FINAL_TEXT =
  "Done. I added the `--json` flag to the run command and verified it:\n\n" +
  "- `apps/cli/src/index.ts`: new flag wired into the renderer\n" +
  "- `pnpm typecheck` passes\n\n" +
  "```bash\nseekforge run \"fix the bug\" --json | jq .type\n```";

const PLAN_TEXT =
  "Here is the plan:\n\n" +
  "## Plan\n\n" +
  "1. Inspect `apps/cli/src/index.ts` to find the commander setup\n" +
  "2. Add the `--json` flag and a JSON-lines renderer\n" +
  "3. Run `pnpm typecheck` to verify\n\n" +
  "No changes were made — press **Execute plan** to carry it out.";

export function createMockWs(handlers: WsClientHandlers): WsClient {
  let sessionId = "";
  let sessionCounter = 0;
  let running = false;
  let cancelled = false;
  let permissionWaiter: ((approved: boolean) => void) | null = null;

  const emit = (frame: ServerFrame) => handlers.onFrame(frame);
  const ev = (event: StreamEvent) => emit({ type: "event", sessionId, event });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  setTimeout(() => handlers.onState("connecting"), 0);
  setTimeout(() => handlers.onState("connected"), 400);

  const waitPermission = () =>
    new Promise<boolean>((resolve) => {
      permissionWaiter = resolve;
    });

  /** Plan-mode run: read-only, streams the plan text, no file changes. */
  async function runPlan(): Promise<void> {
    running = true;
    cancelled = false;
    try {
      sessionId = `s-mock-${++sessionCounter}`;
      ev({ type: "session.created", sessionId });
      await sleep(300);
      if (cancelled) return;

      ev({ type: "tool.started", toolName: "read_file", args: { path: "apps/cli/src/index.ts" } });
      await sleep(400);
      if (cancelled) return;
      ev({
        type: "tool.completed",
        toolName: "read_file",
        result: { ok: true, data: { content: "#!/usr/bin/env node\n// …" } },
      });

      for (const chunk of PLAN_TEXT.match(/[\s\S]{1,18}/g) ?? []) {
        if (cancelled) return;
        ev({ type: "model.delta", chunk });
        await sleep(30);
      }
      ev({ type: "model.message", content: PLAN_TEXT });

      const usage = { promptTokens: 3120, completionTokens: 410, cacheHitTokens: 2400, costUsd: 0.0018 };
      ev({ type: "usage.updated", usage });
      ev({
        type: "session.completed",
        report: {
          summary: PLAN_TEXT,
          changedFiles: [],
          commandsRun: [],
          verification: "plan only — no changes made",
          usage,
        },
      });
      emit({ type: "idle" });
    } finally {
      if (cancelled) {
        ev({ type: "session.failed", error: { code: "cancelled", message: "session cancelled by user" } });
        emit({ type: "idle" });
      }
      running = false;
    }
  }

  async function run(task: string, resumed: boolean): Promise<void> {
    running = true;
    cancelled = false;
    const step = async (ms: number): Promise<boolean> => {
      await sleep(ms);
      return !cancelled;
    };

    try {
      if (!resumed) {
        sessionId = `s-mock-${++sessionCounter}`;
        ev({ type: "session.created", sessionId });
      }
      if (!(await step(300))) return;

      const plan = (s1: string, s2: string, s3: string) =>
        ev({
          type: "tool.completed",
          toolName: "update_plan",
          result: {
            ok: true,
            data: {
              items: [
                { step: "Inspect the relevant files", status: s1 },
                { step: `Apply the change: ${task.slice(0, 40)}`, status: s2 },
                { step: "Run verification commands", status: s3 },
              ],
            },
          },
        });

      ev({ type: "tool.started", toolName: "update_plan", args: {} });
      plan("in_progress", "pending", "pending");
      if (!(await step(400))) return;

      ev({ type: "tool.started", toolName: "read_file", args: { path: "apps/cli/src/index.ts" } });
      if (!(await step(500))) return;
      ev({
        type: "tool.completed",
        toolName: "read_file",
        result: { ok: true, data: { content: "#!/usr/bin/env node\nimport { program } from \"commander\";\n// …" } },
      });

      plan("done", "in_progress", "pending");
      if (!(await step(400))) return;

      ev({ type: "tool.started", toolName: "apply_patch", args: { path: "apps/cli/src/index.ts" } });
      if (!(await step(600))) return;
      ev({
        type: "tool.completed",
        toolName: "apply_patch",
        result: {
          ok: true,
          data: {
            diff: [
              "--- a/apps/cli/src/index.ts",
              "+++ b/apps/cli/src/index.ts",
              "@@ -41,6 +41,7 @@ program",
              '   .option("--mode <mode>", "ask | edit", "edit")',
              '+  .option("--json", "emit events as JSON lines")',
              '   .option("--max-turns <n>", "agent turn limit")',
              "",
            ].join("\n"),
          },
          meta: { path: "apps/cli/src/index.ts", permission: "write" },
        },
      });
      ev({ type: "file.changed", path: "apps/cli/src/index.ts" });

      plan("done", "done", "in_progress");
      if (!(await step(400))) return;

      emit({
        type: "permission.request",
        requestId: `p-${sessionCounter}-1`,
        request: {
          toolName: "run_command",
          permission: "execute",
          description: "Run the typecheck to verify the change",
          command: "pnpm typecheck",
        },
      });
      const approved = await waitPermission();
      if (cancelled) return;

      if (approved) {
        ev({ type: "tool.started", toolName: "run_command", args: { command: "pnpm typecheck" } });
        if (!(await step(700))) return;
        ev({
          type: "tool.completed",
          toolName: "run_command",
          result: {
            ok: true,
            data: { exitCode: 0, output: "> tsc --noEmit\n(no errors)" },
            meta: { command: "pnpm typecheck", permission: "execute" },
          },
        });
      } else {
        ev({
          type: "tool.completed",
          toolName: "run_command",
          result: { ok: false, error: { code: "permission_denied", message: "user denied: pnpm typecheck" } },
        });
      }

      ev({ type: "context.compacted", droppedTurns: 2, summaryTokens: 412 });
      plan("done", "done", "done");
      if (!(await step(300))) return;

      for (const chunk of FINAL_TEXT.match(/[\s\S]{1,18}/g) ?? []) {
        if (cancelled) return;
        ev({ type: "model.delta", chunk });
        await sleep(40);
      }
      ev({ type: "model.message", content: FINAL_TEXT });

      const usage = { promptTokens: 9450, completionTokens: 1230, cacheHitTokens: 7300, costUsd: 0.0061 };
      ev({ type: "usage.updated", usage });
      ev({
        type: "session.completed",
        report: {
          summary: FINAL_TEXT,
          changedFiles: ["apps/cli/src/index.ts"],
          commandsRun: approved ? ["pnpm typecheck"] : [],
          verification: approved ? "commands run: pnpm typecheck" : "verification skipped (denied)",
          usage,
        },
      });
      emit({ type: "idle" });
    } finally {
      if (cancelled) {
        ev({ type: "session.failed", error: { code: "cancelled", message: "session cancelled by user" } });
        emit({ type: "idle" });
      }
      running = false;
    }
  }

  return {
    send(frame: ClientFrame) {
      switch (frame.type) {
        case "start":
          if (running) return emit({ type: "error", code: "busy", message: "a session is already running" });
          // plan: true scripts a plan-style completion (read-only, no edits).
          if (frame.plan) void runPlan();
          else void run(frame.task, false);
          break;
        case "send":
          if (running) return emit({ type: "error", code: "busy", message: "a session is already running" });
          sessionId = frame.sessionId;
          // mode: "edit" overrides a plan session — the full edit script runs.
          void run(frame.task, true);
          break;
        case "permission.response": {
          const waiter = permissionWaiter;
          permissionWaiter = null;
          waiter?.(frame.approved);
          break;
        }
        case "cancel": {
          if (!running) break;
          cancelled = true;
          const waiter = permissionWaiter;
          permissionWaiter = null;
          waiter?.(false);
          break;
        }
      }
    },
    close() {
      cancelled = true;
      handlers.onState("disconnected");
    },
  };
}
