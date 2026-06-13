import { useEffect, useState } from "react";
import type { ChatMessage, SessionStatus } from "@seekforge/shared";
import { ApiError, api } from "../lib/api";
import { messagesToItems } from "../lib/messages";
import { filterSessions } from "../lib/sessions-filter";
import { formatUsd } from "../lib/usage";
import { useStore } from "../store";
import { ChatItems } from "../components/chat/ChatItems";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconSessions, Input, type BadgeTone } from "../components/ui";
import type { RewindResult, SessionMeta } from "../types";

const STATUS_TONE: Record<SessionStatus, BadgeTone> = {
  idle: "neutral",
  running: "warn",
  waiting_approval: "warn",
  completed: "ok",
  failed: "danger",
  cancelled: "neutral",
};

type Detail = { meta: SessionMeta; messages: ChatMessage[] };

export function SessionsView() {
  const t = useT();
  const continueSession = useStore((s) => s.continueSession);
  const ws = useStore((s) => s.activeWorkspaceId);
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Client-side search over id and task text. */
  const [query, setQuery] = useState("");
  /** Dry-run result awaiting confirmation. */
  const [rewindPreview, setRewindPreview] = useState<{ sessionId: string; result: RewindResult } | null>(null);
  /** Per-session inline note ("no checkpoints" / result summary). */
  const [rewindNotes, setRewindNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    setSessions(null);
    setDetail(null);
    setError(null);
    setRewindNotes({});
    api
      .sessions()
      .then(setSessions)
      .catch((e: unknown) => setError(String(e)));
  }, [ws]);

  const openSession = (id: string) => {
    setError(null);
    api
      .session(id)
      .then(setDetail)
      .catch((e: unknown) => setError(String(e)));
  };

  const noteFor = (id: string, e: unknown): string =>
    e instanceof ApiError && e.status === 404 ? t("sessions.rewindNoCheckpoints") : String(e);

  const startRewind = (id: string) => {
    setRewindNotes((n) => ({ ...n, [id]: "" }));
    api
      .rewind(id, true)
      .then((result) => setRewindPreview({ sessionId: id, result }))
      .catch((e: unknown) => setRewindNotes((n) => ({ ...n, [id]: noteFor(id, e) })));
  };

  const confirmRewind = () => {
    if (!rewindPreview) return;
    const { sessionId } = rewindPreview;
    setRewindPreview(null);
    api
      .rewind(sessionId)
      .then((r) =>
        setRewindNotes((n) => ({
          ...n,
          [sessionId]: t("sessions.rewindResult", { restored: r.restored.length, deleted: r.deleted.length, skipped: r.skipped.length }),
        })),
      )
      .catch((e: unknown) => setRewindNotes((n) => ({ ...n, [sessionId]: noteFor(sessionId, e) })));
  };

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-subtle px-4 py-2">
          <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
            {t("sessions.backBtn")}
          </Button>
          <span className="font-mono text-xs text-secondary">{detail.meta.id}</span>
          <Badge tone={STATUS_TONE[detail.meta.status]}>{detail.meta.status}</Badge>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => continueSession(detail.meta, detail.messages)}
          >
            {t("sessions.continueBtn")}
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <ChatItems items={messagesToItems(detail.messages)} />
        </div>
      </div>
    );
  }

  const visible = filterSessions(sessions ?? [], query);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-subtle px-4 py-2">
        <h1 className="text-sm font-semibold text-primary">{t("sessions.title")}</h1>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("sessions.searchPlaceholder")}
          className="ml-auto w-64"
        />
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</div>
        )}
        {sessions === null ? (
          !error && <p className="text-tertiary">{t("sessions.loading")}</p>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={<IconSessions size={28} />}
            title={t("sessions.emptyTitle")}
            description={t("sessions.emptyDescription")}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconSessions size={28} />}
            title={t("sessions.noMatchTitle")}
            description={t("sessions.noMatchDescription", { query: query.trim() })}
          />
        ) : (
          <ul className="space-y-2">
            {visible.map((s) => (
              <li key={s.id}>
                <Card
                  flush
                  onClick={() => openSession(s.id)}
                  className="cursor-pointer bg-surface-raised/60 px-3 py-2 transition-colors hover:border-strong hover:bg-surface-overlay"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-tertiary">{s.id}</span>
                    <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                    {rewindNotes[s.id] && (
                      <span className="font-mono text-2xs text-warn">{rewindNotes[s.id]}</span>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      {s.usage && <span className="font-mono text-xs text-tertiary">{formatUsd(s.usage.costUsd)}</span>}
                      {s.status !== "running" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRewind(s.id);
                          }}
                          title={t("sessions.rewindBtnTitle")}
                        >
                          {t("sessions.rewindBtn")}
                        </Button>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-sm text-secondary">{s.task}</div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rewindPreview && (
        <ConfirmDialog
          title={t("sessions.rewindTitle", { sessionId: rewindPreview.sessionId })}
          confirmLabel={t("sessions.rewindConfirm")}
          danger
          onConfirm={confirmRewind}
          onCancel={() => setRewindPreview(null)}
        >
          <div className="space-y-2 text-xs">
            {rewindPreview.result.restored.length === 0 && rewindPreview.result.deleted.length === 0 ? (
              <p>{t("sessions.rewindBodyNone")}</p>
            ) : (
              <>
                {rewindPreview.result.restored.length > 0 && (
                  <div>
                    <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("sessions.rewindSectionRestore")}</div>
                    <ul className="space-y-0.5 font-mono text-accent">
                      {rewindPreview.result.restored.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {rewindPreview.result.deleted.length > 0 && (
                  <div>
                    <div className="mb-1 text-2xs uppercase tracking-wider text-tertiary">{t("sessions.rewindSectionDelete")}</div>
                    <ul className="space-y-0.5 font-mono text-danger">
                      {rewindPreview.result.deleted.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {rewindPreview.result.skipped.length > 0 && (
              <p className="text-tertiary">{t("sessions.rewindSkipped", { count: rewindPreview.result.skipped.length })}</p>
            )}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
