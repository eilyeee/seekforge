import { lazy, Suspense } from "react";
import { useStore } from "./store";
import { useT } from "./lib/i18n";
import { Button } from "./components/ui";
import { CommandPalette } from "./components/CommandPalette";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { TodosPanel } from "./components/TodosPanel";
// ChatView is the default landing view, so it stays eager. The remaining,
// lower-frequency views are split into on-demand chunks via React.lazy to
// shrink the initial bundle (they load the first time their nav is opened).
import { ChatView } from "./views/ChatView";

const SessionsView = lazy(() => import("./views/SessionsView").then((m) => ({ default: m.SessionsView })));
const DiffView = lazy(() => import("./views/DiffView").then((m) => ({ default: m.DiffView })));
const FilesView = lazy(() => import("./views/FilesView").then((m) => ({ default: m.FilesView })));
const GitView = lazy(() => import("./views/GitView").then((m) => ({ default: m.GitView })));
const SkillsView = lazy(() => import("./views/SkillsView").then((m) => ({ default: m.SkillsView })));
const AgentsView = lazy(() => import("./views/AgentsView").then((m) => ({ default: m.AgentsView })));
const MemoryView = lazy(() => import("./views/MemoryView").then((m) => ({ default: m.MemoryView })));
const EvolutionView = lazy(() => import("./views/EvolutionView").then((m) => ({ default: m.EvolutionView })));
const HooksView = lazy(() => import("./views/HooksView").then((m) => ({ default: m.HooksView })));
const SecurityView = lazy(() => import("./views/SecurityView").then((m) => ({ default: m.SecurityView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));
const DiagnosticsView = lazy(() => import("./views/DiagnosticsView").then((m) => ({ default: m.DiagnosticsView })));

/** macOS uses an overlay title bar over the whole window top. The sidebar
 *  reserves its corner with pt-9; the content column reserves a matching
 *  draggable strip so its top chrome (tabs, toolbar) isn't covered by the
 *  click-eating title-bar zone. */
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function App() {
  const t = useT();
  const view = useStore((s) => s.view);
  const todosOpen = useStore((s) => s.todosOpen);
  const onboarding = useStore((s) => s.onboarding);
  const finishOnboarding = useStore((s) => s.finishOnboarding);
  const bootError = useStore((s) => s.bootError);
  const retryBoot = useStore((s) => s.retryBoot);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);

  // First-run welcome ahead of the workbench when no API key is configured.
  if (onboarding === "needed") {
    return <Onboarding onDone={finishOnboarding} onSkip={finishOnboarding} />;
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {IS_MAC && <div data-tauri-drag-region className="h-9 shrink-0" />}
        {bootError && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">
            <span className="min-w-0 flex-1 break-words">{t("boot.unreachable")}</span>
            <Button size="sm" onClick={retryBoot}>
              {t("boot.retry")}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-tertiary">
                {t("common.loading")}
              </div>
            }
          >
            {view === "chat" && <ChatView />}
            {view === "sessions" && <SessionsView key={activeWorkspaceId} />}
            {view === "diff" && <DiffView key={activeWorkspaceId} />}
            {view === "files" && <FilesView key={activeWorkspaceId} />}
            {view === "git" && <GitView key={activeWorkspaceId} />}
            {view === "skills" && <SkillsView key={activeWorkspaceId} />}
            {view === "agents" && <AgentsView key={activeWorkspaceId} />}
            {view === "memory" && <MemoryView key={activeWorkspaceId} />}
            {view === "evolution" && <EvolutionView key={activeWorkspaceId} />}
            {view === "hooks" && <HooksView key={activeWorkspaceId} />}
            {view === "security" && <SecurityView key={activeWorkspaceId} />}
            {view === "settings" && <SettingsView key={activeWorkspaceId} />}
            {view === "diagnostics" && <DiagnosticsView key={activeWorkspaceId} />}
          </Suspense>
        </div>
      </main>
      {todosOpen && <TodosPanel key={activeWorkspaceId} />}
      <CommandPalette />
    </div>
  );
}
