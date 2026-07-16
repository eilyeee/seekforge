import { useT } from "../../lib/i18n";
import type { PlanItem } from "../../lib/events";
import { IconSkills } from "../ui";

const STATUS_GLYPH: Record<PlanItem["status"], string> = {
  pending: "☐",
  in_progress: "◐",
  done: "☑",
};

const STATUS_CLASS: Record<PlanItem["status"], string> = {
  pending: "text-tertiary",
  in_progress: "text-accent",
  done: "text-ok",
};

/** The update_plan checklist; a single card updated in place. */
export function PlanCard({ items }: { items: PlanItem[] }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-subtle bg-surface-raised px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-2xs uppercase tracking-wider text-tertiary">
        <IconSkills size={13} className="text-accent" />
        {t("chat.plan.title")}
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs leading-5">
            <span className={`select-none ${STATUS_CLASS[item.status]}`}>{STATUS_GLYPH[item.status]}</span>
            <span
              className={item.status === "done" ? "text-tertiary line-through decoration-current/40" : "text-secondary"}
            >
              {item.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
