import { useT } from "../lib/i18n";

/** Most warnings shown inline; the rest are summarized as a count. */
const MAX_SHOWN = 8;

/**
 * What a rewind/backtrack could not undo (shell-command side effects outside
 * git, unrestorable files, a moved HEAD). Server text, rendered as plain text.
 */
export function RewindWarnings({ warnings, className = "" }: { warnings?: readonly string[]; className?: string }) {
  const t = useT();
  if (!warnings || warnings.length === 0) return null;
  const shown = warnings.slice(0, MAX_SHOWN);
  return (
    <div role="note" className={`rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn ${className}`}>
      <div className="font-medium">{t("rewind.warningsTitle", { count: warnings.length })}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {shown.map((warning, index) => (
          <li key={`${index}-${warning}`} className="whitespace-pre-wrap break-words">
            {warning}
          </li>
        ))}
      </ul>
      {warnings.length > shown.length && (
        <div className="mt-1 text-2xs">{t("rewind.warningsMore", { count: warnings.length - shown.length })}</div>
      )}
    </div>
  );
}
