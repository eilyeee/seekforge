import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../../lib/i18n";
import type { WorkspaceOrchestrationReport } from "../../types";
import { OrchestrationIntelligenceSection } from "./OrchestrationIntelligenceSection";

setLocale("en");

const noop = (): void => undefined;

const report: WorkspaceOrchestrationReport = {
  portfolio: {
    generatedAt: "2026-01-01T00:00:00.000Z",
    status: "warning",
    totals: {
      loops: 1,
      graphs: 0,
      costUsd: 0.5,
      tokensUsed: 1_000,
      activeDurationMs: 1_000,
      configuredCostBudgetUsd: 0,
      configuredTokenBudget: 0,
      configuredDurationBudgetMs: 0,
    },
    items: [],
  },
  policy: {},
  policyState: {
    version: 1,
    policy: { maxP95DurationMs: 120_000, maxCostUsd: 1.5, maxFailureRate: 0.2, minForecastCoverage: 0.8 },
    evaluationWindow: 50,
    maxBreachRate: 0.1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  controlAnalytics: {
    generatedAt: "2026-01-01T00:00:00.000Z",
    observations: 0,
    burnRates: [],
    calibration: { samples: 0, meanAbsoluteErrorMs: 0, p95Coverage: 0, brierScore: 0, confidence: "none" },
  },
  controller: { mode: "active", reason: "healthy", updatedAt: "2026-01-01T00:00:00.000Z" },
  decisions: [],
  contextualRouting: { generatedAt: "2026-01-01T00:00:00.000Z", loops: 0, samples: 0, routes: [] },
  executorCapacity: [],
  sloSummary: {
    scope: "page",
    evaluations: 4,
    breached: 1,
    breachRate: 0.25,
    maxBreachRate: 0.1,
    status: "breached",
    errorBudgetRemaining: 0,
  },
  pagination: { loopOffset: 0, graphOffset: 0, limit: 100, totalLoops: 0, totalGraphs: 0 },
  loops: [],
  graphs: [],
  reviewedProposals: [],
  deployments: [],
  rollouts: [],
};

function render(value?: WorkspaceOrchestrationReport): string {
  return renderToStaticMarkup(
    createElement(OrchestrationIntelligenceSection, {
      report: value,
      busy: false,
      onRefresh: noop,
      onMaintain: noop,
      onProposalReview: noop,
      onProposalApply: noop,
      onProposalRollback: noop,
      onRolloutStart: noop,
      onRolloutAdvance: noop,
      onRolloutPause: noop,
      onRolloutResume: noop,
      onObserve: noop,
      onControllerResume: noop,
    }),
  );
}

describe("OrchestrationIntelligenceSection", () => {
  /**
   * Looking at the report used to run a maintenance tick, which records
   * proposals, reconciles rollouts and can freeze the adaptive controller. The
   * read and the write are now two separate buttons.
   */
  it("separates the read-only reload from the maintenance tick", () => {
    const markup = render();
    expect(markup).toContain("Refresh</button>");
    // Two buttons that both read as reloads are not separated. The writer has
    // to say it writes.
    expect(markup).toContain("Run maintenance</button>");
    expect(markup).not.toContain("Refresh proposals</button>");
  });

  /** The panel judges SLO breaches; the thresholds behind that verdict were invisible. */
  it("shows the persisted SLO policy that produces the breach verdict", () => {
    const markup = render(report);
    expect(markup).toContain("SLO policy");
    expect(markup).toContain("P95 ≤ 120000ms");
    expect(markup).toContain("fail ≤ 20.0%");
    expect(markup).toContain("coverage ≥ 80.0%");
    expect(markup).toContain("window 50");
    expect(markup).toContain("breach ≤ 10.0%");
  });

  it("omits the policy line when no policy has been persisted", () => {
    const { policyState: _unset, ...withoutPolicy } = report;
    expect(render(withoutPolicy)).not.toContain("SLO policy");
  });
});
