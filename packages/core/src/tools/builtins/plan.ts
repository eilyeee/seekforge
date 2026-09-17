import { z } from "zod";
import type { PlanItem as SharedPlanItem } from "@seekforge/shared";
import { defineTool, type ToolSpec } from "../registry.js";

const planItemSchema = z.object({
  step: z.string().min(1).describe("Short description of the step, in imperative form (e.g. 'Run the tests')."),
  status: z.enum(["pending", "in_progress", "done"]).describe("Current status of the step."),
  activeForm: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Present-continuous form shown while the step is in progress (e.g. 'Running the tests')."),
});

const updatePlanSchema = z.object({
  items: z.array(planItemSchema).min(1).max(20).describe("The full plan, replacing any previous plan."),
});

export type PlanItem = SharedPlanItem;

// The schema and the shared contract must describe the same item.
type SchemaItem = z.infer<typeof planItemSchema>;
const _schemaMatchesContract: [SchemaItem extends PlanItem ? true : never, PlanItem extends SchemaItem ? true : never] =
  [true, true];
void _schemaMatchesContract;

/**
 * Plan visibility for multi-step tasks: the model maintains a checklist that
 * UIs render live. Pure session state — nothing touches the file system.
 */
const updatePlan = defineTool({
  name: "update_plan",
  description:
    "Publish your step-by-step plan as items — a FULL replacement of the previous plan, so always resend every step, not just the changed ones. Use for tasks with 3+ steps and keep statuses (pending/in_progress/done) current as you work; give each step an activeForm (e.g. step 'Run the tests', activeForm 'Running the tests') for the UI to show while it is in progress. Skip it for trivial tasks.",
  schema: updatePlanSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Update plan (${args.items.length} steps)`,
  }),
  async run(args, _ctx) {
    return { data: { items: args.items } };
  },
});

export const planTools: ToolSpec[] = [updatePlan];
