import { randomUUID } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { isDenseArray } from "./orchestration.js";
import { acquireSessionLease } from "./session-lease.js";

export type WorkspaceGraphExecutorReservation = {
  executor: string;
  reservationId: string;
  fencingToken: string;
  acquiredAt: string;
  expiresAt: string;
};

export type WorkspaceGraphExecutorCapacityLease = WorkspaceGraphExecutorReservation & {
  renew(options?: { ttlMs?: number; now?: Date }): WorkspaceGraphExecutorReservation | undefined;
  release(): void;
};

export type WorkspaceGraphExecutorCapacityReconcileResult = {
  active: number;
  removed: string[];
};

type Document = { version: 1; reservations: WorkspaceGraphExecutorReservation[] };

const PATH = ".seekforge/graph-executor-capacity.json";
const MAX_BYTES = 512 * 1024;
const MAX_RESERVATIONS = 512;
const RESERVATION_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validReservation(value: unknown): value is WorkspaceGraphExecutorReservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["executor", "reservationId", "fencingToken", "acquiredAt", "expiresAt"]) &&
    isValidLoopDagId(value.executor) &&
    typeof value.reservationId === "string" &&
    RESERVATION_RE.test(value.reservationId) &&
    typeof value.fencingToken === "string" &&
    TOKEN_RE.test(value.fencingToken) &&
    typeof value.acquiredAt === "string" &&
    Number.isFinite(Date.parse(value.acquiredAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.parse(value.acquiredAt)
  );
}

function readDocument(workspace: string): Document {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  if (raw === undefined) return { version: 1, reservations: [] };
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "reservations"]) ||
    value.version !== 1 ||
    !isDenseArray(value.reservations) ||
    value.reservations.length > MAX_RESERVATIONS ||
    !value.reservations.every(validReservation) ||
    new Set(value.reservations.map((item) => item.reservationId)).size !== value.reservations.length ||
    new Set(value.reservations.map((item) => item.fencingToken)).size !== value.reservations.length
  ) {
    throw new Error("Persisted Graph executor capacity reservations are invalid");
  }
  return value as Document;
}

function writeDocument(workspace: string, reservations: readonly WorkspaceGraphExecutorReservation[]): void {
  const serialized = `${JSON.stringify({ version: 1, reservations })}\n`;
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Graph executor capacity reservations exceed limit");
  writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
}

function activeReservations(document: Document, nowMs: number): WorkspaceGraphExecutorReservation[] {
  return document.reservations.filter((reservation) => Date.parse(reservation.expiresAt) > nowMs);
}

