import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { TodosPanel } from "./components/TodosPanel";
import { AgentsView } from "./views/AgentsView";
import { ChatView } from "./views/ChatView";
import { DiffView } from "./views/DiffView";
import { EvolutionView } from "./views/EvolutionView";
import { MemoryView } from "./views/MemoryView";
import { SessionsView } from "./views/SessionsView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";

export function App() {
  const view = useStore((s) => s.view);
  const todosOpen = useStore((s) => s.todosOpen);
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        {view === "chat" && <ChatView />}
        {view === "sessions" && <SessionsView />}
        {view === "diff" && <DiffView />}
        {view === "skills" && <SkillsView />}
        {view === "agents" && <AgentsView />}
        {view === "memory" && <MemoryView />}
        {view === "evolution" && <EvolutionView />}
        {view === "settings" && <SettingsView />}
      </main>
      {todosOpen && <TodosPanel />}
    </div>
  );
}
