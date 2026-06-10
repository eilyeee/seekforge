import { z } from "zod";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { redactSecrets } from "../redact.js";
import { resolveInsideWorkspace } from "../sandbox.js";
import { truncateHeadTail } from "../text.js";
import { classifyCommand, normalizeCommand, runShellCommand } from "../run-command.js";
import { defineTool, type ToolSpec } from "../registry.js";

const runCommandSchema = z.object({
  command: z.string().describe("Shell command line to run via /bin/sh -c."),
  cwd: z.string().optional().describe("Working directory, relative to the workspace root."),
  timeoutMs: z
    .number()
    .optional()
    .describe("Timeout in milliseconds (defaults: 30s, 120s for tests, 180s for builds)."),
});

const runCommand = defineTool({
  name: "run_command",
  description:
    "Run a shell command inside the workspace. Output is truncated and secrets are redacted. Destructive commands are refused; dependency installs require confirmation.",
  schema: runCommandSchema,
  classify: (args, ctx) => {
    const cls = classifyCommand(args.command, ctx.policy.commandAllowlist);
    return {
      permission: cls.permission,
      description:
        cls.permission === "dangerous"
          ? `Refused command (${cls.reason}): ${normalizeCommand(args.command)}`
          : `Run command: ${normalizeCommand(args.command)}`,
      command: args.command,
      allowlisted: cls.allowlisted,
    };
  },
  async run(args, ctx) {
    const cls = classifyCommand(args.command, ctx.policy.commandAllowlist);
    const cwd = resolveInsideWorkspace(ctx.workspace, args.cwd ?? ".");
    const timeoutMs = args.timeoutMs ?? cls.defaultTimeoutMs;

    let res;
    try {
      res = await runShellCommand(args.command, cwd, timeoutMs);
    } catch (err) {
      if (err instanceof ToolError && err.code === "timeout") {
        const d = err.detail as { timeoutMs: number; stdout: string; stderr: string };
        throw new ToolError(err.code, err.message, {
          timeoutMs: d.timeoutMs,
          stdout: redactSecrets(truncateHeadTail(d.stdout, DEFAULT_LIMITS.toolOutputMaxChars).text),
          stderr: redactSecrets(truncateHeadTail(d.stderr, DEFAULT_LIMITS.toolOutputMaxChars).text),
        });
      }
      throw err;
    }

    const out = truncateHeadTail(res.stdout, DEFAULT_LIMITS.toolOutputMaxChars);
    const errOut = truncateHeadTail(res.stderr, DEFAULT_LIMITS.toolOutputMaxChars);
    return {
      data: {
        exitCode: res.exitCode,
        stdout: redactSecrets(out.text),
        stderr: redactSecrets(errOut.text),
        durationMs: res.durationMs,
      },
      meta: { truncated: out.truncated || errOut.truncated },
    };
  },
});

export const commandTools: ToolSpec[] = [runCommand];
