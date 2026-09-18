import { useState } from "react";
import { REASONING_EFFORTS, isReasoningEffort, type ReasoningEffort } from "@seekforge/shared";
import { useT } from "../../lib/i18n";
import { IconChevron, IconModel, IconSparkle, IconThinking, Select, type SelectOption } from "../ui";
import type { ChatTab } from "../../store";
import type { ServerConfig } from "../../types";

const MODEL_SUGGESTIONS = ["deepseek-v4-flash", "deepseek-v4-pro"];

type Props = {
  tab: ChatTab;
  config: ServerConfig | null;
  outputStyles: { name: string; kind: "builtin" | "custom" }[];
  onSetModel: (m: string) => void;
  onSetThinking: (on: boolean) => void;
  onSetReasoningEffort: (e: ReasoningEffort) => void;
  onSetOutputStyle: (s: string) => void;
};

/**
 * A quiet summary keeps the conversation surface focused. Detailed model
 * controls expand only when the person needs to change the next run.
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
  const [open, setOpen] = useState(false);
  const running = tab.chat.running;

  const list = config?.models && config.models.length > 0 ? config.models : MODEL_SUGGESTIONS;
  const model = tab.model || config?.model || list[0] || "";
  const modelValues = model && !list.includes(model) ? [model, ...list] : list;
  const modelOptions: SelectOption[] = modelValues.map((m) => ({ value: m, label: m }));

  const thinkingOn = tab.thinking ?? config?.thinking ?? false;
  const thinkValue = thinkingOn ? tab.reasoningEffort : "off";
  const thinkOptions: SelectOption[] = [
    { value: "off", label: t("chat.thinkOff") },
    ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: t(`chat.reasoning.${effort}`) })),
  ];

  // Output style: always offer "default"; append discovered styles (built-in
  // and custom). The selected value falls back to "default" when untouched.
  const styleNames = outputStyles.length > 0 ? outputStyles.map((s) => s.name) : ["default"];
  const styleValue = tab.outputStyle || "default";
  const styleNamesWithSel = styleNames.includes(styleValue) ? styleNames : [styleValue, ...styleNames];
  const styleOptions: SelectOption[] = styleNamesWithSel.map((name) => ({ value: name, label: name }));
  const summary = [
    model,
    thinkOptions.find((option) => option.value === thinkValue)?.label,
    styleValue === "default" ? "" : styleValue,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="border-b border-subtle/70 px-4 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={t("chat.modelTitle")}
        title={t("chat.modelTitle")}
        className="focus-ring flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-secondary hover:bg-surface-overlay hover:text-primary"
      >
        <IconModel size={14} className="shrink-0 text-tertiary" />
        <span className="truncate">{summary}</span>
        <IconChevron size={13} className={`shrink-0 text-tertiary ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-subtle pt-2">
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
            onChange={(v) => {
              if (v === "off") {
                onSetThinking(false);
                return;
              }
              if (!isReasoningEffort(v)) return;
              onSetThinking(true);
              onSetReasoningEffort(v);
            }}
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
      )}
    </div>
  );
}
