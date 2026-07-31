import { formatCostUsd } from "@seekforge/shared/format";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import type { OrchestrationProposal, WorkspaceOrchestrationReport } from "../../types";
import { Badge, Button } from "../ui";

export function OrchestrationIntelligenceSection(props: {
  report?: WorkspaceOrchestrationReport;
  busy: boolean;
  onRefresh: () => void;
  onProposalReview: (proposal: OrchestrationProposal, status: "approve" | "dismiss") => void;
  onProposalApply: (proposal: OrchestrationProposal) => void;
  onProposalRollback: (proposal: OrchestrationProposal) => void;
  onRolloutStart: (proposal: OrchestrationProposal, minSamples: number) => void;
  onRolloutAdvance: (proposal: OrchestrationProposal) => void;
  onRolloutPause: (proposal: OrchestrationProposal, reason?: string) => void;
  onRolloutResume: (proposal: OrchestrationProposal) => void;
  onObserve: (autoRollback: boolean) => void;
  onControllerResume: (reason?: string) => void;
}) {
  const t = useT();
  const report = props.report;
  const [minSamples, setMinSamples] = useState(3);
  const [autoRollback, setAutoRollback] = useState(false);
  return (
    <section className="mt-3 rounded border border-subtle p-2 text-xs text-secondary">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{t("chat.loop.orchestration.title")}</p>
        <Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onRefresh}>
          {t("chat.loop.orchestration.refresh")}
        </Button>
      </div>
      {!report ? (
        <p className="mt-1 text-tertiary">{t("chat.loop.orchestration.empty")}</p>
      ) : (
        <>
          <p className="mt-1">
            <Badge
              tone={
                report.portfolio.status === "healthy"
                  ? "ok"
                  : report.portfolio.status === "critical"
                    ? "danger"
                    : "warn"
              }
            >
              {report.portfolio.status}
            </Badge>
            {` · ${report.portfolio.totals.loops} Loop · ${report.portfolio.totals.graphs} Graph · ${formatCostUsd(
              report.portfolio.totals.costUsd,
            )} · ${report.portfolio.totals.tokensUsed.toLocaleString()} tokens`}
          </p>
          <p className="mt-1 text-tertiary">
            {t("chat.loop.orchestration.slo")}: {report.sloSummary.status} ·{" "}
            {(report.sloSummary.breachRate * 100).toFixed(1)}%
            {` · ${report.sloSummary.evaluations} ${t("chat.loop.orchestration.evaluations")}`}
          </p>
          <p className="mt-1 text-tertiary">
            {t("chat.loop.orchestration.controller")}: {report.controller.mode} · {report.controller.reason}
            {` · ${report.decisions.length} ${t("chat.loop.orchestration.decisions")}`}
            {report.controller.mode === "frozen" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={props.busy}
                onClick={() =>
                  props.onControllerResume(
                    window.prompt(t("chat.loop.orchestration.resumeReason"))?.trim() || undefined,
                  )
                }
              >
                {t("chat.loop.orchestration.resumeController")}
              </Button>
            )}
          </p>
          <p className="mt-1 text-tertiary">
            {t("chat.loop.orchestration.control")}:{" "}
            {report.controlAnalytics.burnRates
              .map((window) => `${window.hours}h ${window.burnRate.toFixed(2)}x/${window.status}`)
              .join(" · ")}{" "}
            · {t("chat.loop.orchestration.calibration")} {report.controlAnalytics.calibration.samples}/
            {(report.controlAnalytics.calibration.p95Coverage * 100).toFixed(1)}%
          </p>
          {report.contextualRouting.routes.length > 0 && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.contextual")}:{" "}
              {report.contextualRouting.routes
                .slice(0, 4)
                .map((route) => `${route.context}/${route.failureCategory} → ${route.model}`)
                .join("; ")}
            </p>
          )}
          {report.executorCapacity.length > 0 && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.capacity")}:{" "}
              {report.executorCapacity
                .map((item) => `${item.executor} ${item.active}/${item.capacity} (+${item.queueDepth})`)
                .join("; ")}
            </p>
          )}
          {report.loops.some((loop) => loop.strategy.recommendedRoutes.length > 0) && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.routes")}:{" "}
              {report.loops
                .flatMap((loop) =>
                  loop.strategy.recommendedRoutes.map(
                    (route) => `${loop.loopId}/${route.failureCategory} → ${route.model} (${route.confidence})`,
                  ),
                )
                .join("; ")}
            </p>
          )}
          {report.graphs.some((graph) => graph.optimization.scenarios.some((scenario) => scenario.paretoOptimal)) && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.frontier")}:{" "}
              {report.graphs
                .flatMap((graph) =>
                  graph.optimization.scenarios
                    .filter((scenario) => scenario.paretoOptimal)
                    .slice(0, 2)
                    .map((scenario) => `${graph.graphId} -${scenario.predictedSavingsMs}ms`),
                )
                .join("; ")}
            </p>
          )}
          {report.graphs.some((graph) => graph.artifactReuse.length > 0) && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.reuse")}:{" "}
              {report.graphs.reduce((sum, graph) => sum + graph.artifactReuse.length, 0)} · CAS{" "}
              {report.graphs.reduce(
                (sum, graph) => sum + graph.artifactReuse.filter((artifact) => artifact.casAvailable).length,
                0,
              )}{" "}
              · {t("chat.loop.orchestration.attestations")}{" "}
              {report.graphs.reduce(
                (sum, graph) =>
                  sum + graph.artifactReuse.reduce((count, artifact) => count + artifact.attestationCount, 0),
                0,
              )}
            </p>
          )}
          {report.graphs.some((graph) => graph.runtimeReplan.recommendedOrder.length > 0) && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.replan")}:{" "}
              {report.graphs
                .filter((graph) => graph.runtimeReplan.recommendedOrder.length > 0)
                .map((graph) => `${graph.graphId} → ${graph.runtimeReplan.recommendedOrder.join(", ")}`)
                .join("; ")}
            </p>
          )}
          {report.graphs.some((graph) => graph.optimization.uncertainty.sensitivity.length > 0) && (
            <p className="mt-1 text-tertiary">
              {t("chat.loop.orchestration.uncertainty")}:{" "}
              {report.graphs
                .map(
                  (graph) =>
                    `${graph.graphId} P95 ${graph.optimization.uncertainty.makespanMs.p95}ms / P99 ${graph.optimization.uncertainty.makespanMs.p99}ms`,
                )
                .join("; ")}
            </p>
          )}
          {report.reviewedProposals.length > 0 && (
            <div className="mt-2 space-y-1">
              <label className="text-tertiary">
                {t("chat.loop.orchestration.minSamples")}{" "}
                <input
                  className="w-16 rounded border border-subtle bg-surface px-1"
                  type="number"
                  min={1}
                  max={32}
                  value={minSamples}
                  onChange={(event) => setMinSamples(Math.max(1, Math.min(32, Number(event.target.value) || 1)))}
                />
              </label>
              {report.reviewedProposals.map((proposal) => (
                <div key={proposal.id} className="flex flex-wrap items-center gap-1 rounded border border-subtle p-1">
                  <Badge
                    tone={proposal.status === "approved" ? "ok" : proposal.status === "dismissed" ? "neutral" : "warn"}
                  >
                    {proposal.status}
                  </Badge>
                  <span>{proposal.title}</span>
                  <span className="text-tertiary">
                    ({proposal.confidence}/{proposal.evidenceCount})
                  </span>
                  <details className="basis-full text-tertiary">
                    <summary className="cursor-pointer">{t("chat.loop.orchestration.evidence")}</summary>
                    <p className="mt-1 break-words">{proposal.rationale}</p>
                    <pre className="mt-1 overflow-auto text-2xs">{JSON.stringify(proposal.action, null, 2)}</pre>
                  </details>
                  {proposal.status === "proposed" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => props.onProposalReview(proposal, "approve")}
                      >
                        {t("chat.loop.orchestration.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => props.onProposalReview(proposal, "dismiss")}
                      >
                        {t("chat.loop.orchestration.dismiss")}
                      </Button>
                    </>
                  )}
                  {proposal.status === "approved" &&
                    proposal.action.kind !== "budget_review" &&
                    !report.rollouts.some(
                      (rollout) => rollout.proposalId === proposal.id && rollout.phase !== "failed",
                    ) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => props.onRolloutStart(proposal, minSamples)}
                      >
                        {t("chat.loop.orchestration.startRollout")}
                      </Button>
                    )}
                  {report.rollouts.some(
                    (rollout) => rollout.proposalId === proposal.id && rollout.phase === "shadow",
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => props.onRolloutAdvance(proposal)}
                    >
                      {t("chat.loop.orchestration.startCanary")}
                    </Button>
                  )}
                  {report.rollouts.some(
                    (rollout) =>
                      rollout.proposalId === proposal.id &&
                      rollout.phase === "canary" &&
                      rollout.stageObservationIds.length >= rollout.minSamples,
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => props.onRolloutAdvance(proposal)}
                    >
                      {t("chat.loop.orchestration.advanceRollout")}
                    </Button>
                  )}
                  {report.rollouts.some(
                    (rollout) => rollout.proposalId === proposal.id && rollout.phase === "canary",
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() =>
                        props.onRolloutPause(
                          proposal,
                          window.prompt(t("chat.loop.orchestration.pauseReason"))?.trim() || undefined,
                        )
                      }
                    >
                      {t("chat.loop.orchestration.pauseRollout")}
                    </Button>
                  )}
                  {report.rollouts.some(
                    (rollout) => rollout.proposalId === proposal.id && rollout.phase === "paused",
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => props.onRolloutResume(proposal)}
                    >
                      {t("chat.loop.orchestration.resumeRollout")}
                    </Button>
                  )}
                  {proposal.status === "approved" &&
                    proposal.action.kind !== "budget_review" &&
                    !report.deployments.some(
                      (deployment) => deployment.proposalId === proposal.id && deployment.status === "applied",
                    ) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => props.onProposalApply(proposal)}
                      >
                        {t("chat.loop.orchestration.apply")}
                      </Button>
                    )}
                  {report.deployments.some(
                    (deployment) => deployment.proposalId === proposal.id && deployment.status === "applied",
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => props.onProposalRollback(proposal)}
                    >
                      {t("chat.loop.orchestration.rollback")}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {report.deployments.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.onObserve(autoRollback)}>
                {t("chat.loop.orchestration.observe")}
              </Button>
              <label className="text-tertiary">
                <input
                  type="checkbox"
                  checked={autoRollback}
                  onChange={(event) => setAutoRollback(event.target.checked)}
                />{" "}
                {t("chat.loop.orchestration.autoRollback")}
              </label>
              <span className="text-tertiary">
                {report.deployments
                  .map((deployment) => `${deployment.proposalId}: ${deployment.status}/${deployment.verdict}`)
                  .join("; ")}
              </span>
            </div>
          )}
          {report.rollouts.length > 0 && (
            <details className="mt-1 text-tertiary">
              <summary className="cursor-pointer">{t("chat.loop.orchestration.rollouts")}</summary>
              <p>
                {t("chat.loop.orchestration.rollouts")}:{" "}
                {report.rollouts
                  .map(
                    (rollout) =>
                      `${rollout.proposalId}: ${rollout.phase}/${rollout.stagePercent}% (${rollout.stageObservationIds.length}/${rollout.minSamples}) · ${rollout.timeline.at(-1)?.event ?? "unknown"}`,
                  )
                  .join("; ")}
              </p>
              {report.rollouts.map((rollout) => (
                <div key={rollout.proposalId} className="mt-1 rounded border border-subtle p-1">
                  {rollout.timeline.slice(-5).map((item, index) => (
                    <p key={`${item.at}-${index}`} className="break-words text-2xs">
                      {item.at}: {item.event}
                      {item.reason ? ` · ${item.reason}` : ""}
                    </p>
                  ))}
                </div>
              ))}
            </details>
          )}
          <p className="mt-1 text-tertiary">{t("chat.loop.orchestration.advisory")}</p>
        </>
      )}
    </section>
  );
}
