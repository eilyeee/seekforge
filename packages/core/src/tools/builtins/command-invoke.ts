import { z } from "zod";
import { defineTool, type ToolSpec } from "../registry.js";
import { ToolError } from "../errors.js";
import { expandUserCommand, loadUserCommands, type UserCommand } from "../../agent/commands.js";

const runUserCommandSchema = z.object({
  name: z.string().min(1).describe('The user-defined command name to invoke (e.g. "review" or "frontend:build").'),
  arguments: z
    .string()
    .optional()
    .describe("Arguments string passed to the command's $ARGUMENTS / $1..$9 placeholders."),
});

/** Commands the model may invoke: those without disable-model-invocation. */
function invocable(commands: UserCommand[]): UserCommand[] {
  return commands.filter((c) => !c.disableModelInvocation);
}

/**
 * Lets the model invoke a user-defined slash command. Returns the EXPANDED
 * prompt text ($ARGUMENTS / $1..$9 interpolation only) as the tool result —
 * the model then acts on it. SECURITY: this never runs the command body's
 * `!`shell`` injections, so the model cannot trigger arbitrary shell.
 */
const runUserCommand = defineTool({
  name: "run_user_command",
  description:
    "Invoke a user-defined slash command by name and get its expanded prompt text back. Use this to reuse a project's saved command workflows. If the name is unknown, the error lists the commands you may invoke. Does NOT execute any shell embedded in the command — only argument interpolation.",
  schema: runUserCommandSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Invoke user command: ${args.name}`,
  }),
  async run(args, ctx) {
    const commands = loadUserCommands(ctx.workspace);
    const available = invocable(commands);
    const cmd = commands.find((c) => c.name === args.name);

    if (!cmd || cmd.disableModelInvocation) {
      const names = available.map((c) => c.name);
      const list = names.length > 0 ? names.join(", ") : "(none)";
      throw new ToolError(
        "unknown_command",
        `No invocable user command named "${args.name}". Available commands: ${list}.`,
      );
    }

    // SECURITY: expand only $ARGUMENTS / $1..$9 — never run !`shell` injections.
    const prompt = expandUserCommand(cmd, args.arguments ?? "");
    return { data: { name: cmd.name, prompt } };
  },
});

export const commandInvokeTools: ToolSpec[] = [runUserCommand];
