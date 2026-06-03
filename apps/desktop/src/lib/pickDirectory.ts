/**
 * Native folder picker, available only inside the Tauri shell. The desktop UI
 * is served from a local HTTP origin, so in a plain browser there is no native
 * dialog — callers fall back to a manual path input when `canPickDirectory()`
 * is false.
 */

/** True when running inside the Tauri shell (native dialog is available). */
export function canPickDirectory(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Opens the OS folder picker and resolves to the chosen absolute path, or null
 * if the user cancelled (or no native dialog is available).
 */
export async function pickDirectory(): Promise<string | null> {
  if (!canPickDirectory()) return null;
  // Imported lazily so the web bundle never pulls in the Tauri plugin.
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  if (typeof selected === "string") return selected;
  return null;
}
