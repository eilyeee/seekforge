import { LoopManager } from "../components/chat/LoopManager";
import { useT } from "../lib/i18n";
import { activeTab, useStore } from "../store";

/**
 * A home for the Loop and Graph engines.
 *
 * Everything here already existed — as sections wedged under the chat
 * composer, in a column sized for a conversation. The engine schedules runs,
 * tracks budgets and keeps evidence; reading that in a narrow collapsible panel
 * was the limiting factor, not the data. This view is the same components with
 * the window to themselves.
 *
 * Starting or resuming a run still belongs to the active chat tab: that is
 * where its permission prompts and questions appear, so the view says so rather
 * than letting a run seem to have gone somewhere else.
 */
export function OrchestrationView() {
  const t = useT();
  const tab = useStore((state) => activeTab(state.tabs));
  const resumeLoop = useStore((state) => state.resumeLoop);
  const setView = useStore((state) => state.setView);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium text-primary">{t("orchestration.title")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-secondary">{t("orchestration.subtitle")}</p>
        <p className="mt-2 text-xs text-tertiary">
          {t("orchestration.runsInChat")}{" "}
          <button type="button" className="focus-ring text-accent underline" onClick={() => setView("chat")}>
            {t("orchestration.openChat")}
          </button>
        </p>
      </header>

      <LoopManager running={tab.chat.running} onResume={resumeLoop} />
    </div>
  );
}
