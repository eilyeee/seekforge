/**
 * Inline thinking triggers: words a user can drop into a prompt to raise the
 * V4 reasoning effort for that turn, mirroring Claude Code's "think" /
 * "think hard" / "ultrathink" ladder. Returns the effort to apply, or
 * undefined when no trigger is present (leave the configured default).
 */
export function detectThinkingKeyword(text: string): "high" | "max" | undefined {
  const t = text.toLowerCase();
  if (/ultrathink|think harder|think really hard|think super hard|think intensely/.test(t)) {
    return "max";
  }
  if (/megathink|think hard|think a lot|think deeply|think more|think step by step/.test(t)) {
    return "high";
  }
  return undefined;
}
