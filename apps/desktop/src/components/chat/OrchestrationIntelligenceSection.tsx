import { formatCostUsd } from "@seekforge/shared/format";
import { useT } from "../../lib/i18n";
import type { OrchestrationProposal, WorkspaceOrchestrationReport } from "../../types";
import { Badge, Button } from "../ui";

export function OrchestrationIntelligenceSection(props: {
  report?: WorkspaceOrchestrationReport;
  busy: boolean;
  onRefresh: () => void;
  onProposalReview: (proposal: OrchestrationProposal, status: "approve" | "dismiss") => void;
}) {
  const t = useT();
  const report = props.report;
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
              {report.graphs.reduce((sum, graph) => sum + graph.artifactReuse.length, 0)}
            </p>
          )}
          {report.reviewedProposals.length > 0 && (
            <div className="mt-2 space-y-1">
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
                </div>
              ))}
            </div>
          )}
          <p className="mt-1 text-tertiary">{t("chat.loop.orchestration.advisory")}</p>
        </>
      )}
    </section>
  );
}
