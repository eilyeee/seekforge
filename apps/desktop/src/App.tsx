import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/ChatView";
import { DiffView } from "./views/DiffView";
import { MemoryView } from "./views/MemoryView";
import { SessionsView } from "./views/SessionsView";
import { SettingsView } from "./views/SettingsView";
import { SkillsView } from "./views/SkillsView";

export function App() {
  const view = useStore((s) => s.view);
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="min-w-0 flex-1">
        {view === "chat" && <ChatView />}
        {view === "sessions" && <SessionsView />}
        {view === "diff" && <DiffView />}
        {view === "skills" && <SkillsView />}
        {view === "memory" && <MemoryView />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
