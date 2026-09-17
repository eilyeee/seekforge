/**
 * Turns a POST /api/sessions/:id/compact answer into the one-line toast the
 * chat view shows. Pure; the translator is passed in.
 */
import type { SessionCompactResult } from "../types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** At most this many hook notices are joined into the toast. */
const MAX_NOTICES = 3;

export function compactToast(result: SessionCompactResult | null | undefined, t: Translate): string {
  if (!result) return t("chat.compactNothing");
  const notices = (result.notices ?? []).filter((notice) => typeof notice === "string" && notice.trim() !== "");
  const base = t("chat.compactDone");
  if (notices.length === 0) return base;
  const shown = notices.slice(0, MAX_NOTICES).join(" · ");
  const more = notices.length > MAX_NOTICES ? ` (+${notices.length - MAX_NOTICES})` : "";
  return `${base} ${t("chat.compactNotices", { notices: `${shown}${more}` })}`;
}
