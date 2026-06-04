import { useT } from "../../lib/i18n";
import { Select, type SelectOption } from "../ui";
import { WorkspaceMenu } from "../WorkspaceMenu";
import type { ApprovalChoice, ChatTab, StartMode } from "../../store";
import type { ServerConfig } from "../../types";

const MODEL_SUGGESTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"];
const MODES: StartMode[] = ["edit", "ask", "plan"];
type Sandbox = "off" | "workspace-write" | "restricted";

type Props = {
  tab: ChatTab;
  config: ServerConfig | null;
  onSetModel: (m: string) => void;
  onSetThinking: (on: boolean) => void;
  onSetReasoningEffort: (e: "high" | "max") => void;
  onSetMode: (m: StartMode) => void;
  onSetApprovalMode: (a: ApprovalChoice) => void;
  onSetSandbox: (s: Sandbox) => void;
};

/**
 * The run-context toolbar that sits directly under the composer: workspace,
 * model, thinking, sandbox, run mode, and approval mode. Approval + edit/ask
 * stay changeable mid-conversation (they ride on each send); "plan" is
 * start-only and run controls lock while a message is in flight.
 */
export function RunControls({
  tab,
  config,
  onSetModel,
  onSetThinking,
  onSetReasoningEffort,
  onSetMode,
  onSetApprovalMode,
  onSetSandbox,
}: Props) {
  const t = useT();
  const running = tab.chat.running;
  const inSession = !!tab.chat.sessionId;

  // Model picker over the configured list (ensure the active value is present).
  const list = config?.models && config.models.length > 0 ? config.models : MODEL_SUGGESTIONS;
  const model = tab.model || config?.model || list[0] || "";
  const modelValues = model && !list.includes(model) ? [model, ...list] : list;
  const modelOptions: SelectOption[] = modelValues.map((m) => ({ value: m, label: m }));

  // Thinking collapses on/off + effort into one control: off / high / max.
  const thinkingOn = tab.thinking ?? config?.thinking ?? false;
  const thinkValue = thinkingOn ? tab.reasoningEffort : "off";
  const thinkOptions: SelectOption[] = [
    { value: "off", label: t("chat.thinkOff") },
    { value: "high", label: t("chat.reasoning.high") },
    { value: "max", label: t("chat.reasoning.max") },
  ];

  const sandbox = (config?.sandbox ?? "off") as Sandbox;
  const sandboxOptions: SelectOption[] = [
    { value: "off", label: t("chat.sandboxOff") },
    { value: "workspace-write", label: t("chat.sandbox.workspaceWrite") },
    { value: "restricted", label: t("chat.sandbox.restricted") },
  ];

  const approvalOptions: SelectOption[] = [
    { value: "confirm", label: t("chat.approval.confirm"), hint: t("chat.approval.confirmHint") },
    { value: "acceptEdits", label: t("chat.approval.acceptEdits"), hint: t("chat.approval.acceptEditsHint") },
    { value: "auto", label: `${t("chat.approval.auto")} ⚠`, hint: t("chat.approval.autoHint") },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-subtle bg-surface-raised/40 px-4 py-2">
      <WorkspaceMenu compact />

      <Select
        value={model}
        options={modelOptions}
        onChange={onSetModel}
        size="sm"
        disabled={running}
        leading={<span aria-hidden>⚙</span>}
        title={t("chat.modelTitle")}
        className="w-40"
      />

      <Select
        value={thinkValue}
        options={thinkOptions}
        onChange={(v) => (v === "off" ? onSetThinking(false) : (onSetThinking(true), onSetReasoningEffort(v as "high" | "max")))}
        size="sm"
        disabled={running}
        leading={<span aria-hidden>🧠</span>}
        title={t("chat.reasoningTitle")}
        className="w-28"
      />

      <Select
        value={sandbox}
        options={sandboxOptions}
        onChange={(v) => onSetSandbox(v as Sandbox)}
        size="sm"
        disabled={running}
        leading={<span aria-hidden>🛡</span>}
        title={t("chat.sandboxTitle")}
        className="w-36"
      />

      {/* Run mode: segmented (edit/ask switchable mid-session; plan start-only). */}
      <div className="flex items-center rounded-lg border border-subtle p-0.5" title={t("chat.modeTitle")}>
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={running || (mode === "plan" && inSession)}
            title={t(`chat.mode.${mode}Hint`)}
            onClick={() => onSetMode(mode)}
            className={`focus-ring rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
              tab.mode === mode ? "bg-accent-muted text-accent" : "text-secondary hover:bg-accent-muted/60"
            }`}
          >
            {t(`chat.mode.${mode}`)}
          </button>
        ))}
      </div>

      <Select
        value={tab.approvalMode}
        options={approvalOptions}
        onChange={(v) => onSetApprovalMode(v as ApprovalChoice)}
        size="sm"
        disabled={running}
        title={t("chat.approvalTitle")}
        className="w-36"
      />
    </div>
  );
}
