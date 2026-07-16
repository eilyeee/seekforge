export type TeamMemberPlan = {
  id: string;
  agentId: string;
  task: string;
  dependsOn: string[];
};

export type TeamPlan = {
  members: TeamMemberPlan[];
  maxConcurrency: number;
  failurePolicy: "stop" | "continue";
};

export type TeamPlanValidation = { ok: true; plan: TeamPlan } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Desktop-side validation mirrors the Core boundary before a plan is submitted. */
export function validateTeamPlan(raw: unknown, availableAgentIds?: ReadonlySet<string>): TeamPlanValidation {
  if (!isRecord(raw) || !Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > 12) {
    return { ok: false, error: "team must contain 1-12 members" };
  }
  const ids = new Set<string>();
  const members: TeamMemberPlan[] = [];
  for (const value of raw.members) {
    if (!isRecord(value)) return { ok: false, error: "every team member must be an object" };
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
    const task = typeof value.task === "string" ? value.task.trim() : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
      return { ok: false, error: "member ids must be 1-64 letters, digits, underscores, or hyphens" };
    if (ids.has(id)) return { ok: false, error: `duplicate member id: ${id}` };
    if (!agentId || (availableAgentIds && !availableAgentIds.has(agentId)))
      return { ok: false, error: `unknown agent for ${id}: ${agentId || "(empty)"}` };
    if (!task) return { ok: false, error: `member ${id} needs a task` };
    if (!Array.isArray(value.dependsOn) || !value.dependsOn.every((dependency) => typeof dependency === "string")) {
      return { ok: false, error: `member ${id} dependencies must be strings` };
    }
    const dependsOn = [...new Set(value.dependsOn.map((dependency) => dependency.trim()).filter(Boolean))];
    if (dependsOn.includes(id)) return { ok: false, error: `member ${id} cannot depend on itself` };
    ids.add(id);
    members.push({ id, agentId, task, dependsOn });
  }
  for (const member of members) {
    const missing = member.dependsOn.find((dependency) => !ids.has(dependency));
    if (missing) return { ok: false, error: `member ${member.id} depends on unknown member ${missing}` };
  }

  const remaining = new Map(members.map((member) => [member.id, new Set(member.dependsOn)]));
  const ready = members.filter((member) => member.dependsOn.length === 0).map((member) => member.id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited++;
    for (const [candidate, dependencies] of remaining) {
      if (dependencies.delete(id) && dependencies.size === 0) ready.push(candidate);
    }
    remaining.delete(id);
  }
  if (visited !== members.length) return { ok: false, error: "team dependencies contain a cycle" };

  const maxConcurrency = raw.maxConcurrency ?? Math.min(3, members.length);
  if (
    typeof maxConcurrency !== "number" ||
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > 6
  ) {
    return { ok: false, error: "max concurrency must be an integer from 1 to 6" };
  }
  const failurePolicy = raw.failurePolicy ?? "stop";
  if (failurePolicy !== "stop" && failurePolicy !== "continue")
    return { ok: false, error: "failure policy must be stop or continue" };
  return { ok: true, plan: { members, maxConcurrency, failurePolicy } };
}

export function teamPlanTask(plan: TeamPlan): string {
  return [
    "Execute this exact team plan with dispatch_team. Preserve every member id, agentId, task, dependency, concurrency limit, and failure policy exactly as provided. Do not replace it with individual dispatch_agent calls.",
    "",
    JSON.stringify(plan, null, 2),
  ].join("\n");
}

export function teamLayers<T extends TeamMemberPlan>(members: T[]): T[][] {
  const byId = new Map(members.map((member) => [member.id, member]));
  const level = new Map<string, number>();
  const visit = (id: string): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    const member = byId.get(id);
    const value = !member || member.dependsOn.length === 0 ? 0 : Math.max(...member.dependsOn.map(visit)) + 1;
    level.set(id, value);
    return value;
  };
  for (const member of members) visit(member.id);
  const layers: T[][] = [];
  for (const member of members) {
    const index = level.get(member.id) ?? 0;
    (layers[index] ??= []).push(member);
  }
  return layers;
}
