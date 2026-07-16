import type { ToolDefinitionForModel } from "@seekforge/shared";
import type { AgentDefinition } from "./types.js";
import { isRecord } from "../util/guards.js";

export const DISPATCH_TEAM_TOOL = "dispatch_team";
export const MAX_TEAM_MEMBERS = 12;
export const MAX_TEAM_CONCURRENCY = 6;

export type TeamMemberPlan = {
  id: string;
  agentId: string;
  task: string;
  dependsOn: string[];
};

export type AgentTeamPlan = {
  members: TeamMemberPlan[];
  maxConcurrency: number;
  failurePolicy: "stop" | "continue";
};

export type TeamPlanValidation = { ok: true; plan: AgentTeamPlan } | { ok: false; message: string };

/** Parses and validates the complete dependency graph before any agent starts. */
export function validateAgentTeam(raw: unknown, agents: AgentDefinition[]): TeamPlanValidation {
  if (!isRecord(raw) || !Array.isArray(raw["members"])) {
    return { ok: false, message: "dispatch_team requires a members array" };
  }
  const values = raw["members"];
  if (values.length === 0 || values.length > MAX_TEAM_MEMBERS) {
    return { ok: false, message: `members must contain 1-${MAX_TEAM_MEMBERS} entries` };
  }
  const available = new Set(agents.map((agent) => agent.id));
  const members: TeamMemberPlan[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value)) return { ok: false, message: "every team member must be an object" };
    const id = typeof value["id"] === "string" ? value["id"].trim() : "";
    const agentId = typeof value["agentId"] === "string" ? value["agentId"] : "";
    const task = typeof value["task"] === "string" ? value["task"].trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      return { ok: false, message: "member id must be 1-64 letters, digits, underscores, or hyphens" };
    }
    if (ids.has(id)) return { ok: false, message: `duplicate member id ${JSON.stringify(id)}` };
    if (!available.has(agentId))
      return { ok: false, message: `unknown agent ${JSON.stringify(agentId)} for member ${id}` };
    if (!task) return { ok: false, message: `member ${id} requires a non-empty task` };
    const rawDeps = value["dependsOn"] ?? [];
    if (!Array.isArray(rawDeps) || !rawDeps.every((dep) => typeof dep === "string")) {
      return { ok: false, message: `member ${id} dependsOn must be a string array` };
    }
    const dependsOn = [...new Set(rawDeps as string[])];
    if (dependsOn.includes(id)) return { ok: false, message: `member ${id} cannot depend on itself` };
    ids.add(id);
    members.push({ id, agentId, task, dependsOn });
  }
  for (const member of members) {
    const missing = member.dependsOn.find((dep) => !ids.has(dep));
    if (missing) return { ok: false, message: `member ${member.id} depends on unknown member ${missing}` };
  }

  // Kahn's algorithm proves acyclicity without recursive depth risk.
  const remaining = new Map(members.map((member) => [member.id, new Set(member.dependsOn)]));
  const ready = members.filter((member) => member.dependsOn.length === 0).map((member) => member.id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited++;
    for (const [candidate, deps] of remaining) {
      if (deps.delete(id) && deps.size === 0) ready.push(candidate);
    }
    remaining.delete(id);
  }
  if (visited !== members.length) return { ok: false, message: "team dependencies contain a cycle" };

  const requestedConcurrency = raw["maxConcurrency"] ?? Math.min(3, members.length);
  if (
    typeof requestedConcurrency !== "number" ||
    !Number.isSafeInteger(requestedConcurrency) ||
    requestedConcurrency < 1 ||
    requestedConcurrency > MAX_TEAM_CONCURRENCY
  ) {
    return { ok: false, message: `maxConcurrency must be an integer from 1 to ${MAX_TEAM_CONCURRENCY}` };
  }
  const failurePolicy = raw["failurePolicy"] ?? "stop";
  if (failurePolicy !== "stop" && failurePolicy !== "continue") {
    return { ok: false, message: 'failurePolicy must be "stop" or "continue"' };
  }
  return { ok: true, plan: { members, maxConcurrency: requestedConcurrency, failurePolicy } };
}

export function buildDispatchTeamToolDefinition(agents: AgentDefinition[]): ToolDefinitionForModel {
  return {
    name: DISPATCH_TEAM_TOOL,
    description:
      "Run a bounded team of specialist agents with explicit dependencies and controlled concurrency. " +
      "Use stable member ids; independent ready members run in parallel, dependent members wait.",
    parameters: {
      type: "object",
      properties: {
        members: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TEAM_MEMBERS,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable member id within this team." },
              agentId: { type: "string", enum: agents.map((agent) => agent.id) },
              task: { type: "string", description: "Self-contained member task and expected result." },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["id", "agentId", "task"],
          },
        },
        maxConcurrency: { type: "integer", minimum: 1, maximum: MAX_TEAM_CONCURRENCY },
        failurePolicy: { type: "string", enum: ["stop", "continue"] },
      },
      required: ["members"],
    },
  };
}
