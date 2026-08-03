import { z } from "zod";
import { defineTool, type ToolSpec } from "../registry.js";
import { ToolError } from "../errors.js";

/** Offered when an open question has no choices, so declining stays possible. */
export const SKIP_ANSWER = "Skip";

const askUserSchema = z
  .object({
    question: z.string().min(1).describe("The question to put to the user. One sentence, concrete."),
    options: z
      .array(z.string().min(1))
      .min(2)
      .max(6)
      .optional()
      .describe("2-6 mutually exclusive answer choices. Omit only when the answer cannot be enumerated."),
    freeText: z
      .boolean()
      .optional()
      .describe("Let the user type an answer instead of picking one — for a value only they know (a url, a name)."),
  })
  .refine((a) => a.options !== undefined || a.freeText === true, {
    message: "give options, or set freeText for an open question",
  });

/**
 * Mid-run question to the user. The answer channel is provided by interactive
 * frontends via ToolContext.askUser; non-interactive runs fail with
 * not_interactive.
 *
 * An open question still travels with one option ("Skip"), so a frontend that
 * does not implement typed answers shows something answerable rather than an
 * empty prompt, and the user can always decline.
 */
const askUser = defineTool({
  name: "ask_user",
  description:
    'Ask the user a question and wait for their answer: `options` for a choice between 2-6 alternatives, or `freeText` for a value only they can supply (a url, an account name). Use SPARINGLY — only when a decision genuinely needs the user, e.g. an ambiguous requirement with 2+ valid implementations ("Should auth tokens live in cookies or localStorage?"). Never ask what you can infer from the task, the code, or project conventions (e.g. which test framework to use when the repo already has one).',
  schema: askUserSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Ask user: ${args.question}`,
  }),
  async run(args, ctx) {
    if (!ctx.askUser) {
      throw new ToolError("not_interactive", "ask_user is unavailable in this session");
    }
    const answer = await ctx.askUser({
      question: args.question,
      options: args.options ?? [SKIP_ANSWER],
      ...(args.freeText ? { freeText: true } : {}),
    });
    return { data: { answer, ...(args.freeText && answer === SKIP_ANSWER ? { declined: true } : {}) } };
  },
});

export const askTools: ToolSpec[] = [askUser];
