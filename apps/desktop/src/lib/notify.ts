/**
 * Web Notifications. The gating decision (shouldNotify) is pure and
 * unit-tested; the thin runtime part feature-detects the Notification API
 * (missing in some Tauri webviews) and no-ops silently without it.
 */

export type NotifyEvent =
  | { kind: "permission" }
  | { kind: "completed"; tabTitle: string }
  | { kind: "failed"; tabTitle: string };

/** Notifications fire only while the document is hidden. */
export function shouldNotify(ev: NotifyEvent, hidden: boolean): { title: string; body: string } | null {
  if (!hidden) return null;
  switch (ev.kind) {
    case "permission":
      return { title: "SeekForge", body: "SeekForge 等待你的确认" };
    case "completed":
      return { title: "SeekForge", body: `任务完成 — ${ev.tabTitle}` };
    case "failed":
      return { title: "SeekForge", body: `任务失败 — ${ev.tabTitle}` };
  }
}

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Lazily ask for permission (called on the first running session). */
export function requestNotifyPermission(): void {
  if (!supported()) return;
  try {
    if (Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // webview without a working implementation — silent no-op
  }
}

export function notify(ev: NotifyEvent): void {
  if (!supported()) return;
  try {
    if (Notification.permission !== "granted") return;
    const payload = shouldNotify(ev, typeof document !== "undefined" && document.hidden);
    if (!payload) return;
    const note = new Notification(payload.title, { body: payload.body });
    note.onclick = () => window.focus();
  } catch {
    // silent no-op (e.g. Notification constructor blocked in the webview)
  }
}
