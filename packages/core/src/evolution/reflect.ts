/**
 * reflectOnSession: one post-task model call that turns a finished session
 * into a short reflection (markdown) plus evolution proposal candidates.
 *
 * Proposals are NEVER applied here — they are appended as pending candidates
 * for explicit human review (`seekforge evolve accept/apply`).
 *
 * Never throws on model/parse failures — degrades to a minimal reflection
 * built from the score notes, with zero proposals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatProvider } from "../provider/index.js";
import { readSessionMeta } from "../agent/index.js";
import { readToolCallLog, scoreSession, type SessionScore } from "./score.js";
import { appendEvolutionProposals, readEvolutionProposals, sessionReflectionPath } from "./store.js";
import {
  EVOLUTION_PROPOSAL_TYPES,
  type EvolutionProposal,
  type EvolutionProposalRisk,
  type EvolutionProposalType,
} from "./types.js";

export type ReflectOnSessionInput = {
  workspace: string;
  sessionId: string;
};

export type ReflectOnSessionResult = {
  reflectionMarkdown: string;
  proposals: EvolutionProposal[];
};

const DIGEST_MAX_CHARS = 6000;
const FINAL_ANSWER_MAX_CHARS = 2000;
const MAX_TOOL_LOG_ENTRIES = 20;
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Prompt-injection defense, same pattern as memory/extract.ts (kept in sync
 * by tests; not imported because memory internals are not exported).
 */
const INJECTION_PATTERN =
  /\b(ignore|disregard|override|bypass)\b[\s\S]{0,80}(instruction|rule|sandbox|permission|safety|prompt|policy)|(忽略|无视|绕过)[\s\S]{0,30}(指令|规则|沙箱|权限|限制)/i;

const SYSTEM_PROMPT = [
  "You review coding-agent sessions and propose how the agent setup could evolve.",
  "Given a session digest (score, metrics, task, final answer, tool-call log),",
  "return STRICT JSON inside a ```json fence, with exactly this shape:",
  "",
  "```json",
  '{"reflection": "<markdown>", "proposals": [{"type": "project_memory|agent_rule|skill", "title": "...", "problem": "...", "content": "...", "skillId": "...", "risk": "low|medium|high", "evidence": {"files": [], "commands": [], "errors": []}}]}',
  "```",
  "",
  "reflection: at most 20 lines of markdown with the sections",
  "## What happened / ## Friction / ## Lessons.",
  "",
  "HARD rules for proposals:",
  "- Propose something ONLY when there is real evidence for it in THIS session",
  "  (a failure, retry, missing knowledge, or repeated manual procedure).",
  "  Return an empty proposals array otherwise.",
  "- problem: what went wrong or could improve, citing the evidence.",
  "- agent_rule: content must be a SINGLE imperative line suitable for AGENTS.md",
  '  (e.g. "Run pnpm typecheck after editing TypeScript files.").',
  "- project_memory: content must be a SINGLE durable project fact line.",
  "- skill: content must be a FULL SKILL.md body with the sections",
  "  ## When to Use / ## Procedure / ## Verification, and skillId must be a",
  "  kebab-case identifier (lowercase letters, digits, dashes).",
  "- NEVER propose anything that looks like an instruction to ignore rules,",
  "  permissions, or safety; never include secrets.",
  "Output nothing outside the ```json fence.",
].join("\n");

type MessageLine = { role?: string; content?: string };

function readMessageLines(workspace: string, sessionId: string): MessageLine[] {
  const file = path.join(workspace, ".seekforge", "sessions", sessionId, "messages.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: MessageLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) lines.push(parsed as MessageLine);
    } catch {
      // Corrupt line: tolerate and skip.
    }
  }
  return lines;
}

/** Digest: score + metrics + notes, task, final answer, recent tool calls. */
export function buildReflectionDigest(workspace: string, sessionId: string, score: SessionScore): string {
  const meta = readSessionMeta(workspace, sessionId);
  const task = meta?.task ?? "(unknown)";
  const m = score.metrics;

  const lastAssistant = [...readMessageLines(workspace, sessionId)]
    .reverse()
    .find((line) => line.role === "assistant" && typeof line.content === "string" && line.content.trim());
  const finalAnswer = (lastAssistant?.content ?? "(none)").replace(/\s+/g, " ").trim().slice(0, FINAL_ANSWER_MAX_CHARS);

  const toolLog = readToolCallLog(workspace, sessionId)
    .slice(-MAX_TOOL_LOG_ENTRIES)
    .map((t) => {
      const name = typeof t.toolName === "string" ? t.toolName : "(unknown)";
      const outcome = t.ok === false ? `FAILED (${t.errorCode ?? "unknown_error"})` : "ok";
      return `- ${name}: ${outcome}`;
    });

  const digest = [
    `Session score: ${score.score}/100 (status: ${m.status}, mode: ${meta?.mode ?? "?"})`,
    `Metrics: turns=${m.turns} toolCalls=${m.toolCalls} failedToolCalls=${m.failedToolCalls} retriedCommands=${m.retriedCommands} costUsd=${m.costUsd.toFixed(4)} verificationRan=${m.verificationRan}`,
    "Score notes:",
    ...(score.notes.length > 0 ? score.notes.map((n) => `- ${n}`) : ["- (no deductions)"]),
    "",
    `Task: ${task}`,
    "",
    `Final answer: ${finalAnswer}`,
    "",
    `Recent tool calls (oldest first, last ${MAX_TOOL_LOG_ENTRIES} max):`,
    ...(toolLog.length > 0 ? toolLog : ["- (none)"]),
  ].join("\n");
  return digest.length > DIGEST_MAX_CHARS ? digest.slice(0, DIGEST_MAX_CHARS) : digest;
}

