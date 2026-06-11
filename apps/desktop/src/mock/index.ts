/**
 * Single mock-mode flag check. Dev mode without the real server:
 * `VITE_MOCK=1 pnpm dev` or appending `?mock=1` to the URL.
 */
export function isMock(): boolean {
  if (typeof window === "undefined") return false;
  if (import.meta.env?.VITE_MOCK === "1") return true;
  return new URLSearchParams(window.location.search).get("mock") === "1";
}
