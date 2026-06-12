import { z } from "zod";
import { defineTool, type ToolSpec } from "../registry.js";
import { ToolError } from "../errors.js";

const askUserSchema = z.object({
  question: z.string().min(1).describe("The question to put to the user. One sentence, concrete."),
  options: z
    .array(z.string().min(1))
    .min(2)
    .max(6)
    .describe("2-6 mutually exclusive answer choices the user picks from."),
});

/**
 * Mid-run multiple-choice question to the user. The answer channel is
 * provided by interactive frontends (TUI) via ToolContext.askUser; in
 * non-interactive runs the tool fails with not_interactive.
 */
const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the user a multiple-choice question and wait for their answer. Use SPARINGLY — only when a decision genuinely needs the user, e.g. an ambiguous requirement with 2+ valid implementations (\"Should auth tokens live in cookies or localStorage?\"). Never ask what you can infer from the task, the code, or project conventions (e.g. which test framework to use when the repo already has one).",
  schema: askUserSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Ask user: ${args.question}`,
  }),
  async run(args, ctx) {
    if (!ctx.askUser) {
      throw new ToolError("not_interactive", "ask_user is unavailable in this session");
    }
    const answer = await ctx.askUser({ question: args.question, options: args.options });
    return { data: { answer } };
  },
});

export const askTools: ToolSpec[] = [askUser];
