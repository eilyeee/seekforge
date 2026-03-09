import {
  applyProposal,
  createDeepSeekProvider,
  listEvolutionProposals,
  listSessions,
  readEvolutionProposal,
  reflectOnSession,
  scoreSession,
  sessionReflectionPath,
  setEvolutionProposalStatus,
  type EvolutionProposal,
} from "@seekforge/core";
import { loadConfig } from "../config.js";

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function proposalLine(p: EvolutionProposal): string {
  return `${p.id}  [${p.type}/${p.risk}] (${p.status})  ${truncate(p.title, 60)}`;
}

export async function evolveAnalyzeCommand(sessionId?: string): Promise<void> {
  const workspace = process.cwd();

  let target = sessionId;
  if (!target) {
    // Default: the most recent session that actually finished.
    const finished = listSessions(workspace).find(
      (s) => s.status === "completed" || s.status === "failed",
    );
    if (!finished) {
      console.error("No completed or failed sessions to analyze. See `seekforge sessions`.");
      process.exitCode = 1;
      return;
    }
    target = finished.id;
  }

  const config = loadConfig(workspace);
  if (!config.apiKey) {
    console.error(
      "No DeepSeek API key found. Set DEEPSEEK_API_KEY, or put {\"apiKey\": \"...\"} in " +
        ".seekforge/config.json (project) or ~/.seekforge/config.json (global).",
    );
    process.exitCode = 1;
    return;
  }

  let score;
  try {
    score = scoreSession(workspace, target);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const m = score.metrics;
  console.log(`session:  ${target} [${m.status}]`);
  console.log(`score:    ${score.score}/100`);
  console.log(
    `metrics:  turns=${m.turns} toolCalls=${m.toolCalls} failed=${m.failedToolCalls} ` +
      `retried=${m.retriedCommands} cost=$${m.costUsd.toFixed(4)} verification=${m.verificationRan ? "yes" : "no"}`,
  );
  for (const note of score.notes) console.log(`  - ${note}`);

  const provider = createDeepSeekProvider({
    apiKey: config.apiKey,
    ...(config.model ? { model: config.model } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });

  const result = await reflectOnSession(provider, { workspace, sessionId: target });
  console.log(`\nreflection written to ${sessionReflectionPath(workspace, target)}`);
  if (result.proposals.length === 0) {
    console.log("No new evolution proposals.");
    return;
  }
  console.log(`\nNew proposals (review with \`seekforge evolve show <id>\`):`);
  for (const p of result.proposals) console.log(`  ${proposalLine(p)}`);
}

export function evolveListCommand(): void {
  const proposals = listEvolutionProposals(process.cwd());
  if (proposals.length === 0) {
    console.log("No evolution proposals yet. Run `seekforge evolve analyze` after a session.");
    return;
  }
  const pending = proposals.filter((p) => p.status === "pending");
  const reviewed = proposals.filter((p) => p.status !== "pending");
  for (const p of pending) console.log(proposalLine(p));
  if (pending.length > 0 && reviewed.length > 0) console.log("");
  for (const p of reviewed) console.log(proposalLine(p));
}

export function evolveShowCommand(id: string): void {
  let p: EvolutionProposal;
  try {
    p = readEvolutionProposal(process.cwd(), id);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  console.log(`id:       ${p.id}`);
  console.log(`session:  ${p.sessionId}`);
  console.log(`type:     ${p.type}${p.proposal.skillId ? ` (skill: ${p.proposal.skillId})` : ""}`);
  console.log(`risk:     ${p.risk}`);
  console.log(`status:   ${p.status}${p.reviewedAt ? ` (reviewed ${p.reviewedAt})` : ""}`);
  console.log(`title:    ${p.title}`);
  console.log(`\nproblem:\n${p.problem || "(not stated)"}`);
  const evidence = [
    ...(p.evidence.files ?? []).map((f) => `file: ${f}`),
    ...(p.evidence.commands ?? []).map((c) => `command: ${c}`),
    ...(p.evidence.errors ?? []).map((e) => `error: ${e}`),
  ];
  if (evidence.length > 0) {
    console.log(`\nevidence:`);
    for (const line of evidence) console.log(`  - ${line}`);
  }
  console.log(`\ncontent to apply:\n${p.proposal.content}`);
}

export function evolveAcceptCommand(id: string): void {
  try {
    const p = setEvolutionProposalStatus(process.cwd(), id, "accepted");
    console.log(`accepted ${p.id} — apply with \`seekforge evolve apply ${p.id}\``);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function evolveRejectCommand(id: string): void {
  try {
    const p = setEvolutionProposalStatus(process.cwd(), id, "rejected");
    console.log(`rejected ${p.id}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function evolveApplyCommand(id: string): void {
  try {
    const { proposal, changedPath } = applyProposal(process.cwd(), id);
    console.log(`applied ${proposal.id} [${proposal.type}] → ${changedPath}`);
    console.log("Review the change with `git diff` (or `seekforge diff`).");
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
