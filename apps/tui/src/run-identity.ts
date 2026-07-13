export type RunEntry = {
  controller: AbortController;
  runId: number;
  sigintCount: number;
};

export type RunReservation = RunEntry & { tabId: number };

export function reserveRun(
  runs: Map<number, RunEntry>,
  tabId: number,
  runId: number,
): RunReservation | null {
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
