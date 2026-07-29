import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { LatestRequest } from "../../views/async-coordination";
import { useT } from "../../lib/i18n";
import { useStore } from "../../store";
import type {
  EngineeringGraphDetail,
  EngineeringGraphRunComparison,
  EngineeringGraphResourceReport,
  EngineeringGraphSummary,
  LoopDagResourceReport,
  LoopDagSummary,
  LoopEvidenceReport,
  LoopHistoryEntry,
  LoopSpeculationSummary,
  LoopStateSummary,
} from "../../types";
import { Button } from "../ui";
import { LoopDagSection } from "./LoopDagSection";
import { GraphEngineeringSection } from "./GraphEngineeringSection";
import { LoopDetailsSection } from "./LoopDetailsSection";
import { LoopListSection } from "./LoopListSection";
import { LoopSpeculationSection } from "./LoopSpeculationSection";

type Props = { running: boolean; onResume: (opts: { loopId: string }) => void };

export function LoopManager({ running, onResume }: Props) {
  const t = useT();
  const graphEventVersion = useStore((state) => state.graphEventVersion);
  const subscribeGraphRun = useStore((state) => state.subscribeGraphRun);
  const [loops, setLoops] = useState<LoopStateSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<LoopHistoryEntry[]>([]);
  const [evidence, setEvidence] = useState<LoopEvidenceReport>();
  const [dags, setDags] = useState<LoopDagSummary[]>([]);
  const [graphs, setGraphs] = useState<EngineeringGraphSummary[]>([]);
  const [graphDetails, setGraphDetails] = useState<Record<string, EngineeringGraphDetail>>({});
  const [graphResources, setGraphResources] = useState<Record<string, EngineeringGraphResourceReport>>({});
  const [graphComparisons, setGraphComparisons] = useState<Record<string, EngineeringGraphRunComparison>>({});
  const [dagResources, setDagResources] = useState<Record<string, LoopDagResourceReport>>({});
  const [speculations, setSpeculations] = useState<LoopSpeculationSummary[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [loopBusy, setLoopBusy] = useState(false);
  const [resourceBusy, setResourceBusy] = useState(false);
  const refreshRequests = useRef(new LatestRequest());
  const historyRequests = useRef(new LatestRequest());
  const dagRequests = useRef(new LatestRequest());
  const graphRequests = useRef(new LatestRequest());
  const operationRequests = useRef(new LatestRequest());
  const selectedRef = useRef<string>();
  const refresh = useCallback(async () => {
    const request = refreshRequests.current.begin();
    setRefreshBusy(true);
    try {
      const [nextLoops, nextDags, nextSpeculations, nextGraphs] = await Promise.all([
        api.loops({ q: query || undefined, status: status || undefined, limit: 100 }),
        api.loopDags(),
        api.loopSpeculations(),
        api.graphs(),
      ]);
      if (refreshRequests.current.isCurrent(request)) {
        setLoops(nextLoops);
        setDags(nextDags);
        setSpeculations(nextSpeculations);
        setGraphs(nextGraphs);
        setError("");
      }
    } catch (caught) {
      if (refreshRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (refreshRequests.current.isCurrent(request)) setRefreshBusy(false);
    }
  }, [query, status]);
  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    for (const graph of graphs) if (graph.status === "running" && graph.runId) subscribeGraphRun(graph.runId);
  }, [graphs, subscribeGraphRun]);
  useEffect(() => {
    if (graphEventVersion === 0) return;
    // Graph nodes can emit several frames back-to-back. Coalescing them keeps
    // the REST snapshot authoritative without creating an overlapping request burst.
    const timer = window.setTimeout(() => void refresh(), 100);
    return () => window.clearTimeout(timer);
  }, [graphEventVersion, refresh]);
  useEffect(
    () => () => {
      refreshRequests.current.invalidate();
      historyRequests.current.invalidate();
      dagRequests.current.invalidate();
      graphRequests.current.invalidate();
      operationRequests.current.invalidate();
    },
    [],
  );
  useEffect(() => {
    const graphRunning = graphs.some((graph) => graph.status === "running");
    if (!running && !selected && !graphRunning) return;
    const timer = window.setInterval(() => void refresh(), running || selected ? 5_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [graphs, refresh, running, selected]);

  const inspect = async (loopId: string) => {
    const request = historyRequests.current.begin();
    selectedRef.current = loopId;
    setSelected(loopId);
    setHistory([]);
    setEvidence(undefined);
    try {
      const [nextHistory, nextEvidence] = await Promise.all([
        api.loopHistory(loopId, 0, 100),
        api.loopEvidence(loopId),
      ]);
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setHistory(nextHistory);
        setEvidence(nextEvidence);
        setError("");
      }
    } catch (caught) {
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };
  const loadMoreHistory = async () => {
    const loopId = selectedRef.current;
    if (!loopId) return;
    const cursor = history.at(-1)?.seq ?? 0;
    const request = historyRequests.current.begin();
    try {
      const next = await api.loopHistory(loopId, cursor, 100);
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setHistory((current) => [...current, ...next]);
        setError("");
      }
    } catch (caught) {
      if (historyRequests.current.isCurrent(request) && selectedRef.current === loopId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };
  const control = async (loopId: string, operation: "pause" | "resume" | "steer") => {
    const message = operation === "steer" ? window.prompt(t("chat.loop.manager.steerPrompt"))?.trim() : undefined;
    if (operation === "steer" && !message) return;
    setLoopBusy(true);
    try {
      await api.loopControl(loopId, operation === "steer" ? { operation, message: message! } : { operation });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoopBusy(false);
    }
  };
  const recover = async () => {
    setLoopBusy(true);
    try {
      await api.loopRecover();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoopBusy(false);
    }
  };
  const prune = async () => {
    if (!window.confirm(t("chat.loop.manager.pruneConfirm"))) return;
    setLoopBusy(true);
    try {
      await api.loopPrune({ maxAgeDays: 30, maxTerminalCount: 50 });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoopBusy(false);
    }
  };
  const remove = async (loopId: string) => {
    if (!window.confirm(t("chat.loop.manager.deleteConfirm"))) return;
    setLoopBusy(true);
    try {
      await api.loopDelete(loopId);
      if (selectedRef.current === loopId) {
        selectedRef.current = undefined;
        historyRequests.current.invalidate();
        setSelected(undefined);
        setHistory([]);
        setEvidence(undefined);
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoopBusy(false);
    }
  };
  const changePriority = async (loop: LoopStateSummary, delta: number) => {
    setLoopBusy(true);
    try {
      await api.loopPriority(loop.loopId, Math.max(-10, Math.min(10, (loop.priority ?? 0) + delta)));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoopBusy(false);
    }
  };
  const inspectDag = async (dagId: string) => {
    const request = dagRequests.current.begin();
    setResourceBusy(true);
    try {
      const report = await api.loopDagResources(dagId);
      if (dagRequests.current.isCurrent(request)) {
        setDagResources((current) => ({ ...current, [dagId]: report }));
        setError("");
      }
    } catch (caught) {
      if (dagRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (dagRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const dagAction = async (dagId: string, operation: "archive" | "prune" | "promote") => {
    if (
      operation !== "archive" &&
      !window.confirm(
        t("chat.loop.manager.resourceConfirm", {
          action: operation === "promote" ? t("chat.loop.manager.promote") : t("chat.loop.manager.pruneResources"),
          id: dagId,
        }),
      )
    )
      return;
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      await api.loopDagResourceAction(dagId, { operation, ...(operation === "promote" ? { target: "fan-in" } : {}) });
      if (!operationRequests.current.isCurrent(request)) return;
      await refresh();
      if (operationRequests.current.isCurrent(request) && operation !== "prune") await inspectDag(dagId);
    } catch (caught) {
      if (operationRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const promoteSpeculation = async (speculationId: string) => {
    if (
      !window.confirm(
        t("chat.loop.manager.resourceConfirm", {
          action: t("chat.loop.manager.promote"),
          id: speculationId,
        }),
      )
    )
      return;
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      await api.loopSpeculationPromote(speculationId);
      if (operationRequests.current.isCurrent(request)) await refresh();
    } catch (caught) {
      if (operationRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const removeGraph = async (graphId: string) => {
    if (!window.confirm(t("chat.loop.graph.deleteConfirm"))) return;
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      await api.graphDelete(graphId);
      if (operationRequests.current.isCurrent(request)) await refresh();
    } catch (caught) {
      if (operationRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const inspectGraph = async (graphId: string) => {
    const request = graphRequests.current.begin();
    setResourceBusy(true);
    try {
      const [detail, resources, comparison] = await Promise.all([
        api.graph(graphId),
        api.graphResources(graphId),
        api.graphComparison(graphId).catch((error) => {
          if (error instanceof ApiError && error.status === 404) return undefined;
          throw error;
        }),
      ]);
      if (graphRequests.current.isCurrent(request)) {
        setGraphDetails((current) => ({ ...current, [graphId]: detail }));
        setGraphResources((current) => ({ ...current, [graphId]: resources }));
        setGraphComparisons((current) => {
          if (comparison) return { ...current, [graphId]: comparison.comparison };
          const { [graphId]: _stale, ...retained } = current;
          return retained;
        });
        setError("");
      }
    } catch (caught) {
      if (graphRequests.current.isCurrent(request)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (graphRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const graphAction = async (graphId: string, operation: "archive" | "prune" | "promote", target?: string) => {
    if (
      operation !== "archive" &&
      !window.confirm(
        t("chat.loop.manager.resourceConfirm", {
          action: operation === "promote" ? t("chat.loop.manager.promote") : t("chat.loop.manager.pruneResources"),
          id: target ? `${graphId}/${target}` : graphId,
        }),
      )
    )
      return;
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      await api.graphResourceAction(graphId, {
        operation,
        ...(operation === "promote" ? { target: target ?? "fan-in" } : {}),
      });
      if (!operationRequests.current.isCurrent(request)) return;
      await refresh();
      if (operationRequests.current.isCurrent(request)) await inspectGraph(graphId);
    } catch (caught) {
      if (operationRequests.current.isCurrent(request))
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const graphLifecycle = async (
    graphId: string,
    operation: "resume" | "approve" | "rerun" | "restart" | "cancel",
    nodeIds: string[] = [],
  ) => {
    if ((operation === "restart" || operation === "cancel") && !window.confirm(`${operation} ${graphId}?`)) return;
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      let selectors = nodeIds;
      if (operation === "approve") {
        const detail = graphDetails[graphId] ?? (await api.graph(graphId));
        selectors = detail.results.flatMap((node) => {
          if (node.status !== "waiting_approval") return [];
          if (
            node.kind === "subgraph" &&
            typeof node.output === "object" &&
            node.output !== null &&
            Array.isArray((node.output as { waitingFor?: unknown }).waitingFor)
          ) {
            return (node.output as { waitingFor: unknown[] }).waitingFor.filter(
              (path): path is string => typeof path === "string",
            );
          }
          return [node.id];
        });
      }
      await api.graphLifecycle(graphId, operation, selectors.length > 0 ? { nodeIds: selectors } : {});
      if (operationRequests.current.isCurrent(request)) await refresh();
    } catch (caught) {
      if (operationRequests.current.isCurrent(request))
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const graphControl = async (
    graphId: string,
    operation: "pause" | "steer" | "reprioritize" | "cancel",
    nodeId?: string,
    currentPriority = 0,
  ) => {
    const message = operation === "steer" ? window.prompt(t("chat.loop.graph.guidancePrompt"))?.trim() : undefined;
    if (operation === "steer" && !message) return;
    const priorityText =
      operation === "reprioritize"
        ? window.prompt(t("chat.loop.graph.priorityPrompt"), String(currentPriority))
        : undefined;
    if (operation === "reprioritize" && (priorityText === null || priorityText?.trim() === "")) return;
    const priority = priorityText === undefined ? undefined : Number(priorityText);
    if (operation === "reprioritize" && (!Number.isSafeInteger(priority) || priority! < -10 || priority! > 10)) return;
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      await api.graphControl(graphId, {
        operation,
        ...(message ? { message } : {}),
        ...(nodeId ? { nodeId } : {}),
        ...(priority !== undefined ? { priority } : {}),
      });
      if (operationRequests.current.isCurrent(request)) await refresh();
    } catch (caught) {
      if (operationRequests.current.isCurrent(request))
        setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };
  const graphSignal = async (graphId: string, name: string) => {
    const raw = window.prompt(t("chat.loop.graph.signalPrompt", { name }), "");
    if (raw === null) return;
    let payload: unknown;
    try {
      payload = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      setError(t("chat.loop.graph.signalInvalid"));
      return;
    }
    const request = operationRequests.current.begin();
    setResourceBusy(true);
    try {
      await api.graphSignal(graphId, name, payload);
      if (operationRequests.current.isCurrent(request)) await refresh();
    } catch (caught) {
      if (operationRequests.current.isCurrent(request)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (operationRequests.current.isCurrent(request)) setResourceBusy(false);
    }
  };

  return (
    <details className="mt-2 rounded border border-subtle p-2">
      <summary className="cursor-pointer text-xs font-medium text-secondary">{t("chat.loop.manager.title")}</summary>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          className="min-w-40 rounded border border-subtle bg-surface px-2 text-xs"
          value={query}
          placeholder={t("chat.loop.manager.filter")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="rounded border border-subtle bg-surface px-2 text-xs"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">{t("chat.loop.manager.allStatuses")}</option>
          {["running", "paused", "passed", "failed", "interrupted", "budget", "no_progress"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <Button size="sm" variant="ghost" disabled={refreshBusy} onClick={() => void refresh()}>
          {t("chat.loop.manager.refresh")}
        </Button>
        <Button size="sm" variant="ghost" disabled={loopBusy || running} onClick={() => void recover()}>
          {t("chat.loop.manager.recover")}
        </Button>
        <Button size="sm" variant="ghost" disabled={loopBusy || running} onClick={() => void prune()}>
          {t("chat.loop.manager.prune")}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <LoopListSection
        loops={loops}
        busy={loopBusy}
        running={running}
        onInspect={(loopId) => void inspect(loopId)}
        onPriority={(loop, delta) => void changePriority(loop, delta)}
        onResume={(loopId) => onResume({ loopId })}
        onControl={(loopId, operation) => void control(loopId, operation)}
        onRemove={(loopId) => void remove(loopId)}
      />
      <LoopDetailsSection
        selected={selected}
        evidence={evidence}
        history={history}
        onLoadMore={() => void loadMoreHistory()}
      />
      <LoopDagSection
        dags={dags}
        resources={dagResources}
        busy={resourceBusy}
        onInspect={(dagId) => void inspectDag(dagId)}
        onAction={(dagId, operation) => void dagAction(dagId, operation)}
      />
      <GraphEngineeringSection
        graphs={graphs}
        details={graphDetails}
        resources={graphResources}
        comparisons={graphComparisons}
        busy={resourceBusy}
        onInspect={(graphId) => void inspectGraph(graphId)}
        onAction={(graphId, operation, target) => void graphAction(graphId, operation, target)}
        onLifecycle={(graphId, operation, nodeIds) => void graphLifecycle(graphId, operation, nodeIds)}
        onControl={(graphId, operation, nodeId, priority) => void graphControl(graphId, operation, nodeId, priority)}
        onSignal={(graphId, name) => void graphSignal(graphId, name)}
        onRemove={(graphId) => void removeGraph(graphId)}
      />
      <LoopSpeculationSection
        speculations={speculations}
        busy={resourceBusy}
        onPromote={(speculationId) => void promoteSpeculation(speculationId)}
      />
    </details>
  );
}
