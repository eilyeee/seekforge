/**
 * Shared id validation for REST (rest.ts) and WS (ws.ts) session lookups.
 */

/**
 * Rejects ids that could escape .seekforge/sessions/<id>/ — path separators,
 * ".." traversal, and the empty string are all unsafe.
 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes("..");
}
