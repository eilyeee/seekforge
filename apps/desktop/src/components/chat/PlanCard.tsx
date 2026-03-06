import type { PlanItem } from "../../lib/events";

const STATUS_GLYPH: Record<PlanItem["status"], string> = {
  pending: "☐",
  in_progress: "◐",
  done: "☑",
};

const STATUS_CLASS: Record<PlanItem["status"], string> = {
  pending: "text-zinc-500",
  in_progress: "text-amber-400",
  done: "text-emerald-400",
};

/** The update_plan checklist; a single card updated in place. */
export function PlanCard({ items }: { items: PlanItem[] }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">plan</div>
      <ul className="space-y-0.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className={STATUS_CLASS[item.status]}>{STATUS_GLYPH[item.status]}</span>
            <span className={item.status === "done" ? "text-zinc-500" : "text-zinc-300"}>{item.step}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
