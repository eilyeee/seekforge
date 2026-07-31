import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useT } from "../../lib/i18n";
import type { EngineeringGraphPlanSummary, EngineeringGraphSimulationSummary } from "../../types";
import { Button } from "../ui";

const INITIAL_DEFINITION = JSON.stringify(
  {
    graphId: "desktop-graph",
    adaptiveScheduling: true,
    maxConcurrency: 2,
    nodes: [{ id: "start", kind: "function", handler: "noop" }],
  },
  null,
  2,
);

function templateLabel(value: unknown, index: number): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `Template ${index + 1}`;
  const record = value as Record<string, unknown>;
  return `${String(record.templateId ?? record.id ?? `Template ${index + 1}`)}@${String(record.version ?? "latest")}`;
}

export function GraphCreationSection(props: { workspaceId?: string; onStarted: (runId: string) => void }) {
  const t = useT();
  const [definitionText, setDefinitionText] = useState(INITIAL_DEFINITION);
  const [parametersText, setParametersText] = useState("{}");
  const [templates, setTemplates] = useState<unknown[]>([]);
  const [plan, setPlan] = useState<EngineeringGraphPlanSummary>();
  const [simulation, setSimulation] = useState<EngineeringGraphSimulationSummary>();
  const [validatedSource, setValidatedSource] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const source = `${definitionText}\0${parametersText}`;
  const previewCurrent = validatedSource === source;

  useEffect(() => {
    const current = ++generation.current;
    setPlan(undefined);
    setSimulation(undefined);
    setValidatedSource(undefined);
    setError("");
    void api
      .graphTemplates(props.workspaceId)
      .then((items) => {
        if (generation.current === current) setTemplates(items);
      })
      .catch((caught) => {
        if (generation.current === current) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      generation.current += 1;
    };
  }, [props.workspaceId]);

  const parsed = useMemo(() => {
    try {
      const definition = JSON.parse(definitionText) as unknown;
      const parameters = JSON.parse(parametersText) as unknown;
      if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
        throw new Error("Graph parameters must be a JSON object");
      }
      return { definition, parameters: parameters as Record<string, unknown> };
    } catch (caught) {
      return { error: caught instanceof Error ? caught.message : String(caught) };
    }
  }, [definitionText, parametersText]);

  const preview = async () => {
    if ("error" in parsed) return setError(parsed.error ?? "Invalid Graph JSON");
    const request = ++generation.current;
    const requestedSource = source;
    setBusy(true);
    try {
      const [validated, simulated] = await Promise.all([
        api.graphValidate(parsed.definition, parsed.parameters, props.workspaceId),
        api.graphSimulate(parsed.definition, parsed.parameters, props.workspaceId),
      ]);
      if (generation.current !== request) return;
      setPlan(validated.plan);
      setSimulation(simulated);
      setValidatedSource(requestedSource);
      setError("");
    } catch (caught) {
      if (generation.current === request) {
        setPlan(undefined);
        setSimulation(undefined);
        setValidatedSource(undefined);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  const start = async () => {
    if (!previewCurrent || "error" in parsed) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const started = await api.graphStart(parsed.definition, parsed.parameters, props.workspaceId);
      if (generation.current === request) {
        setError("");
        props.onStarted(started.runId);
      }
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };

  return (
    <section className="mt-3 rounded border border-subtle p-2 text-xs text-secondary">
      <p className="font-medium">{t("chat.loop.graph.createTitle")}</p>
      {templates.length > 0 && (
        <select
          className="mt-2 w-full rounded border border-subtle bg-surface px-2 py-1"
          defaultValue=""
          onChange={(event) => {
            const index = Number(event.target.value);
            if (Number.isSafeInteger(index) && templates[index] !== undefined) {
              setDefinitionText(JSON.stringify(templates[index], null, 2));
              setValidatedSource(undefined);
            }
          }}
        >
          <option value="">{t("chat.loop.graph.chooseTemplate")}</option>
          {templates.map((template, index) => (
            <option key={templateLabel(template, index)} value={index}>
              {templateLabel(template, index)}
            </option>
          ))}
        </select>
      )}
      <textarea
        className="mt-2 h-48 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
        value={definitionText}
        aria-label={t("chat.loop.graph.definition")}
        onChange={(event) => {
          setDefinitionText(event.target.value);
          setValidatedSource(undefined);
        }}
      />
      <textarea
        className="mt-2 h-20 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
        value={parametersText}
        aria-label={t("chat.loop.graph.parameters")}
        onChange={(event) => {
          setParametersText(event.target.value);
          setValidatedSource(undefined);
        }}
      />
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void preview()}>
          {t("chat.loop.graph.preview")}
        </Button>
        <Button size="sm" disabled={busy || !previewCurrent} onClick={() => void start()}>
          {t("chat.loop.graph.start")}
        </Button>
      </div>
      {error && <p className="mt-2 text-danger">{error}</p>}
      {plan && simulation && previewCurrent && (
        <div className="mt-2 rounded border border-subtle p-2">
          <p>
            {plan.graphId} · {plan.nodeCount} nodes · {plan.waves.length} waves · max {plan.maxConcurrency}
          </p>
          <p className="text-tertiary">
            P50 {simulation.makespanMs}ms · ${simulation.estimatedCostUsd.toFixed(4)} · {simulation.estimatedTokens}{" "}
            tokens
          </p>
          <p className="text-tertiary">critical: {simulation.criticalPath.join(" → ") || "-"}</p>
          {simulation.risks.length > 0 && <p className="text-warn">{simulation.risks.join("; ")}</p>}
          <div className="mt-2 flex flex-wrap gap-1">
            {plan.waves.map((wave, index) => (
              <span key={`${index}-${wave.join("-")}`} className="rounded border border-subtle px-1">
                W{index + 1}: {wave.join(", ")}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
