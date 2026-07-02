import {
  applyProposal,
  createDeepSeekProvider,
  listEvolutionProposals,
  listSessions,
  readEvolutionProposal,
  reflectOnSession,
  resolveProviderConfig,
  scoreSession,
  sessionReflectionPath,
  setEvolutionProposalStatus,
  type EvolutionProposal,
} from "@seekforge/core";
import { t } from "../i18n.js";
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
      console.error(t("err.noCompletedSessions"));
      process.exitCode = 1;
      return;
    }
    target = finished.id;
  }

  const config = loadConfig(workspace);
  if (!config.apiKey) {
    console.error(t("err.noApiKeyHint2"));
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
  console.log(t("cmd.evolve.session", { id: target, status: m.status }));
  console.log(t("cmd.evolve.score", { score: score.score }));
  console.log(
    t("cmd.evolve.metrics", {
      turns: m.turns,
      toolCalls: m.toolCalls,
      failedToolCalls: m.failedToolCalls,
      retriedCommands: m.retriedCommands,
      cost: m.costUsd.toFixed(4),
      verification: m.verificationRan ? t("cmd.evolve.metricsYes") : t("cmd.evolve.metricsNo"),
    }),
  );
  for (const note of score.notes) console.log(t("cmd.evolve.note", { note }));

  const provider = createDeepSeekProvider(
    resolveProviderConfig({
      provider: config.provider,
      apiKey: config.apiKey,
      ...(config.model ? { model: config.model } : {}),
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    }),
  );

  const result = await reflectOnSession(provider, { workspace, sessionId: target });
  console.log(`\n${t("cmd.evolve.reflectionWritten", { path: sessionReflectionPath(workspace, target) })}`);
  if (result.proposals.length === 0) {
    console.log(t("cmd.evolve.noNewProposals"));
    return;
  }
  console.log(`\n${t("cmd.evolve.newProposals")}`);
  for (const p of result.proposals) console.log(`  ${proposalLine(p)}`);
}

export function evolveListCommand(): void {
  const proposals = listEvolutionProposals(process.cwd());
  if (proposals.length === 0) {
    console.log(t("cmd.evolve.none"));
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
    console.log(t("cmd.evolve.accepted", { id: p.id }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function evolveRejectCommand(id: string): void {
  try {
    const p = setEvolutionProposalStatus(process.cwd(), id, "rejected");
    console.log(t("cmd.evolve.rejected", { id: p.id }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function evolveApplyCommand(id: string): void {
  try {
    const { proposal, changedPath } = applyProposal(process.cwd(), id);
    console.log(t("cmd.evolve.applied", { id: proposal.id, type: proposal.type, path: changedPath }));
    console.log(t("cmd.evolve.appliedMore"));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
