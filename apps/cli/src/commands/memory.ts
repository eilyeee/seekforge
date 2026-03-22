import {
  addMemoryFact,
  approveMemoryCandidate,
  listMemoryCandidates,
  listProjectFacts,
  MEMORY_CANDIDATE_TYPES,
  projectMemoryPath,
  rejectMemoryCandidate,
  removeCandidate,
  removeProjectFact,
  type MemoryCandidateType,
} from "@seekforge/core";

export function memoryListCommand(): void {
  const workspace = process.cwd();
  const facts = listProjectFacts(workspace);
  if (facts.length === 0) {
    console.log("project.md: (no facts)");
  } else {
    console.log("Project facts (remove with `seekforge memory remove <n>`):");
    for (const fact of facts) {
      console.log(`  ${fact.index}. ${fact.line}`);
    }
  }

  const pending = listMemoryCandidates(workspace).filter((c) => c.status === "pending");
  if (pending.length === 0) {
    console.log("\nNo pending memory candidates.");
    return;
  }
  console.log(`\nPending candidates (approve with \`seekforge memory approve <id>\`):`);
  for (const c of pending) {
    console.log(`  ${c.id}  [${c.type}] (${c.confidence.toFixed(2)})  ${c.content}`);
  }
}

export function memoryAddCommand(words: string[], opts: { type?: string; pending?: boolean }): void {
  const type = opts.type ?? "convention";
  if (!MEMORY_CANDIDATE_TYPES.includes(type as MemoryCandidateType)) {
    console.error(`invalid --type ${type} (expected: ${MEMORY_CANDIDATE_TYPES.join(" | ")})`);
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
        `queued pending candidate ${candidate.id}: [${candidate.type}] ${candidate.content}\n` +
          `approve with \`seekforge memory approve ${candidate.id}\``,
      );
    } else {
      console.log(`added to ${projectMemoryPath(workspace)}:`);
      console.log(`  - [${candidate.type}] ${candidate.content}`);
      console.log(`audit candidate: ${candidate.id}`);
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
      console.log(`removed fact ${selector}: ${line}`);
    } else if (selector.startsWith("mc-")) {
      const candidate = removeCandidate(workspace, selector);
      console.log(`deleted candidate ${candidate.id}: ${candidate.content}`);
    } else {
      const line = removeProjectFact(workspace, { match: selector });
      console.log(`removed fact: ${line}`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function memoryApproveCommand(id: string): void {
  try {
    const c = approveMemoryCandidate(process.cwd(), id);
    console.log(`approved → project.md: ${c.content}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}

export function memoryRejectCommand(id: string): void {
  try {
    rejectMemoryCandidate(process.cwd(), id);
    console.log(`rejected ${id}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