/** Acquires bounded workspace-wide capacity with an idempotency-key fencing token. */
export function acquireWorkspaceGraphExecutorCapacity(
  workspace: string,
  executor: string,
  reservationId: string,
  capacity: number,
  options: { ttlMs?: number; now?: Date } = {},
): WorkspaceGraphExecutorCapacityLease | undefined {
  if (!isValidLoopDagId(executor) || !RESERVATION_RE.test(reservationId)) {
    throw new Error("Graph executor capacity identity is invalid");
  }
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_RESERVATIONS) {
    throw new RangeError(`Graph executor workspace capacity must be from 1 to ${MAX_RESERVATIONS}`);
  }
  const ttlMs = options.ttlMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) {
    throw new RangeError("Graph executor capacity ttlMs must be from 1000 to 86400000");
  }
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Graph executor capacity time is invalid");
  const lease = acquireSessionLease(workspace, "graph-executor-capacity");
  let reservation: WorkspaceGraphExecutorReservation | undefined;
  try {
    const document = readDocument(workspace);
    const active = activeReservations(document, nowMs);
    reservation = active.find((item) => item.reservationId === reservationId);
    if (reservation && reservation.executor !== executor) {
      throw new Error("Graph executor reservation id belongs to another executor");
    }
    if (!reservation) {
      if (active.length >= MAX_RESERVATIONS || active.filter((item) => item.executor === executor).length >= capacity) {
        if (active.length !== document.reservations.length) writeDocument(workspace, active);
        return undefined;
      }
      reservation = {
        executor,
        reservationId,
        fencingToken: randomUUID(),
        acquiredAt: now.toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      };
      writeDocument(workspace, [...active, reservation]);
    } else if (active.length !== document.reservations.length) {
      writeDocument(workspace, active);
    }
  } finally {
    lease.release();
  }
  const acquired = reservation;
  if (!acquired) return undefined;
  let released = false;
  return {
    ...acquired,
    renew(renewOptions = {}): WorkspaceGraphExecutorReservation | undefined {
      if (released) return undefined;
      const renewTtlMs = renewOptions.ttlMs ?? ttlMs;
      if (!Number.isSafeInteger(renewTtlMs) || renewTtlMs < 1_000 || renewTtlMs > 24 * 60 * 60_000) {
        throw new RangeError("Graph executor capacity ttlMs must be from 1000 to 86400000");
      }
      const renewNow = renewOptions.now ?? new Date();
      const renewNowMs = renewNow.getTime();
      if (!Number.isFinite(renewNowMs)) throw new Error("Graph executor capacity time is invalid");
      const renewLease = acquireSessionLease(workspace, "graph-executor-capacity");
      try {
        const document = readDocument(workspace);
        const current = document.reservations.find(
          (item) => item.reservationId === reservationId && item.fencingToken === acquired.fencingToken,
        );
        if (!current || Date.parse(current.expiresAt) <= renewNowMs) return undefined;
        const renewed = { ...current, expiresAt: new Date(renewNowMs + renewTtlMs).toISOString() };
        writeDocument(
          workspace,
          document.reservations.map((item) => (item === current ? renewed : item)),
        );
        return renewed;
      } finally {
        renewLease.release();
      }
    },
    release(): void {
      if (released) return;
      released = true;
      const releaseLease = acquireSessionLease(workspace, "graph-executor-capacity");
      try {
        const current = readDocument(workspace);
        const retained = current.reservations.filter(
          (item) => item.reservationId !== reservationId || item.fencingToken !== acquired.fencingToken,
        );
        if (retained.length !== current.reservations.length) writeDocument(workspace, retained);
      } finally {
        releaseLease.release();
      }
    },
  };
}

/** Removes expired reservations and, when supplied, exact reservations already proven orphaned by the host. */
export function reconcileWorkspaceGraphExecutorCapacity(
  workspace: string,
  options: { orphanReservationIds?: ReadonlySet<string>; now?: Date } = {},
): WorkspaceGraphExecutorCapacityReconcileResult {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Graph executor capacity time is invalid");
  if (options.orphanReservationIds) {
    for (const id of options.orphanReservationIds) {
      if (!RESERVATION_RE.test(id)) throw new Error("Graph executor reservation id is invalid");
    }
  }
  const lease = acquireSessionLease(workspace, "graph-executor-capacity");
  try {
    const document = readDocument(workspace);
    const retained = document.reservations.filter(
      (reservation) =>
        Date.parse(reservation.expiresAt) > nowMs && !options.orphanReservationIds?.has(reservation.reservationId),
    );
    const retainedIds = new Set(retained.map((reservation) => reservation.reservationId));
    const removed = document.reservations
      .filter((reservation) => !retainedIds.has(reservation.reservationId))
      .map((reservation) => reservation.reservationId)
      .sort();
    if (removed.length > 0) writeDocument(workspace, retained);
    return { active: retained.length, removed };
  } finally {
    lease.release();
  }
}

export function listWorkspaceGraphExecutorReservations(
  workspace: string,
  now = new Date(),
): WorkspaceGraphExecutorReservation[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Graph executor capacity time is invalid");
  return activeReservations(readDocument(workspace), nowMs).sort(
    (left, right) =>
      left.executor.localeCompare(right.executor) || left.reservationId.localeCompare(right.reservationId),
  );
}
