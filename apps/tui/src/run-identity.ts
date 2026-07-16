import type { DispatchManager } from "@seekforge/core";

export type RunEntry = {
  controller: AbortController;
  runId: number;
  sigintCount: number;
  /** Present only while this exact run owns a live subagent manager. */
  dispatchManager?: DispatchManager;
};

export type RunReservation = RunEntry & { tabId: number };

export function reserveRun(runs: Map<number, RunEntry>, tabId: number, runId: number): RunReservation | null {
  if (runs.has(tabId)) return null;
  const reservation = { tabId, runId, controller: new AbortController(), sigintCount: 0 };
  runs.set(tabId, reservation);
  return reservation;
}

export function ownsRun(runs: Map<number, RunEntry>, reservation: RunReservation): boolean {
  return runs.get(reservation.tabId)?.runId === reservation.runId;
}

export function releaseRun(runs: Map<number, RunEntry>, reservation: RunReservation): boolean {
  if (!ownsRun(runs, reservation)) return false;
  runs.delete(reservation.tabId);
  return true;
}

export function interruptRun(runs: Map<number, RunEntry>, tabId: number): number | null {
  const entry = runs.get(tabId);
  if (!entry) return null;
  entry.sigintCount += 1;
  entry.controller.abort();
  return entry.sigintCount;
}

type CancellablePermission = { runId: number; resolve: (result: false) => void };
type CancellableQuestion = { runId: number; resolve: (answer: string) => void };

export function cancelRun(
  runs: Map<number, RunEntry>,
  permissions: Map<number, CancellablePermission>,
  questions: Map<number, CancellableQuestion>,
  tabId: number,
): { sigintCount: number | null; permissionCancelled: boolean; questionCancelled: boolean } {
  const run = runs.get(tabId);
  if (!run) return { sigintCount: null, permissionCancelled: false, questionCancelled: false };
  const permission = takeRunOwned(permissions, tabId, run.runId);
  const question = takeRunOwned(questions, tabId, run.runId);
  permission?.resolve(false);
  question?.resolve("(no answer — the session was cancelled)");
  return {
    sigintCount: interruptRun(runs, tabId),
    permissionCancelled: permission !== null,
    questionCancelled: question !== null,
  };
}

export function takeRunOwned<T extends { runId: number }>(
  entries: Map<number, T>,
  tabId: number,
  runId: number,
): T | null {
  const entry = entries.get(tabId);
  if (entry?.runId !== runId) return null;
  entries.delete(tabId);
  return entry;
}
