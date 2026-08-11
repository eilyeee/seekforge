import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./LoopManager.tsx", import.meta.url), "utf8");

function body(name: string): string {
  const start = source.indexOf(`const ${name} = async (`);
  expect(start, `${name} is not declared`).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  expect(end, `${name} has no closing brace`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Rendering the orchestration report used to POST /api/orchestration/maintain
 * first, so opening the panel recorded proposals, reconciled rollouts and could
 * freeze the adaptive controller. The desktop cannot be driven in this node-only
 * suite, so the invariant is asserted against the call sites themselves.
 */
describe("LoopManager orchestration data flow", () => {
  it("reads the orchestration report without any write request", () => {
    const refresh = body("refreshOrchestration");
    expect(refresh).toContain("api.orchestrationReport(");
    for (const write of [
      "api.orchestrationMaintain(",
      "api.orchestrationProposalRefresh(",
      "api.orchestrationRolloutReconcile(",
      "api.orchestrationDeploymentObserve(",
      "api.orchestrationControllerResume(",
    ]) {
      expect(refresh, `refreshOrchestration must not call ${write}`).not.toContain(write);
    }
  });

  it("keeps the maintenance tick reachable as its own explicit action", () => {
    expect(body("maintainOrchestration")).toContain("api.orchestrationMaintain(");
    expect(source).toContain("onMaintain={() => void maintainOrchestration()}");
  });
});