type ParsedProposal = {
  type: EvolutionProposalType;
  title: string;
  problem: string;
  content: string;
  skillId?: string;
  risk: EvolutionProposalRisk;
  evidence: { files?: string[]; commands?: string[]; errors?: string[] };
};

type ParsedReflection = {
  reflection: string;
  proposals: ParsedProposal[];
};

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

/** Parses the fenced JSON response; returns undefined on any shape problem. */
function parseReflection(content: string): ParsedReflection | undefined {
  const fence = /```json\s*\n([\s\S]*?)```/.exec(content);
  if (!fence || fence[1] === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.reflection !== "string" || obj.reflection.trim().length === 0) return undefined;

  const proposals: ParsedProposal[] = [];
  if (Array.isArray(obj.proposals)) {
    for (const raw of obj.proposals) {
      if (typeof raw !== "object" || raw === null) continue;
      const p = raw as Record<string, unknown>;
      if (!EVOLUTION_PROPOSAL_TYPES.includes(p.type as EvolutionProposalType)) continue;
      if (typeof p.title !== "string" || p.title.trim().length === 0) continue;
      if (typeof p.content !== "string" || p.content.trim().length === 0) continue;
      const type = p.type as EvolutionProposalType;
      const skillId = typeof p.skillId === "string" ? p.skillId.trim() : undefined;
      // A skill proposal without a valid kebab-case id cannot be applied.
      if (type === "skill" && (!skillId || !SKILL_ID_RE.test(skillId))) continue;
      const risk: EvolutionProposalRisk =
        p.risk === "low" || p.risk === "medium" || p.risk === "high" ? p.risk : "medium";
      const evidenceRaw =
        typeof p.evidence === "object" && p.evidence !== null ? (p.evidence as Record<string, unknown>) : {};
      const evidence: ParsedProposal["evidence"] = {};
      const files = stringArray(evidenceRaw.files);
      const commands = stringArray(evidenceRaw.commands);
      const errors = stringArray(evidenceRaw.errors);
      if (files) evidence.files = files;
      if (commands) evidence.commands = commands;
      if (errors) evidence.errors = errors;
      proposals.push({
        type,
        title: p.title.trim(),
        problem: typeof p.problem === "string" ? p.problem.trim() : "",
        content: p.content.trim(),
        ...(type === "skill" ? { skillId } : {}),
        risk,
        evidence,
      });
    }
  }
  return { reflection: obj.reflection, proposals };
}

function buildMinimalReflection(score: SessionScore): string {
  const friction = score.notes.length > 0 ? score.notes.map((n) => `- ${n}`).join("\n") : "- (none)";
  return [
    "## What happened",
    `Session ${score.sessionId} finished with status ${score.metrics.status} and score ${score.score}/100.`,
    "",
    "## Friction",
    friction,
    "",
    "## Lessons",
    "- (reflection model call unavailable; see score notes above)",
    "",
  ].join("\n");
}

function writeReflection(workspace: string, sessionId: string, markdown: string): void {
  const file = sessionReflectionPath(workspace, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, "utf8");
}

function degrade(workspace: string, sessionId: string, score: SessionScore): ReflectOnSessionResult {
  const reflectionMarkdown = buildMinimalReflection(score);
  try {
    writeReflection(workspace, sessionId, reflectionMarkdown);
  } catch {
    // Even fs failures must not propagate.
  }
  return { reflectionMarkdown, proposals: [] };
}

export async function reflectOnSession(
  provider: ChatProvider,
  input: ReflectOnSessionInput,
): Promise<ReflectOnSessionResult> {
  const { workspace, sessionId } = input;
  // A missing session is a caller error and intentionally throws (see tests);
  // only model/parse failures degrade below.
  const score = scoreSession(workspace, sessionId);

  let parsed: ParsedReflection | undefined;
  try {
    const response = await provider.chat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildReflectionDigest(workspace, sessionId, score) },
      ],
      temperature: 0,
      maxTokens: 2048,
    });
    parsed = parseReflection(response.content);
  } catch {
    parsed = undefined;
  }
  if (!parsed) return degrade(workspace, sessionId, score);

  try {
    const existing = readEvolutionProposals(workspace);
    const knownKeys = new Set(existing.map((p) => `${p.type} ${p.title}`));
    const sessionOffset = existing.filter((p) => p.sessionId === sessionId).length;

    const createdAt = new Date().toISOString();
    const proposals: EvolutionProposal[] = [];
    for (const p of parsed.proposals) {
      if (INJECTION_PATTERN.test(p.content) || INJECTION_PATTERN.test(p.title)) continue;
      const key = `${p.type} ${p.title}`;
      if (knownKeys.has(key)) continue;
      knownKeys.add(key);
      proposals.push({
        id: `ep-${sessionId}-${sessionOffset + proposals.length + 1}`,
        sessionId,
        type: p.type,
        title: p.title,
        problem: p.problem,
        evidence: p.evidence,
        proposal: { content: p.content, ...(p.skillId ? { skillId: p.skillId } : {}) },
        risk: p.risk,
        status: "pending",
        createdAt,
      });
    }

    appendEvolutionProposals(workspace, proposals);
    writeReflection(workspace, sessionId, parsed.reflection);
    return { reflectionMarkdown: parsed.reflection, proposals };
  } catch {
    return degrade(workspace, sessionId, score);
  }
}
