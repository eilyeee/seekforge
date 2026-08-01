import type { KVStorage } from "./storage";

export type GraphDraft = {
  workspaceId: string;
  definitionText: string;
  parametersText: string;
  updatedAt: string;
};

export type GraphDraftInput = Pick<GraphDraft, "workspaceId" | "definitionText" | "parametersText">;

type GraphDraftStore = { version: 1; drafts: GraphDraft[] };

export const GRAPH_DRAFT_STORAGE_KEY = "seekforge.graph.drafts.v1";
export const MAX_GRAPH_DRAFTS = 20;
export const MAX_GRAPH_DRAFT_FIELD_BYTES = 256 * 1024;
export const MAX_GRAPH_DRAFT_STORE_BYTES = 1024 * 1024;
const MAX_GRAPH_DRAFT_CLOCK_SKEW_MS = 5 * 60 * 1000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_GRAPH_DRAFT_FIELD_BYTES &&
    bytes(value) <= MAX_GRAPH_DRAFT_FIELD_BYTES
  );
}

function decodeDraft(value: unknown): GraphDraft | undefined {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["workspaceId", "definitionText", "parametersText", "updatedAt"].includes(key))
  ) {
    return undefined;
  }
  if (
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length < 1 ||
    value.workspaceId.length > 4096 ||
    !validField(value.definitionText) ||
    !validField(value.parametersText) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    Date.parse(value.updatedAt) > Date.now() + MAX_GRAPH_DRAFT_CLOCK_SKEW_MS
  ) {
    return undefined;
  }
  return {
    workspaceId: value.workspaceId,
    definitionText: value.definitionText,
    parametersText: value.parametersText,
    updatedAt: value.updatedAt,
  };
}

function readStore(storage: KVStorage): GraphDraftStore {
  try {
    const raw = storage.getItem(GRAPH_DRAFT_STORAGE_KEY);
    if (raw === null || raw.length > MAX_GRAPH_DRAFT_STORE_BYTES || bytes(raw) > MAX_GRAPH_DRAFT_STORE_BYTES) {
      return { version: 1, drafts: [] };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (
      !record(parsed) ||
      Object.keys(parsed).some((key) => key !== "version" && key !== "drafts") ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.drafts) ||
      parsed.drafts.length > MAX_GRAPH_DRAFTS
    ) {
      return { version: 1, drafts: [] };
    }
    for (let index = 0; index < parsed.drafts.length; index++) {
      if (!Object.hasOwn(parsed.drafts, index)) return { version: 1, drafts: [] };
    }
    const drafts = parsed.drafts.map(decodeDraft);
    if (drafts.some((draft) => draft === undefined)) return { version: 1, drafts: [] };
    const decoded = drafts as GraphDraft[];
    if (new Set(decoded.map((draft) => draft.workspaceId)).size !== decoded.length) return { version: 1, drafts: [] };
    return { version: 1, drafts: decoded };
  } catch {
    return { version: 1, drafts: [] };
  }
}

export function loadGraphDraft(storage: KVStorage, workspaceId: string): GraphDraft | null {
  if (!workspaceId) return null;
  return readStore(storage).drafts.find((draft) => draft.workspaceId === workspaceId) ?? null;
}

export function saveGraphDraft(storage: KVStorage, input: GraphDraftInput, now = new Date()): boolean {
  if (
    !input.workspaceId ||
    input.workspaceId.length > 4096 ||
    !validField(input.definitionText) ||
    !validField(input.parametersText) ||
    !Number.isFinite(now.getTime())
  ) {
    return false;
  }
  const next: GraphDraft = { ...input, updatedAt: now.toISOString() };
  const drafts = [next, ...readStore(storage).drafts.filter((draft) => draft.workspaceId !== input.workspaceId)]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_GRAPH_DRAFTS);
  while (drafts.length > 0) {
    const serialized = JSON.stringify({ version: 1, drafts } satisfies GraphDraftStore);
    if (bytes(serialized) <= MAX_GRAPH_DRAFT_STORE_BYTES) {
      try {
        storage.setItem(GRAPH_DRAFT_STORAGE_KEY, serialized);
        return true;
      } catch {
        return false;
      }
    }
    drafts.pop();
  }
  return false;
}

export function clearGraphDraft(storage: KVStorage, workspaceId: string): boolean {
  if (!workspaceId) return false;
  const drafts = readStore(storage).drafts.filter((draft) => draft.workspaceId !== workspaceId);
  try {
    storage.setItem(GRAPH_DRAFT_STORAGE_KEY, JSON.stringify({ version: 1, drafts } satisfies GraphDraftStore));
    return true;
  } catch {
    // Persistence is advisory; the in-memory draft remains usable.
    return false;
  }
}

/** Owns one bounded debounced write and makes lifecycle flush/cancel explicit. */
export class DebouncedGraphDraftWriter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: { input: GraphDraftInput; onSettled?: (saved: boolean) => void } | undefined;

  constructor(
    private readonly storage: KVStorage,
    private readonly delayMs = 300,
  ) {}

  schedule(input: GraphDraftInput, onSettled?: (saved: boolean) => void): void {
    this.cancel();
    this.pending = { input, ...(onSettled ? { onSettled } : {}) };
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(notify = true): boolean | undefined {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return undefined;
    const saved = saveGraphDraft(this.storage, pending.input);
    if (notify) pending.onSettled?.(saved);
    return saved;
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}
