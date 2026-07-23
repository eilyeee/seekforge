import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "../../src/tools/index.js";

export function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-test-"));
}

export function makeCtx(
  workspace: string,
  overrides: Partial<Omit<ToolContext, "policy">> & { policy?: Partial<ToolContext["policy"]> } = {},
): ToolContext {
  const { policy, ...rest } = overrides;
  return {
    sessionId: "test-session",
    workspace,
    policy: {
      approvalMode: "auto",
      mode: "edit",
      commandAllowlist: [],
      ...policy,
    },
    confirm: async () => true,
    ...rest,
  };
}

let nextId = 0;
export function call(name: string, args: unknown = {}): { id: string; name: string; arguments: unknown } {
  return { id: `call-${nextId++}`, name, arguments: args };
}
