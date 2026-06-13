import {
  addMemoryFact,
  approveMemoryCandidate,
  compactProjectMemory,
  listMemoryCandidates,
  listProjectFacts,
  MEMORY_CANDIDATE_TYPES,
  projectMemoryPath,
  rejectMemoryCandidate,
  removeCandidate,
  removeProjectFact,
  type MemoryCandidateType,
} from "@seekforge/core";
import { t } from "../i18n.js";

export function memoryListCommand(): void {
  const workspace = process.cwd();
  const facts = listProjectFacts(workspace);
  if (facts.length === 0) {
    console.log(t("cmd.memory.noFacts"));
  } else {
    console.log(t("cmd.memory.factsHeader"));
    for (const fact of facts) {
      console.log(t("cmd.memory.factLine", { index: fact.index, line: fact.line }));
    }
  }

  const pending = listMemoryCandidates(workspace).filter((c) => c.status === "pending");
  if (pending.length === 0) {
    console.log(t("cmd.memory.noPending"));
    return;
  }
  console.log(`\n${t("cmd.memory.pendingHeader")}`);
  for (const c of pending) {
    console.log(t("cmd.memory.pendingCandidate", { id: c.id, type: c.type, confidence: c.confidence.toFixed(2), content: c.content }));
  }
}

export function memoryAddCommand(words: string[], opts: { type?: string; pending?: boolean }): void {
  const type = opts.type ?? "convention";
  if (!MEMORY_CANDIDATE_TYPES.includes(type as MemoryCandidateType)) {
    console.error(t("err.invalidMemoryType", { type, expected: MEMORY_CANDIDATE_TYPES.join(" | ") }));
    process.exitCode = 1;
    return;
  }
  const workspace = process.cwd();
  try {
    const candidate = addMemoryFact(workspace, {
      content: words.join(" "),
      type: type as MemoryCandidateType,
      approve: !opts.pending,
    });
    if (opts.pending) {
      console.log(
        t("cmd.memory.addedQueued", { id: candidate.id, type: candidate.type, content: candidate.content }),
      );
    } else {
      console.log(t("cmd.memory.addedTo", { path: projectMemoryPath(workspace) }));
      console.log(t("cmd.memory.addedFact", { type: candidate.type, content: candidate.content }));
      console.log(t("cmd.memory.auditCandidate", { id: candidate.id }));
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function memoryRemoveCommand(selector: string): void {
  const workspace = process.cwd();
  try {
    if (/^\d+$/.test(selector)) {
      const line = removeProjectFact(workspace, { index: Number.parseInt(selector, 10) });
      console.log(t("cmd.memory.removedFact", { selector, content: line }));
    } else if (selector.startsWith("mc-")) {
      const candidate = removeCandidate(workspace, selector);
      console.log(t("cmd.memory.deletedCandidate", { id: candidate.id, content: candidate.content }));
    } else {
      const line = removeProjectFact(workspace, { match: selector });
      console.log(t("cmd.memory.removedFact", { selector, content: line }));
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function memoryApproveCommand(id: string): void {
  try {
    const c = approveMemoryCandidate(process.cwd(), id);
    console.log(t("cmd.memory.approved", { content: c.content }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function memoryRejectCommand(id: string): void {
  try {
    rejectMemoryCandidate(process.cwd(), id);
    console.log(t("cmd.memory.rejected", { id }));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function memoryCompactCommand(opts: { dryRun?: boolean }): void {
  const workspace = process.cwd();
  const res = compactProjectMemory(workspace, { dryRun: opts.dryRun });
  const label = opts.dryRun ? t("cmd.memory.wouldCompact") : t("cmd.memory.compactedLabel");
  console.log(t("cmd.memory.compacted", { verb: label, before: res.before, after: res.after }));
  if (res.removed.length > 0) {
    console.log(t("cmd.memory.duplicatesHeader", { count: res.removed.length }));
    for (const line of res.removed) console.log(`  - ${line}`);
  }
  if (res.merged.length > 0) {
    console.log(t("cmd.memory.mergedHeader", { count: res.merged.length }));
    for (const m of res.merged) {
      console.log(t("cmd.memory.mergedKeep", { line: m.kept }));
      console.log(t("cmd.memory.mergedDrop", { line: m.dropped }));
    }
  }
  if (res.removed.length === 0 && res.merged.length === 0) {
    console.log(t("cmd.memory.nothingToCompact"));
  } else if (opts.dryRun) {
    console.log(t("cmd.memory.dryRunNote"));
  }
}
