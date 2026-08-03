import { z } from "zod";
import { ToolError } from "../errors.js";
import { resolveInsideWorkspace } from "../sandbox.js";
import { classifyCommand, normalizeCommand } from "../run-command.js";
import { executeCommandInWorkspace } from "../shell-execution.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { discoverLoopVerificationPlan } from "../../agent/loop-verification-plan.js";
import { parseVerifyDiagnostics } from "../../agent/verify-diagnostics.js";
import type { ToolContext } from "../index.js";

/**
 * Running the project's tests and reporting what failed, rather than what was
 * printed.
 *
 * Both halves already existed for the autonomous Loop: it discovers a project's
 * verification commands from its manifests, and it parses the output of a dozen
 * test runners into failed test names and file/line diagnostics. This exposes
 * the same two to an ordinary agent run, so a failing suite arrives as data
 * instead of a wall of text the model has to re-read.
 *
 * Nothing about running the command is re-implemented: the command is
 * classified by the same classifier as run_command and executed through the
 * same path, so the sandbox, the allow-list, the confirmation prompt and secret
 * redaction all behave identically.
 */

/** Tests are slow; the classifier's default is meant for ordinary commands. */
const DEFAULT_TEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The command this call will run: the caller's, or the project's own test
 * command discovered from its manifests.
 *
 * Discovery never executes manifest-provided text — it only selects recognized
 * script names and fixed ecosystem commands — so the result is as safe to
 * classify as anything the model could have typed.
 */
export function resolveTestCommand(workspace: string, explicit?: string): string {
  if (explicit !== undefined) return explicit;
  // Discovery is the Loop's, and reports failure in the Loop's terms; a tool
  // caller needs to be told what THEY can do about it.
  let stages: Array<{ id: string; command: string }>;
  try {
    stages = discoverLoopVerificationPlan(workspace).stages;
  } catch {
    stages = [];
  }
  const test = stages.find((stage) => /test|spec|pytest/i.test(stage.id)) ?? stages[0];
  if (!test) {
    throw new ToolError(
      "no_test_command",
      "No test command could be discovered from this project's manifests — pass `command` explicitly.",
    );
  }
  return test.command;
}

/** Discovery may fail; classify must not throw, so it falls back to a label. */
function commandForClassify(ctx: ToolContext, explicit?: string): string | undefined {
  try {
    return resolveTestCommand(ctx.workspace, explicit);
  } catch {
    return undefined;
  }
}

const runTestsSchema = z.object({
  command: z
    .string()
    .min(1)
    .optional()
    .describe("Test command to run. Omit it to use the project's own, discovered from its manifests."),
  cwd: z.string().optional().describe("Directory to run in, relative to the workspace root (default '.')."),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(30 * 60 * 1000)
    .optional()
    .describe("Timeout in milliseconds (default 600000 — test suites are slow)."),
});

const runTests = defineTool({
  name: "run_tests",
  description:
    "Run the project's tests and report WHICH ONES failed: the failing test names, plus file/line diagnostics, instead of a wall of output. " +
    "Omit `command` to use the project's own test command, discovered from its manifests (package.json scripts, Cargo.toml, go.mod, pyproject.toml…). " +
    "Prefer this over run_command for tests — same permissions, far less to read. The raw output is still returned for anything the parser did not recognize.",
  schema: runTestsSchema,
  // Identical classification to run_command: a test command is still a command,
  // and must be approved on exactly the same terms.
  classify: (args, ctx) => {
    const command = commandForClassify(ctx, args.command);
    if (command === undefined) {
      return { permission: "readonly", description: "Discover this project's test command" };
    }
    const cls = classifyCommand(command, ctx.policy.commandAllowlist);
    return {
      permission: cls.permission,
      description:
        cls.permission === "dangerous"
          ? `Refused test command (${cls.reason}): ${normalizeCommand(command)}`
          : `Run tests: ${normalizeCommand(command)}`,
      command,
      allowlisted: cls.allowlisted,
    };
  },
  async run(args, ctx) {
    const command = resolveTestCommand(ctx.workspace, args.command);
    const cwd = resolveInsideWorkspace(ctx.workspace, args.cwd ?? ".");
    const execution = await executeCommandInWorkspace(ctx, {
      command,
      cwd,
      timeoutMs: args.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
      toolName: "run_tests",
    });

    const combined = `${execution.stdout}\n${execution.stderr}`;
    const passed = execution.exitCode === 0;
    // A passing run needs no diagnosis; parsing it would only add noise.
    const diagnosis = passed ? undefined : parseVerifyDiagnostics(combined);
    return {
      data: {
        command,
        passed,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        ...(diagnosis
          ? {
              framework: diagnosis.framework,
              failedTests: diagnosis.failedTests,
              diagnostics: diagnosis.diagnostics,
              summary: diagnosis.summary,
            }
          : {}),
        // Kept whatever the parser made of it: a runner it does not know, or a
        // failure that is not a test failure at all, is still readable here.
        output: combined.trim(),
      },
      meta: {
        truncated: execution.truncated,
        ...(execution.sandboxEscalated ? { sandboxEscalated: true } : {}),
      },
    };
  },
});

export const testTools: ToolSpec[] = [runTests];
