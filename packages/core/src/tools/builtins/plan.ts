import { z } from "zod";
import { defineTool, type ToolSpec } from "../registry.js";

const planItemSchema = z.object({
  step: z.string().min(1).describe("Short description of the step."),
  status: z.enum(["pending", "in_progress", "done"]).describe("Current status of the step."),
});

const updatePlanSchema = z.object({
  items: z.array(planItemSchema).min(1).max(20).describe("The full plan, replacing any previous plan."),
});

export type PlanItem = z.infer<typeof planItemSchema>;

/**
 * Plan visibility for multi-step tasks: the model maintains a checklist that
 * UIs render live. Pure session state — nothing touches the file system.
 */
const updatePlan = defineTool({
  name: "update_plan",
  description:
    "Publish or update your step-by-step plan for the current task (full replacement). Use for tasks with 3+ steps; keep statuses current as you work.",
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
