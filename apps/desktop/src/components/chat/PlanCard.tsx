import type { PlanItem } from "../../lib/events";

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
  return (
    <div className="rounded-xl border border-subtle bg-surface-raised/70 px-3 py-2">
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-tertiary">plan</div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs leading-5">
            <span className={`select-none ${STATUS_CLASS[item.status]}`}>{STATUS_GLYPH[item.status]}</span>
            <span className={item.status === "done" ? "text-tertiary line-through decoration-zinc-700" : "text-secondary"}>
              {item.step}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
