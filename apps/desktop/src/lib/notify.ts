/**
 * Desktop notifications.
 *
 * The gating + title/body mapping (`shouldNotify`) is pure and unit-tested.
 * The runtime part prefers the native OS notification (Tauri
 * `@tauri-apps/plugin-notification`) and falls back to the web Notification
 * API; under neither (or when the user turned notifications off) it no-ops.
 */

export type NotifyEvent =
  | { kind: "permission"; tool?: string }
  | { kind: "question" }
  | { kind: "completed"; tabTitle: string }
  | { kind: "failed"; tabTitle: string };

/** Persisted on/off switch (Settings -> notifications). Default on. */
const NOTIFY_SETTING_KEY = "seekforge.notifications";

export function notificationsEnabled(): boolean {
  if (typeof localStorage === "undefined") return true;
  return localStorage.getItem(NOTIFY_SETTING_KEY) !== "off";
}

export function setNotificationsEnabled(on: boolean): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(NOTIFY_SETTING_KEY, on ? "on" : "off");
}

/**
 * Pure decision: given an event, whether the window is focused, and whether
 * notifications are enabled, return the {title, body} to fire — or null.
 *
 * Permission/question prompts only fire while the window is unfocused (the
 * user is looking elsewhere); a finished run always fires so the user learns
 * about it even if focused on another app's tab. The `notifications` setting
 * gates everything.
 */
export function shouldNotify(
  ev: NotifyEvent,
  opts: { focused: boolean; enabled: boolean },
): { title: string; body: string } | null {
  if (!opts.enabled) return null;
  switch (ev.kind) {
    case "permission":
      if (opts.focused) return null;
      return {
        title: ev.tool ? `SeekForge — permission needed: ${ev.tool}` : "SeekForge — permission needed",
        body: "SeekForge is waiting for your approval.",
      };
    case "question":
      if (opts.focused) return null;
      return { title: "SeekForge — question", body: "SeekForge has a question for you." };
    case "completed":
      return { title: "Task finished", body: ev.tabTitle };
    case "failed":
      return { title: "Task failed", body: ev.tabTitle };
  }
}

// --- runtime senders ---------------------------------------------------------

/** A function that delivers a native notification. Injectable for tests. */
export type NotificationSender = (payload: { title: string; body: string }) => void;

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function webSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function focused(): boolean {
  // Treat an unknown/headless document as focused (-> no eager prompts).
  if (typeof document === "undefined") return true;
  return !document.hidden;
}

/** Fire via the native Tauri plugin (best-effort; permission checked first). */
async function sendNative(payload: { title: string; body: string }): Promise<void> {
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification(payload);
}

/** Fire via the web Notification API (no-op without permission). */
function sendWeb(payload: { title: string; body: string }): void {
  try {
    if (Notification.permission !== "granted") return;
    const note = new Notification(payload.title, { body: payload.body });
    note.onclick = () => window.focus();
  } catch {
    // Notification constructor blocked in the webview — silent no-op.
  }
}

/** Lazily ask for permission (called on the first running session). */
export function requestNotifyPermission(): void {
  if (!notificationsEnabled()) return;
  if (isTauri()) {
    void import("@tauri-apps/plugin-notification")
      .then(({ isPermissionGranted, requestPermission }) =>
        isPermissionGranted().then((g) => (g ? undefined : requestPermission())),
      )
      .catch(() => {
        // plugin missing / not granted — fine, notify() will retry/fall back.
      });
    return;
  }
  if (!webSupported()) return;
  try {
    if (Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // webview without a working implementation — silent no-op
  }
}

/**
 * Fire a notification for `ev` if the gate says so. `sender` is injectable so
 * tests can assert what would be delivered without touching Tauri/the DOM.
 */
export function notify(ev: NotifyEvent, sender?: NotificationSender): void {
  const payload = shouldNotify(ev, { focused: focused(), enabled: notificationsEnabled() });
  if (!payload) return;
  if (sender) {
    sender(payload);
    return;
  }
  if (isTauri()) {
    void sendNative(payload).catch(() => {
      // Native delivery failed (capability/permission) — fall back to web.
      if (webSupported()) sendWeb(payload);
    });
    return;
  }
  if (webSupported()) sendWeb(payload);
}
