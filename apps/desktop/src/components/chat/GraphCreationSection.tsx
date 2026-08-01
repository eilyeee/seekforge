import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { clearGraphDraft, DebouncedGraphDraftWriter, loadGraphDraft } from "../../lib/graph-draft-storage";
import {
  decodeGraphTemplateCompatibility,
  decodeDesktopGraphTemplates,
  graphTemplateDefaultParameters,
  graphTemplateParameterFields,
  graphTemplateReference,
  graphTemplateVisualDefinition,
  type GraphTemplateCompatibility,
  type GraphTemplateParameterField,
  setGraphTemplateParameter,
  type DesktopGraphTemplate,
} from "../../lib/graph-template-ui";
import { useT } from "../../lib/i18n";
import type { EngineeringGraphPlanSummary, EngineeringGraphSimulationSummary } from "../../types";
import { appendGraphNode, buildVisualGraph, removeGraphNode, setGraphNodeDependencies } from "../../lib/graph-visual";
import { Badge, Button } from "../ui";

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

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

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
  const [draftPersistenceError, setDraftPersistenceError] = useState(false);
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(false);
  const [registryBusy, setRegistryBusy] = useState<"register" | "compare" | "deprecate" | null>(null);
  const [compatibility, setCompatibility] = useState<GraphTemplateCompatibility>();
  const actionGeneration = useRef(0);
  const templateGeneration = useRef(0);
  const registryGeneration = useRef(0);
  const draftWriter = useRef<{
    storage: Storage;
    writer: DebouncedGraphDraftWriter;
  }>();
  const workspaceRef = useRef(props.workspaceId ?? "");
  workspaceRef.current = props.workspaceId ?? "";
  const selectedTemplateKeyRef = useRef(selectedTemplateKey);
  selectedTemplateKeyRef.current = selectedTemplateKey;
  const source = `${definitionText}\0${parametersText}`;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const previewCurrent = validatedSource === source;

  const flushDraftSave = (reportFailure: boolean) => {
    draftWriter.current?.writer.flush(reportFailure);
  };

  const refreshTemplates = async (workspaceId = props.workspaceId): Promise<boolean> => {
    const current = ++templateGeneration.current;
    try {
      const items = await api.graphTemplates(workspaceId);
      if (templateGeneration.current === current && workspaceRef.current === (workspaceId ?? "")) {
        const decoded = decodeDesktopGraphTemplates(items);
        setTemplates(decoded.templates);
        setSkippedTemplates(decoded.skipped);
      }
      return true;
    } catch (caught) {
      if (templateGeneration.current === current && workspaceRef.current === (workspaceId ?? "")) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      return false;
    }
  };

  useEffect(() => {
    flushDraftSave(false);
    actionGeneration.current += 1;
    templateGeneration.current += 1;
    const storage = browserStorage();
    setDraftStorageAvailable(Boolean(storage && props.workspaceId));
    const draft = storage ? loadGraphDraft(storage, props.workspaceId ?? "") : null;
    setDefinitionText(draft?.definitionText ?? INITIAL_DEFINITION);
    setParametersText(draft?.parametersText ?? "{}");
    setTemplates([]);
    setPlan(undefined);
    setSimulation(undefined);
    setValidatedSource(undefined);
    setBusy(false);
    setError("");
    setSkippedTemplates(0);
    setSelectedNodeId("");
    setSelectedTemplateKey("");
    setDraftPersistenceError(false);
    setRegistryBusy(null);
    setCompatibility(undefined);
    registryGeneration.current += 1;
    void refreshTemplates(props.workspaceId);
    return () => {
      flushDraftSave(false);
      actionGeneration.current += 1;
      templateGeneration.current += 1;
      registryGeneration.current += 1;
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
  const selectedTemplate = templates.find((template) => template.key === selectedTemplateKey);
  const candidateReference = "error" in parsed ? null : graphTemplateReference(parsed.definition);
  const parameterFields = useMemo(
    () => ("error" in parsed ? [] : graphTemplateParameterFields(parsed.definition)),
    [parsed],
  );

  const queueDraftSave = (nextDefinitionText: string, nextParametersText: string) => {
    const storage = browserStorage();
    const workspaceId = props.workspaceId ?? "";
    setDraftStorageAvailable(Boolean(storage && workspaceId));
    if (!storage || !workspaceId) return;
    if (draftWriter.current?.storage !== storage) {
      draftWriter.current?.writer.flush(false);
      draftWriter.current = { storage, writer: new DebouncedGraphDraftWriter(storage) };
    }
    draftWriter.current.writer.schedule(
      { workspaceId, definitionText: nextDefinitionText, parametersText: nextParametersText },
      (saved) => {
        if (workspaceRef.current === workspaceId) setDraftPersistenceError(!saved);
      },
    );
  };

  const replaceDraft = (nextDefinitionText: string, nextParametersText: string) => {
    actionGeneration.current += 1;
    setDefinitionText(nextDefinitionText);
    setParametersText(nextParametersText);
    setValidatedSource(undefined);
    setPlan(undefined);
    setSimulation(undefined);
    setCompatibility(undefined);
    setBusy(false);
    setError("");
    queueDraftSave(nextDefinitionText, nextParametersText);
  };

  const commitDefinition = (next: unknown) => replaceDraft(JSON.stringify(next, null, 2), parametersText);

  const changeDefinitionText = (next: string) => {
    replaceDraft(next, parametersText);
  };

  const changeParametersText = (next: string) => {
    replaceDraft(definitionText, next);
  };

  const changeTemplateParameter = (
    field: GraphTemplateParameterField,
    value: string | number | boolean | undefined,
  ) => {
    if ("error" in parsed) return;
    const next = setGraphTemplateParameter(parsed.parameters, field, value);
    replaceDraft(definitionText, JSON.stringify(next, null, 2));
  };

  const loadTemplate = (template: DesktopGraphTemplate) => {
    const nextDefinitionText = JSON.stringify(template.template, null, 2);
    const nextParametersText = JSON.stringify(graphTemplateDefaultParameters(template.template), null, 2);
    if (
      (definitionText !== nextDefinitionText || parametersText !== nextParametersText) &&
      typeof window !== "undefined" &&
      !window.confirm(t("chat.loop.graph.loadTemplateConfirm", { id: template.key }))
    ) {
      return;
    }
    replaceDraft(nextDefinitionText, nextParametersText);
    setSelectedTemplateKey(template.key);
    setSelectedNodeId("");
  };

  const resetDraft = () => {
    if (typeof window !== "undefined" && !window.confirm(t("chat.loop.graph.resetDraftConfirm"))) return;
    draftWriter.current?.writer.cancel();
    actionGeneration.current += 1;
    setDefinitionText(INITIAL_DEFINITION);
    setParametersText("{}");
    setSelectedTemplateKey("");
    setSelectedNodeId("");
    setValidatedSource(undefined);
    setPlan(undefined);
    setSimulation(undefined);
    setCompatibility(undefined);
    setBusy(false);
    setError("");
    setDraftPersistenceError(false);
    const storage = browserStorage();
    setDraftStorageAvailable(Boolean(storage && props.workspaceId));
    if (storage && props.workspaceId) {
      setDraftPersistenceError(!clearGraphDraft(storage, props.workspaceId));
    }
  };

  const registryOperationCurrent = (request: number, workspaceId: string) =>
    registryGeneration.current === request && workspaceRef.current === workspaceId;

  const registerTemplate = async () => {
    if ("error" in parsed || !candidateReference || !props.workspaceId || registryBusy) return;
    const existing = templates.find(
      (template) =>
        template.templateId === candidateReference.templateId && template.version === candidateReference.version,
    );
    if (
      existing &&
      typeof window !== "undefined" &&
      !window.confirm(t("chat.loop.graph.registerOverwriteConfirm", { id: existing.key }))
    ) {
      return;
    }
    const request = ++registryGeneration.current;
    const workspaceId = props.workspaceId;
    const requestedSource = source;
    const requestedSelection = selectedTemplateKey;
    setRegistryBusy("register");
    setError("");
    try {
      await api.graphTemplateRegister(parsed.definition, workspaceId);
      if (!registryOperationCurrent(request, workspaceId)) return;
      const refreshed = await refreshTemplates(workspaceId);
      if (
        refreshed &&
        registryOperationCurrent(request, workspaceId) &&
        sourceRef.current === requestedSource &&
        selectedTemplateKeyRef.current === requestedSelection
      ) {
        setSelectedTemplateKey(candidateReference.key);
      }
    } catch (caught) {
      if (registryOperationCurrent(request, workspaceId)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (registryOperationCurrent(request, workspaceId)) setRegistryBusy(null);
    }
  };

  const compareTemplate = async () => {
    if ("error" in parsed || !candidateReference || !selectedTemplate || !props.workspaceId || registryBusy) return;
    const request = ++registryGeneration.current;
    const workspaceId = props.workspaceId;
    const requestedSource = source;
    const requestedTemplateKey = selectedTemplate.key;
    setRegistryBusy("compare");
    setCompatibility(undefined);
    setError("");
    try {
      const result = decodeGraphTemplateCompatibility(
        await api.graphTemplateCompare(
          selectedTemplate.templateId,
          selectedTemplate.version,
          parsed.definition,
          workspaceId,
        ),
        {
          templateId: selectedTemplate.templateId,
          fromVersion: selectedTemplate.version,
          toVersion: candidateReference.version,
        },
      );
      if (
        registryOperationCurrent(request, workspaceId) &&
        sourceRef.current === requestedSource &&
        selectedTemplateKeyRef.current === requestedTemplateKey
      ) {
        setCompatibility(result);
      }
    } catch (caught) {
      if (registryOperationCurrent(request, workspaceId)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (registryOperationCurrent(request, workspaceId)) setRegistryBusy(null);
    }
  };

  const deprecateTemplate = async () => {
    if (!selectedTemplate || selectedTemplate.deprecated || !props.workspaceId || registryBusy) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("chat.loop.graph.deprecateConfirm", { id: selectedTemplate.key }))
    ) {
      return;
    }
    const request = ++registryGeneration.current;
    const workspaceId = props.workspaceId;
    setRegistryBusy("deprecate");
    setError("");
    try {
      await api.graphTemplateDeprecate(selectedTemplate.templateId, selectedTemplate.version, workspaceId);
      if (registryOperationCurrent(request, workspaceId)) await refreshTemplates(workspaceId);
    } catch (caught) {
      if (registryOperationCurrent(request, workspaceId)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (registryOperationCurrent(request, workspaceId)) setRegistryBusy(null);
    }
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
            setSelectedTemplateKey(selected?.key ?? "");
            setCompatibility(undefined);
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
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || registryBusy !== null || !candidateReference || !props.workspaceId}
          onClick={() => void registerTemplate()}
        >
          {registryBusy === "register"
            ? t("chat.loop.graph.registeringTemplate")
            : t("chat.loop.graph.registerTemplate")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || registryBusy !== null || !selectedTemplate}
          onClick={() => selectedTemplate && loadTemplate(selectedTemplate)}
        >
          {t("chat.loop.graph.loadTemplate")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || registryBusy !== null || !candidateReference || !selectedTemplate || !props.workspaceId}
          onClick={() => void compareTemplate()}
        >
          {registryBusy === "compare" ? t("chat.loop.graph.comparingTemplate") : t("chat.loop.graph.compareTemplate")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            busy || registryBusy !== null || !selectedTemplate || selectedTemplate.deprecated || !props.workspaceId
          }
          onClick={() => void deprecateTemplate()}
        >
          {registryBusy === "deprecate"
            ? t("chat.loop.graph.deprecatingTemplate")
            : t("chat.loop.graph.deprecateTemplate")}
        </Button>
      </div>
      {candidateReference === null && !("error" in parsed) && (
        <p className="mt-1 text-tertiary">{t("chat.loop.graph.registryRequiresVersionedTemplate")}</p>
      )}
      {compatibility && (
        <div className="mt-2 rounded border border-subtle p-2">
          <p className="flex flex-wrap items-center gap-1">
            <Badge
              tone={
                compatibility.classification === "compatible"
                  ? "ok"
                  : compatibility.classification === "breaking"
                    ? "danger"
                    : "neutral"
              }
            >
              {t(`chat.loop.graph.compatibility.${compatibility.classification}`)}
            </Badge>
            <span>
              {compatibility.templateId} · {compatibility.fromVersion} → {compatibility.toVersion}
            </span>
          </p>
          {compatibility.reasons.length === 0 ? (
            <p className="mt-1 text-tertiary">{t("chat.loop.graph.compatibilityNoReasons")}</p>
          ) : (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-tertiary">
              {compatibility.reasons.map((reason, index) => (
                <li key={`${index}-${reason}`}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-2 text-tertiary">
        <span>{t(draftStorageAvailable ? "chat.loop.graph.draftAutosave" : "chat.loop.graph.draftUnavailable")}</span>
        <Button size="sm" variant="ghost" onClick={resetDraft}>
          {t("chat.loop.graph.resetDraft")}
        </Button>
      </div>
      {draftPersistenceError && <p className="mt-1 text-warn">{t("chat.loop.graph.draftSaveFailed")}</p>}
      <textarea
        className="mt-2 h-48 w-full rounded border border-subtle bg-surface p-2 font-mono text-2xs"
        value={definitionText}
        aria-label={t("chat.loop.graph.definition")}
        onChange={(event) => changeDefinitionText(event.target.value)}
      />
      {parameterFields.length > 0 && !("error" in parsed) && (
        <fieldset className="mt-2 rounded border border-subtle p-2">
          <legend className="px-1 font-medium">{t("chat.loop.graph.parameterEditor")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {parameterFields.map((field) => {
              const included = Object.hasOwn(parsed.parameters, field.name);
              const value = parsed.parameters[field.name];
              const validValue =
                !included || (typeof value === field.type && (typeof value !== "number" || Number.isFinite(value)));
              const controlId = `graph-template-parameter-${field.name}`;
              return (
                <div key={field.name} className="rounded bg-surface-overlay p-2">
                  <label htmlFor={controlId} className="flex items-center gap-2 font-medium">
                    <input
                      id={controlId}
                      type="checkbox"
                      checked={included}
                      onChange={(event) =>
                        changeTemplateParameter(
                          field,
                          event.target.checked
                            ? (field.defaultValue ??
                                (field.type === "string" ? "" : field.type === "number" ? 0 : false))
                            : undefined,
                        )
                      }
                    />
                    {field.name} · {field.type}
                  </label>
                  {field.description && <span className="mt-1 block text-tertiary">{field.description}</span>}
                  {!validValue && <span className="mt-1 block text-warn">{t("chat.loop.graph.parameterInvalid")}</span>}
                  {field.type === "boolean" ? (
                    <select
                      className="mt-1 w-full rounded border border-subtle bg-surface px-2 py-1"
                      aria-label={`${field.name} · ${field.type}`}
                      value={!included ? "unset" : !validValue ? "invalid" : value === true ? "true" : "false"}
                      onChange={(event) =>
                        changeTemplateParameter(
                          field,
                          event.target.value === "unset" ? undefined : event.target.value === "true",
                        )
                      }
                    >
                      <option value="unset">{t("chat.loop.graph.parameterUnset")}</option>
                      {!validValue && (
                        <option value="invalid" disabled>
                          {t("chat.loop.graph.parameterInvalid")}
                        </option>
                      )}
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="mt-1 w-full rounded border border-subtle bg-surface px-2 py-1"
                      aria-label={`${field.name} · ${field.type}`}
                      type={field.type === "number" ? "number" : "text"}
                      disabled={!included}
                      value={
                        included &&
                        ((field.type === "string" && typeof value === "string") ||
                          (field.type === "number" && typeof value === "number"))
                          ? String(value)
                          : ""
                      }
                      placeholder={
                        field.defaultValue === undefined
                          ? t("chat.loop.graph.parameterUnset")
                          : t("chat.loop.graph.parameterDefault", { value: String(field.defaultValue) })
                      }
                      onChange={(event) => {
                        if (field.type === "string") changeTemplateParameter(field, event.target.value);
                        else if (event.target.value === "") changeTemplateParameter(field, undefined);
                        else {
                          const number = Number(event.target.value);
                          if (Number.isFinite(number)) changeTemplateParameter(field, number);
                        }
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
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
