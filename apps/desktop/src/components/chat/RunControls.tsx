import { useT } from "../../lib/i18n";
import { Select, IconShield, type SelectOption } from "../ui";
import { WorkspaceMenu } from "../WorkspaceMenu";
import type { ApprovalChoice, ChatTab, StartMode } from "../../store";
import type { ServerConfig } from "../../types";

const MODES: StartMode[] = ["edit", "ask", "plan"];
type Sandbox = "off" | "read-only" | "workspace-write" | "restricted";

type Props = {
  tab: ChatTab;
  config: ServerConfig | null;
  onSetMode: (m: StartMode) => void;
  onSetApprovalMode: (a: ApprovalChoice) => void;
  onSetSandbox: (s: Sandbox | null) => void;
};

/**
 * The run-context toolbar BELOW the composer: workspace, sandbox, run mode, and
 * approval mode. (Model + thinking live in ModelBar above the input.) Approval +
 * edit/ask stay changeable mid-conversation; "plan" is start-only and the
 * controls lock while a message is in flight. Dropdowns open upward.
 */
export function RunControls({ tab, config, onSetMode, onSetApprovalMode, onSetSandbox }: Props) {
  const t = useT();
  const running = tab.chat.running;
  const inSession = !!tab.chat.sessionId;

  const configuredSandbox = (config?.sandbox ?? "off") as Sandbox;
  const sandbox = tab.sandbox ?? "project";
  const sandboxOptions: SelectOption[] = [
    { value: "project", label: t("chat.sandbox.project", { mode: configuredSandbox }) },
    { value: "off", label: t("chat.sandboxOff") },
    { value: "read-only", label: t("chat.sandbox.readOnly") },
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
        up
        value={sandbox}
        options={sandboxOptions}
        onChange={(v) => onSetSandbox(v === "project" ? null : (v as Sandbox))}
        size="sm"
        disabled={running}
        leading={<IconShield size={14} />}
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
        up
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
