import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  decodeDesktopGraphTemplates,
  graphTemplateDefaultParameters,
  graphTemplateVisualDefinition,
  type DesktopGraphTemplate,
} from "../../lib/graph-template-ui";
import { useT } from "../../lib/i18n";
import type { EngineeringGraphPlanSummary, EngineeringGraphSimulationSummary } from "../../types";
import { appendGraphNode, buildVisualGraph, removeGraphNode, setGraphNodeDependencies } from "../../lib/graph-visual";
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

export function GraphCreationSection(props: { workspaceId?: string; onStarted: (runId: string) => void }) {
  const t = useT();
  const [definitionText, setDefinitionText] = useState(INITIAL_DEFINITION);
  const [parametersText, setParametersText] = useState("{}");
  const [templates, setTemplates] = useState<DesktopGraphTemplate[]>([]);
  const [skippedTemplates, setSkippedTemplates] = useState(0);
  const [plan, setPlan] = useState<EngineeringGraphPlanSummary>();
  const [simulation, setSimulation] = useState<EngineeringGraphSimulationSummary>();
  const [validatedSource, setValidatedSource] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [nodeKind, setNodeKind] = useState("function");
  const [dependencies, setDependencies] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const actionGeneration = useRef(0);
  const templateGeneration = useRef(0);
  const source = `${definitionText}\0${parametersText}`;
  const previewCurrent = validatedSource === source;

  useEffect(() => {
    actionGeneration.current += 1;
    const current = ++templateGeneration.current;
    setDefinitionText(INITIAL_DEFINITION);
    setParametersText("{}");
    setTemplates([]);
    setPlan(undefined);
    setSimulation(undefined);
    setValidatedSource(undefined);
    setBusy(false);
    setError("");
    setSkippedTemplates(0);
    setSelectedNodeId("");
    setSelectedTemplateKey("");
    void api
      .graphTemplates(props.workspaceId)
      .then((items) => {
        if (templateGeneration.current === current) {
          const decoded = decodeDesktopGraphTemplates(items);
          setTemplates(decoded.templates);
          setSkippedTemplates(decoded.skipped);
        }
      })
      .catch((caught) => {
        if (templateGeneration.current === current) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      actionGeneration.current += 1;
      templateGeneration.current += 1;
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
  const visual = useMemo(
    () => buildVisualGraph("error" in parsed ? undefined : graphTemplateVisualDefinition(parsed.definition)),
    [parsed],
  );
  const selectedNode = visual.nodes.find((node) => node.id === selectedNodeId);

  const commitDefinition = (next: unknown) => {
    actionGeneration.current += 1;
    setDefinitionText(JSON.stringify(next, null, 2));
    setSelectedTemplateKey("");
    setValidatedSource(undefined);
    setPlan(undefined);
    setSimulation(undefined);
    setBusy(false);
    setError("");
  };

  const changeDefinitionText = (next: string) => {
    actionGeneration.current += 1;
    setDefinitionText(next);
    setSelectedTemplateKey("");
    setValidatedSource(undefined);
    setPlan(undefined);
    setSimulation(undefined);
    setBusy(false);
    setError("");
  };

  const changeParametersText = (next: string) => {
    actionGeneration.current += 1;
    setParametersText(next);
    setValidatedSource(undefined);
    setPlan(undefined);
    setSimulation(undefined);
    setBusy(false);
    setError("");
  };

  const preview = async () => {
    if ("error" in parsed) return setError(parsed.error ?? "Invalid Graph JSON");
    const request = ++actionGeneration.current;
    const requestedSource = source;
    setBusy(true);
    try {
      const [validated, simulated] = await Promise.all([
        api.graphValidate(parsed.definition, parsed.parameters, props.workspaceId),
        api.graphSimulate(parsed.definition, parsed.parameters, props.workspaceId),
      ]);
      if (actionGeneration.current !== request) return;
      setPlan(validated.plan);
      setSimulation(simulated);
      setValidatedSource(requestedSource);
      setError("");
    } catch (caught) {
      if (actionGeneration.current === request) {
        setPlan(undefined);
        setSimulation(undefined);
        setValidatedSource(undefined);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (actionGeneration.current === request) setBusy(false);
    }
  };

  const start = async () => {
    if (!previewCurrent || "error" in parsed) return;
    const request = ++actionGeneration.current;
    setBusy(true);
    try {
      const started = await api.graphStart(parsed.definition, parsed.parameters, props.workspaceId);
      if (actionGeneration.current === request) {
        setError("");
        props.onStarted(started.runId);
      }
    } catch (caught) {
      if (actionGeneration.current === request) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (actionGeneration.current === request) setBusy(false);
    }
  };

  return (
    <section className="mt-3 rounded border border-subtle p-2 text-xs text-secondary">
      <p className="font-medium">{t("chat.loop.graph.createTitle")}</p>
      {templates.length > 0 && (
        <select
          className="mt-2 w-full rounded border border-subtle bg-surface px-2 py-1"
          value={templates.some((template) => template.key === selectedTemplateKey) ? selectedTemplateKey : ""}
          onChange={(event) => {
            const selected = templates.find((template) => template.key === event.target.value);
            if (selected) {
              commitDefinition(selected.template);
              changeParametersText(JSON.stringify(graphTemplateDefaultParameters(selected.template), null, 2));
              setSelectedTemplateKey(selected.key);
              setSelectedNodeId("");
            } else {
              setSelectedTemplateKey("");
            }
          }}
        >
          <option value="">{t("chat.loop.graph.chooseTemplate")}</option>
          {templates.map((template) => (
            <option key={template.key} value={template.key}>
              {template.label}
              {template.deprecated ? ` (${t("chat.loop.graph.deprecated")})` : ""}
            </option>
          ))}
        </select>
      )}
      {skippedTemplates > 0 && (
        <p className="mt-1 text-warn">{t("chat.loop.graph.templateSkipped", { count: skippedTemplates })}</p>
      )}
      <textarea
        className="mt-2 h-48 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
        value={definitionText}
        aria-label={t("chat.loop.graph.definition")}
        onChange={(event) => changeDefinitionText(event.target.value)}
      />
      {visual.nodes.length > 0 && (
        <div className="mt-2 overflow-auto rounded border border-subtle bg-surface-overlay/40 p-1">
          <svg
            viewBox={`0 0 ${visual.width} ${visual.height}`}
            className="min-h-32 min-w-full"
            style={{ width: Math.max(visual.width, 320) }}
            role="img"
            aria-label={t("chat.loop.graph.visual")}
          >
            {visual.edges.map((edge) => {
              const from = visual.nodes.find((node) => node.id === edge.from);
              const to = visual.nodes.find((node) => node.id === edge.to);
              return from && to ? (
                <line
                  key={`${edge.from}-${edge.to}`}
                  x1={from.x + 130}
                  y1={from.y + 22}
                  x2={to.x}
                  y2={to.y + 22}
                  stroke="currentColor"
                  className="text-tertiary"
                />
              ) : null;
            })}
            {visual.nodes.map((node) => (
              <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
                <rect
                  width="130"
                  height="44"
                  rx="6"
                  className={
                    node.id === selectedNodeId ? "fill-accent-muted stroke-accent" : "fill-surface stroke-accent"
                  }
                />
                <text x="8" y="18" className="fill-primary text-[11px] font-medium">
                  {node.id}
                </text>
                <text x="8" y="34" className="fill-tertiary text-[9px]">
                  {node.kind}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
      {visual.warnings.map((warning) => (
        <p key={warning} className="mt-1 text-warn">
          {warning}
        </p>
      ))}
      {visual.nodes.length > 0 && (
        <select
          className="mt-2 w-full rounded border border-subtle bg-surface px-2 py-1"
          value={selectedNode ? selectedNodeId : ""}
          onChange={(event) => setSelectedNodeId(event.target.value)}
        >
          <option value="">{t("chat.loop.graph.chooseNode")}</option>
          {visual.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.id} · {node.kind}
            </option>
          ))}
        </select>
      )}
      {selectedNode && !("error" in parsed) && (
        <div className="mt-2 rounded border border-subtle p-2">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">
              {t("chat.loop.graph.selectedNode")}: {selectedNode.id} · {selectedNode.kind}
            </p>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                try {
                  commitDefinition(removeGraphNode(parsed.definition, selectedNode.id));
                  setSelectedNodeId("");
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : String(caught));
                }
              }}
            >
              {t("chat.loop.graph.removeNode")}
            </Button>
          </div>
          <p className="mt-2 text-tertiary">{t("chat.loop.graph.editDependencies")}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {visual.nodes
              .filter((node) => node.id !== selectedNode.id)
              .map((candidate) => (
                <label key={candidate.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={selectedNode.dependsOn.includes(candidate.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selectedNode.dependsOn, candidate.id]
                        : selectedNode.dependsOn.filter((id) => id !== candidate.id);
                      try {
                        commitDefinition(setGraphNodeDependencies(parsed.definition, selectedNode.id, next));
                      } catch (caught) {
                        setError(caught instanceof Error ? caught.message : String(caught));
                      }
                    }}
                  />
                  {candidate.id}
                </label>
              ))}
          </div>
        </div>
      )}
      <div className="mt-2 grid gap-1 sm:grid-cols-4">
        <input
          className="rounded border border-subtle bg-surface px-2 py-1"
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
          placeholder={t("chat.loop.graph.nodeId")}
        />
        <select
          className="rounded border border-subtle bg-surface px-2 py-1"
          value={nodeKind}
          onChange={(event) => setNodeKind(event.target.value)}
        >
          {["function", "agent", "loop", "gate", "join", "router", "wait"].map((kind) => (
            <option key={kind}>{kind}</option>
          ))}
        </select>
        <input
          className="rounded border border-subtle bg-surface px-2 py-1"
          value={dependencies}
          onChange={(event) => setDependencies(event.target.value)}
          placeholder={t("chat.loop.graph.dependencies")}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!nodeId.trim() || "error" in parsed}
          onClick={() => {
            if ("error" in parsed) return;
            try {
              const next = appendGraphNode(parsed.definition, {
                id: nodeId.trim(),
                kind: nodeKind,
                dependsOn: dependencies
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              });
              commitDefinition(next);
              setNodeId("");
              setDependencies("");
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        >
          {t("chat.loop.graph.addNode")}
        </Button>
      </div>
      <textarea
        className="mt-2 h-20 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
        value={parametersText}
        aria-label={t("chat.loop.graph.parameters")}
        onChange={(event) => changeParametersText(event.target.value)}
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
