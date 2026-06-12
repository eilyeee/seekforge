import { useStore } from "./store";
import { useT } from "./lib/i18n";
import { Button } from "./components/ui";
import { CommandPalette } from "./components/CommandPalette";
import { Onboarding } from "./components/Onboarding";
import { Sidebar } from "./components/Sidebar";
import { TodosPanel } from "./components/TodosPanel";
import { AgentsView } from "./views/AgentsView";
import { ChatView } from "./views/ChatView";
import { DiagnosticsView } from "./views/DiagnosticsView";
import { DiffView } from "./views/DiffView";
import { EvolutionView } from "./views/EvolutionView";
import { FilesView } from "./views/FilesView";
import { GitView } from "./views/GitView";
import { HooksView } from "./views/HooksView";
import { MemoryView } from "./views/MemoryView";
import { SessionsView } from "./views/SessionsView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";

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
          {view === "chat" && <ChatView />}
          {view === "sessions" && <SessionsView />}
          {view === "diff" && <DiffView />}
          {view === "files" && <FilesView />}
          {view === "git" && <GitView />}
          {view === "skills" && <SkillsView />}
          {view === "agents" && <AgentsView />}
          {view === "memory" && <MemoryView />}
          {view === "evolution" && <EvolutionView />}
          {view === "hooks" && <HooksView />}
          {view === "settings" && <SettingsView />}
          {view === "diagnostics" && <DiagnosticsView />}
        </div>
      </main>
      {todosOpen && <TodosPanel />}
      <CommandPalette />
    </div>
  );
}
