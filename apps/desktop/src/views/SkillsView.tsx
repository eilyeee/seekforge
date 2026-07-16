import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { Markdown } from "../components/Markdown";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useT } from "../lib/i18n";
import { Badge, Button, Card, EmptyState, IconChevron, IconSkills, Input, type BadgeTone } from "../components/ui";
import type { Skill, SkillScope } from "../types";
import { useWorkspaceAsyncCoordinator } from "./use-workspace-async";

const SCOPE_TONE: Record<SkillScope, BadgeTone> = {
  builtin: "neutral",
  global: "accent",
  project: "ok",
};

const SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: "BUILTIN",
  global: "GLOBAL",
  project: "CUSTOM",
};

/** Stable per-skill icon accent so the list reads colorful but restrained. */
const ICON_TONES = [
  "bg-accent/10 text-accent",
  "bg-ok/15 text-ok",
  "bg-warn/15 text-warn",
  "bg-danger/15 text-danger",
] as const;

function iconTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ICON_TONES[h % ICON_TONES.length] ?? ICON_TONES[0];
}

function ScopeChip({ scope }: { scope: SkillScope }) {
  return <Badge tone={SCOPE_TONE[scope]}>{SCOPE_LABEL[scope]}</Badge>;
}

type Filter = "all" | SkillScope;

