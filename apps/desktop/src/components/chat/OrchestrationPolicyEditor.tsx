import { useT } from "../../lib/i18n";
import {
  ORCHESTRATION_POLICY_FIELDS,
  orchestrationPolicyChanged,
  type OrchestrationPolicyDraft,
  type OrchestrationPolicyField,
} from "../../lib/orchestration-policy-input";
import type { WorkspaceOrchestrationReport } from "../../types";
import { Button } from "../ui";

const LABEL_KEY: Record<OrchestrationPolicyField, string> = {
  maxP95DurationMs: "chat.loop.orchestration.policyEdit.maxP95DurationMs",
  maxCostUsd: "chat.loop.orchestration.policyEdit.maxCostUsd",
  maxFailureRate: "chat.loop.orchestration.policyEdit.maxFailureRate",
  minForecastCoverage: "chat.loop.orchestration.policyEdit.minForecastCoverage",
  evaluationWindow: "chat.loop.orchestration.policyEdit.evaluationWindow",
  maxBreachRate: "chat.loop.orchestration.policyEdit.maxBreachRate",
};

/**
 * Editor for the SLO thresholds the panel above judges breaches against.
 *
 * The inputs carry no `min`/`max`: the route and core own the bounds, and a
 * widget that quietly refuses a value the server would have explained is the
 * second rule set this is written to avoid. The label states the accepted range
 * so it is visible; the server still decides.
 */
export function OrchestrationPolicyEditor(props: {
  draft: OrchestrationPolicyDraft;
  /** The persisted policy the draft was filled from (undefined = none yet). */
  state: WorkspaceOrchestrationReport["policyState"];
  busy: boolean;
  onDraftChange: (draft: OrchestrationPolicyDraft) => void;
  onSave: () => void;
}) {
  const t = useT();
  const changed = orchestrationPolicyChanged(props.draft, props.state);
  return (
    <details className="mt-1 rounded border border-subtle p-1">
      <summary className="cursor-pointer text-tertiary">{t("chat.loop.orchestration.policyEdit.title")}</summary>
      <p className="mt-1 text-tertiary">{t("chat.loop.orchestration.policyEdit.caption")}</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {ORCHESTRATION_POLICY_FIELDS.map((field) => (
          <label key={field} className="text-tertiary">
            {t(LABEL_KEY[field])}{" "}
            <input
              className="w-24 rounded border border-subtle bg-surface px-1"
              type="number"
              step="any"
              inputMode="decimal"
              value={props.draft[field]}
              onChange={(event) => props.onDraftChange({ ...props.draft, [field]: event.target.value })}
            />
          </label>
        ))}
      </div>
      <p className="mt-1 text-tertiary">{t("chat.loop.orchestration.policyEdit.blank")}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={props.busy || !changed} onClick={props.onSave}>
          {t("chat.loop.orchestration.policyEdit.save")}
        </Button>
        <span className="text-tertiary">
          {props.state
            ? `${t("chat.loop.orchestration.policyEdit.concurrency")} (${props.state.updatedAt})`
            : t("chat.loop.orchestration.policyEdit.first")}
        </span>
      </div>
    </details>
  );
}
