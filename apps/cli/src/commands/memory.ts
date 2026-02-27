import {
  approveMemoryCandidate,
  listMemoryCandidates,
  readProjectMemory,
  rejectMemoryCandidate,
} from "@seekforge/core";

export function memoryListCommand(): void {
  const workspace = process.cwd();
  const memory = readProjectMemory(workspace);
  console.log(memory ? `# project.md\n${memory}` : "project.md: (empty)");

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