export function SkillsView() {
  const t = useT();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [detail, setDetail] = useState<Skill | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  /** "new" / "import" form dialogs, and a pending delete confirmation. */
  const [dialog, setDialog] = useState<null | "new" | "import">(null);
  const [pendingDelete, setPendingDelete] = useState<Skill | null>(null);
  const ws = useStore((s) => s.activeWorkspaceId);
  const requests = useWorkspaceAsyncCoordinator(ws, () => useStore.getState().activeWorkspaceId);

  const refresh = (workspaceId = ws) => {
    const request = requests.beginLatest(workspaceId);
    if (!request) return;
    api
      .skills(workspaceId)
      .then((nextSkills) => {
        if (requests.isCurrent(request)) setSkills(nextSkills);
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(request)) setError(String(e));
      });
  };

  useEffect(() => {
    setSkills(null);
    setDetail(null);
    setError(null);
    setFilter("all");
    setQuery("");
    setDialog(null);
    setPendingDelete(null);
    refresh(ws);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests]);

  const openSkill = (id: string) => {
    const request = requests.beginLatest(ws);
    if (!request) return;
    setError(null);
    api
      .skill(id)
      .then((skill) => {
        if (requests.isCurrent(request)) setDetail(skill);
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(request)) setError(String(e));
      });
  };

  const closeDetail = () => {
    requests.invalidate();
    setDetail(null);
  };

  const toggleEnabled = (skill: Skill) => {
    const operation = requests.capture(ws);
    if (!operation) return;
    setError(null);
    api
      .skillSetEnabled(skill.id, !skill.enabled, skill.scope)
      .then(() => {
        if (requests.isCurrent(operation)) refresh(operation.workspaceId);
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(operation)) setError(t("skills.actionError", { error: String(e) }));
      });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const operation = requests.capture(ws);
    if (!operation) return;
    const { id, scope } = pendingDelete;
    setPendingDelete(null);
    api
      .skillDelete(id, scope)
      .then(() => {
        if (requests.isCurrent(operation)) refresh(operation.workspaceId);
      })
      .catch((e: unknown) => {
        if (requests.isCurrent(operation)) setError(t("skills.actionError", { error: String(e) }));
      });
  };

  const counts = useMemo(() => {
    const c = { all: 0, builtin: 0, global: 0, project: 0 };
    for (const s of skills ?? []) {
      c.all++;
      c[s.scope]++;
    }
    return c;
  }, [skills]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? []).filter((s) => {
      if (filter !== "all" && s.scope !== filter) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      );
    });
  }, [skills, filter, query]);

  if (detail) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-subtle px-6 py-3">
          <Button size="sm" onClick={closeDetail}>
            {t("skills.backBtn")}
          </Button>
          <span className="font-mono text-sm font-medium text-primary">{detail.id}</span>
          <ScopeChip scope={detail.scope} />
          {!detail.enabled && <Badge tone="danger">{t("skills.disabled")}</Badge>}
        </header>
        <div className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-3xl">
            <Card className="p-6">
              <Markdown source={detail.content ?? t("skills.noContent")} />
            </Card>
          </div>
        </div>
      </div>
    );
  }

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: t("skills.scopeAll"), count: counts.all },
    { key: "builtin", label: t("skills.scopeBuiltin"), count: counts.builtin },
    { key: "global", label: t("skills.scopeGlobal"), count: counts.global },
    { key: "project", label: t("skills.scopeCustom"), count: counts.project },
  ];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-subtle px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-primary">{t("skills.title")}</h1>
          <p className="mt-1 text-xs text-tertiary">{t("skills.subtitle")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => setDialog("import")}>
            {t("skills.importBtn")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setDialog("new")}>
            {t("skills.newBtn")}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-6 py-3">
        <div className="flex items-center gap-1">
          {tabs.map((tab) => {
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                className={`focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "bg-accent-muted text-accent-hover"
                    : "text-secondary hover:bg-surface-overlay hover:text-primary"
                }`}
              >
                {tab.label}
                <span
                  className={`rounded px-1.5 text-2xs font-mono ${
                    active ? "bg-accent/15 text-accent-hover" : "bg-surface-overlay text-tertiary"
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative w-full max-w-xs">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tertiary">
            <IconSkills size={14} />
          </span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            className="pl-9 pr-12"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-subtle bg-surface px-1.5 py-0.5 font-mono text-2xs text-tertiary">
            ⌘K
          </kbd>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {error && <Card className="mb-3 border-danger/40 bg-danger/10 p-2 text-xs text-danger">{error}</Card>}
        {skills === null ? (
          <p className="text-tertiary">{t("skills.loading")}</p>
        ) : skills.length === 0 ? (
          <EmptyState
            icon={<IconSkills size={28} />}
            title={t("skills.emptyTitle")}
            description={t("skills.emptyDescription")}
          />
        ) : visible.length === 0 ? (
          <EmptyState icon={<IconSkills size={28} />} title={t("skills.emptyTitle")} />
        ) : (
          <div className="space-y-2">
            {visible.map((skill) => (
              <Card
                key={skill.id}
                flush
                onClick={() => openSkill(skill.id)}
                className="group flex cursor-pointer items-center gap-4 p-4 transition-colors hover:border-strong hover:bg-surface-overlay"
              >
                <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${iconTone(skill.id)}`}>
                  <IconSkills size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-sm font-medium text-primary">{skill.id}</span>
                    {!skill.enabled && <Badge tone="danger">{t("skills.disabled")}</Badge>}
                  </div>
                  <p className="mt-1 truncate text-xs text-secondary">{skill.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {skill.scope === "builtin" ? (
                    <span className="text-2xs text-tertiary">{t("skills.builtinReadonly")}</span>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleEnabled(skill);
                        }}
                      >
                        {skill.enabled ? t("skills.disable") : t("skills.enable")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-tertiary hover:text-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(skill);
                        }}
                      >
                        {t("skills.deleteBtn")}
                      </Button>
                    </>
                  )}
                  <ScopeChip scope={skill.scope} />
                  <IconChevron size={16} className="text-tertiary transition-colors group-hover:text-secondary" />
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {dialog === "new" && (
        <NewSkillDialog
          onClose={() => setDialog(null)}
          onCreate={(id) => {
            const operation = requests.capture(ws);
            if (!operation) return Promise.resolve();
            return api.skillCreate(id).then(() => {
              if (!requests.isCurrent(operation)) return;
              setDialog(null);
              refresh(operation.workspaceId);
            });
          }}
        />
      )}
      {dialog === "import" && (
        <ImportSkillDialog
          onClose={() => setDialog(null)}
          onImport={(path, global) => {
            const operation = requests.capture(ws);
            if (!operation) return Promise.resolve();
            return api.skillImport(path, global).then(() => {
              if (!requests.isCurrent(operation)) return;
              setDialog(null);
              refresh(operation.workspaceId);
            });
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title={t("skills.deleteTitle", { id: pendingDelete.id })}
          confirmLabel={t("skills.deleteConfirm")}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        >
          {t("skills.deleteBody", { scope: pendingDelete.scope })}
        </ConfirmDialog>
      )}
    </div>
  );
}

function NewSkillDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (id: string) => Promise<unknown> }) {
  const t = useT();
  const [id, setId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = id.trim();
    if (trimmed === "" || busy) return;
    setBusy(true);
    setError(null);
    onCreate(trimmed).catch((e: unknown) => {
      setError(t("skills.actionError", { error: String(e) }));
      setBusy(false);
    });
  };

  return (
    <ConfirmDialog
      title={t("skills.newTitle")}
      confirmLabel={busy ? "…" : t("skills.newConfirm")}
      onConfirm={submit}
      onCancel={onClose}
    >
      <Input
        value={id}
        autoFocus
        onChange={(e) => setId(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("skills.newIdPlaceholder")}
        className="font-mono"
        disabled={busy}
      />
      {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
    </ConfirmDialog>
  );
}

function ImportSkillDialog({
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
      setError(t("skills.actionError", { error: String(e) }));
      setBusy(false);
    });
  };

  return (
    <ConfirmDialog
      title={t("skills.importTitle")}
      confirmLabel={busy ? "…" : t("skills.importConfirm")}
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
        placeholder={t("skills.importPathPlaceholder")}
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
        {t("skills.importGlobal")}
      </label>
      {error && <p className="mt-2 text-2xs text-danger">{error}</p>}
    </ConfirmDialog>
  );
}
