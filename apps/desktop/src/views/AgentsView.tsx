import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useT } from "../lib/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconAgents,
  IconArrowRight,
  IconChevron,
  IconSparkle,
  Input,
  type BadgeTone,
} from "../components/ui";
import type { AgentInfo, AgentScope } from "../types";
import { LatestRequest } from "./async-coordination";

const SCOPE_TONE: Record<AgentScope, BadgeTone> = {
  builtin: "neutral",
  global: "accent",
  project: "ok",
};

function ModeChip({ mode }: { mode: AgentInfo["mode"] }) {
  const t = useT();
  return <Badge tone={mode === "ask" ? "accent" : "warn"}>{mode === "ask" ? t("chat.mode.ask") : t("chat.mode.edit")}</Badge>;
}

function ScopeChip({ scope }: { scope: AgentScope }) {
  return <Badge tone={SCOPE_TONE[scope]}>{scope}</Badge>;
}

/** One labelled cell in the detail overview card. Mono value for triggers/tools/ids. */
function Field({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1">
      <div className="text-2xs uppercase tracking-wider text-tertiary">{label}</div>
      <div className={`text-xs text-secondary ${mono ? "font-mono break-words" : ""}`}>{value}</div>
    </div>
  );
}

export function AgentsView() {
  const t = useT();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [detail, setDetail] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const detailRequests = useRef(new LatestRequest());
  // Re-fetch when the active workspace changes (api scopes by ?ws=<active>).
  const ws = useStore((s) => s.activeWorkspaceId);
  const composeInChat = useStore((s) => s.composeInChat);

  const refresh = () =>
    api
      .agents()
      .then(setAgents)
      .catch((e: unknown) => setError(String(e)));

  useEffect(() => {
    detailRequests.current.invalidate();
    setAgents(null);
    setDetail(null);
    setError(null);
    setQuery("");
    setImportOpen(false);
    setNote(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const openAgent = (id: string) => {
    const request = detailRequests.current.begin();
    setError(null);
    api
      .agent(id)
      .then((agent) => {
        if (detailRequests.current.isCurrent(request)) setDetail(agent);
      })
      .catch((e: unknown) => {
        if (detailRequests.current.isCurrent(request)) setError(String(e));
      });
  };

  const closeDetail = () => {
    detailRequests.current.invalidate();
    setDetail(null);
  };

  // "Ask": seed the chat composer with a delegation prompt for this subagent
  // (the main agent dispatches it via dispatch_agent) and jump to chat.
  const askAgent = (agent: { id: string; name: string }) =>
    composeInChat(t("agents.askPrefill", { name: agent.name, id: agent.id }));

  const filtered = useMemo(() => {
    if (!agents) return null;
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.id.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }, [agents, query]);

  if (detail) {
    return (
      <div className="flex h-full flex-col bg-surface">
        <header className="flex items-center gap-3 border-b border-subtle px-6 py-3">
          <Button size="sm" onClick={closeDetail}>
            {t("agents.backBtn")}
          </Button>
          <h1 className="text-sm font-semibold text-primary">{detail.name}</h1>
          <span className="font-mono text-xs text-tertiary">{detail.id}</span>
          <ScopeChip scope={detail.scope} />
          <ModeChip mode={detail.mode} />
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="space-y-5">
            <p className="text-sm leading-relaxed text-secondary">{detail.description}</p>

            <Card className="p-5">
              <div className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.title")}</div>
              <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                <Field label={t("agents.fieldModel")} value={detail.model ?? t("agents.defaultModel")} />
                <Field label={t("agents.fieldMaxTurns")} value={String(detail.maxTurns ?? 15)} />
                <Field label={t("agents.fieldTriggers")} value={detail.triggers.join("  ·  ") || "—"} />
                <Field label={t("agents.fieldTools")} value={detail.tools?.join("  ·  ") ?? t("agents.allTools")} />
                {detail.own && <Field label={t("agents.fieldOwns")} value={detail.own} mono={false} />}
                {detail.doNotTouch && <Field label={t("agents.fieldDoNotTouch")} value={detail.doNotTouch} mono={false} />}
                {detail.boundary && <Field label={t("agents.fieldBoundary")} value={detail.boundary} mono={false} />}
              </div>
            </Card>

            {detail.body && (
              <Card className="p-5">
                <div className="text-2xs uppercase tracking-wider text-tertiary">{t("agents.procedure")}</div>
                <div className="mt-3 text-sm text-secondary">
                  <Markdown source={detail.body} />
                </div>
              </Card>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" size="sm" onClick={() => askAgent(detail)}>
                <IconSparkle size={14} />
                {t("agents.askBtn")}
              </Button>
              <Button size="sm" onClick={closeDetail}>
                {t("agents.backBtn")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="border-b border-subtle px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-primary">{t("agents.title")}</h1>
            <p className="mt-1 text-xs text-tertiary">{t("agents.emptyDescription")}</p>
          </div>
          <Button size="sm" className="shrink-0" onClick={() => setImportOpen(true)}>
            {t("agents.importBtn")}
          </Button>
        </div>
        <div className="mt-3 max-w-md">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("sessions.searchPlaceholder")}
          />
        </div>
        {note && <p className="mt-2 text-2xs text-ok">{note}</p>}
      </header>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>
        )}
        {filtered === null ? (
          <p className="text-sm text-tertiary">{t("agents.loading")}</p>
        ) : agents && agents.length === 0 ? (
          <EmptyState
            icon={<IconAgents size={28} />}
            title={t("agents.emptyTitle")}
            description={t("agents.emptyDescription")}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<IconAgents size={28} />}
            title={t("agents.emptyTitle")}
            description={t("sessions.noMatchDescription").replace("{query}", query)}
          />
        ) : (
          <div className="space-y-2.5">
            {filtered.map((a) => (
              <Card
                key={a.id}
                onClick={() => openAgent(a.id)}
                className="group flex cursor-pointer items-center gap-4 p-4 transition-colors hover:border-strong hover:bg-surface-overlay"
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                  <IconAgents size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-primary">{a.name}</span>
                    <span className="font-mono text-2xs text-tertiary">{a.id}</span>
                    <ScopeChip scope={a.scope} />
                    <ModeChip mode={a.mode} />
                  </div>
                  <p className="mt-1 truncate text-xs text-secondary">{a.description}</p>
                </div>
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    askAgent(a);
                  }}
                  className="shrink-0"
                >
                  {t("agents.askBtn")}
                  <IconArrowRight size={14} />
                </Button>
                <IconChevron size={16} className="shrink-0 text-tertiary" />
              </Card>
            ))}
          </div>
        )}
      </div>

      {importOpen && (
        <ImportAgentDialog
          onClose={() => setImportOpen(false)}
          onImport={(path, global) =>
            api.agentImport(path, global).then((agent) => {
              setImportOpen(false);
              setNote(t("agents.importDone", { id: agent.id }));
              void refresh();
            })
          }
        />
      )}
    </div>
  );
}

function ImportAgentDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (path: string, global: boolean) => Promise<unknown>;
}) {
  const t = useT();
  const [path, setPath] = useState("");
  const [global, setGlobal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = path.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    onImport(trimmed, global).catch((e: unknown) => {
      setError(t("agents.importError", { error: String(e) }));
      setBusy(false);
    });
  };

  return (
    <ConfirmDialog
      title={t("agents.importTitle")}
      confirmLabel={busy ? "…" : t("agents.importConfirm")}
      onConfirm={submit}
      onCancel={onClose}
    >
      <Input
        value={path}
        autoFocus
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("agents.importPathPlaceholder")}
        className="font-mono"
        disabled={busy}
      />
      <label className="mt-3 flex items-center gap-2 text-xs text-secondary">
        <input
          type="checkbox"
          checked={global}
          onChange={(e) => setGlobal(e.target.checked)}
          className="accent-accent"
          disabled={busy}
        />
        {t("agents.importGlobal")}
      </label>
      {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
    </ConfirmDialog>
  );
}
