import { useT } from "../../lib/i18n";
import { Select, IconModel, IconSparkle, IconThinking, type SelectOption } from "../ui";
import type { ChatTab } from "../../store";
import type { ServerConfig } from "../../types";

const MODEL_SUGGESTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"];

type Props = {
  tab: ChatTab;
  config: ServerConfig | null;
  outputStyles: { name: string; kind: "builtin" | "custom" }[];
  onSetModel: (m: string) => void;
  onSetThinking: (on: boolean) => void;
  onSetReasoningEffort: (e: "high" | "max") => void;
  onSetOutputStyle: (s: string) => void;
};

/**
 * The model + thinking controls, shown directly ABOVE the composer. Dropdowns
 * open upward (into the transcript) so they never cover the input below.
 */
export function ModelBar({
  tab,
  config,
  outputStyles,
  onSetModel,
  onSetThinking,
  onSetReasoningEffort,
  onSetOutputStyle,
}: Props) {
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

  // Output style: always offer "default"; append discovered styles (built-in
  // and custom). The selected value falls back to "default" when untouched.
  const styleNames = outputStyles.length > 0 ? outputStyles.map((s) => s.name) : ["default"];
  const styleValue = tab.outputStyle || "default";
  const styleNamesWithSel = styleNames.includes(styleValue) ? styleNames : [styleValue, ...styleNames];
  const styleOptions: SelectOption[] = styleNamesWithSel.map((name) => ({ value: name, label: name }));

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-1.5 pt-2">
      <Select
        up
        value={model}
        options={modelOptions}
        onChange={onSetModel}
        size="sm"
        disabled={running}
        leading={<IconModel size={14} />}
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
        leading={<IconThinking size={14} />}
        title={t("chat.reasoningTitle")}
        className="w-44"
      />
      <Select
        up
        value={styleValue}
        options={styleOptions}
        onChange={onSetOutputStyle}
        size="sm"
        disabled={running}
        leading={<IconSparkle size={14} />}
        title={t("chat.outputStyleTitle")}
        className="w-40"
      />
    </div>
  );
}
