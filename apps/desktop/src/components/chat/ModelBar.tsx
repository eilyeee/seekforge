import { useT } from "../../lib/i18n";
import { Select, type SelectOption } from "../ui";
import type { ChatTab } from "../../store";
import type { ServerConfig } from "../../types";

const MODEL_SUGGESTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"];

type Props = {
  tab: ChatTab;
  config: ServerConfig | null;
  onSetModel: (m: string) => void;
  onSetThinking: (on: boolean) => void;
  onSetReasoningEffort: (e: "high" | "max") => void;
};

/**
 * The model + thinking controls, shown directly ABOVE the composer. Dropdowns
 * open upward (into the transcript) so they never cover the input below.
 */
export function ModelBar({ tab, config, onSetModel, onSetThinking, onSetReasoningEffort }: Props) {
  const t = useT();
  const running = tab.chat.running;

  const list = config?.models && config.models.length > 0 ? config.models : MODEL_SUGGESTIONS;
  const model = tab.model || config?.model || list[0] || "";
  const modelValues = model && !list.includes(model) ? [model, ...list] : list;
  const modelOptions: SelectOption[] = modelValues.map((m) => ({ value: m, label: m }));

  const thinkingOn = tab.thinking ?? config?.thinking ?? false;
  const thinkValue = thinkingOn ? tab.reasoningEffort : "off";
  const thinkOptions: SelectOption[] = [
    { value: "off", label: t("chat.thinkOff") },
    { value: "high", label: t("chat.reasoning.high") },
    { value: "max", label: t("chat.reasoning.max") },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-1.5">
      <Select
        up
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
        up
        value={thinkValue}
        options={thinkOptions}
        onChange={(v) => (v === "off" ? onSetThinking(false) : (onSetThinking(true), onSetReasoningEffort(v as "high" | "max")))}
        size="sm"
        disabled={running}
        leading={<span aria-hidden>🧠</span>}
        title={t("chat.reasoningTitle")}
        className="w-28"
      />
    </div>
  );
}
