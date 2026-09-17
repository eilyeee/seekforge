/** Client-side session search (Sessions view filter input). */

type Searchable = { id: string; task: string; name?: string };

/**
 * Case-insensitive filter over session id, the user-chosen name, and task
 * text. Multiple whitespace-separated terms must ALL match (each against id,
 * name OR task); a blank query returns everything.
 */
export function filterSessions<T extends Searchable>(sessions: readonly T[], query: string): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...sessions];
  return sessions.filter((s) => {
    const id = s.id.toLowerCase();
    const task = s.task.toLowerCase();
    const name = (s.name ?? "").toLowerCase();
    return terms.every((t) => id.includes(t) || task.includes(t) || name.includes(t));
  });
}
