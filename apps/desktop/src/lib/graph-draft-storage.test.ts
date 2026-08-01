import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearGraphDraft,
  DebouncedGraphDraftWriter,
  GRAPH_DRAFT_STORAGE_KEY,
  loadGraphDraft,
  MAX_GRAPH_DRAFT_FIELD_BYTES,
  saveGraphDraft,
} from "./graph-draft-storage";
import type { KVStorage } from "./storage";

function memoryStorage(initial: Record<string, string> = {}): KVStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("Graph draft storage", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips drafts by exact workspace identity and clears one owner", () => {
    const storage = memoryStorage();
    expect(
      saveGraphDraft(
        storage,
        { workspaceId: "project-a", definitionText: '{"graphId":"a"}', parametersText: "{}" },
        new Date("2026-08-01T00:00:00Z"),
      ),
    ).toBe(true);
    expect(loadGraphDraft(storage, "project-a")).toMatchObject({ definitionText: '{"graphId":"a"}' });
    expect(loadGraphDraft(storage, "project-b")).toBeNull();
    expect(clearGraphDraft(storage, "project-a")).toBe(true);
    expect(loadGraphDraft(storage, "project-a")).toBeNull();
  });

  it("reports a failed persistent clear", () => {
    const original = JSON.stringify({
      version: 1,
      drafts: [
        {
          workspaceId: "project-a",
          definitionText: "{}",
          parametersText: "{}",
          updatedAt: "2026-08-01T00:00:00Z",
        },
      ],
    });
    const storage: KVStorage = {
      getItem: () => original,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(clearGraphDraft(storage, "project-a")).toBe(false);
    expect(loadGraphDraft(storage, "project-a")).not.toBeNull();
  });

  it("fails closed for corrupt, duplicate, or oversized persisted records", () => {
    const duplicate = {
      version: 1,
      drafts: [
        { workspaceId: "a", definitionText: "{}", parametersText: "{}", updatedAt: "2026-08-01T00:00:00Z" },
        { workspaceId: "a", definitionText: "{}", parametersText: "{}", updatedAt: "2026-08-01T01:00:00Z" },
      ],
    };
    expect(loadGraphDraft(memoryStorage({ [GRAPH_DRAFT_STORAGE_KEY]: "{" }), "a")).toBeNull();
    expect(loadGraphDraft(memoryStorage({ [GRAPH_DRAFT_STORAGE_KEY]: JSON.stringify(duplicate) }), "a")).toBeNull();
    const sparse = new Array(1);
    expect(
      loadGraphDraft(memoryStorage({ [GRAPH_DRAFT_STORAGE_KEY]: JSON.stringify({ version: 1, drafts: sparse }) }), "a"),
    ).toBeNull();
    expect(
      loadGraphDraft(
        memoryStorage({
          [GRAPH_DRAFT_STORAGE_KEY]: JSON.stringify({ version: 1, drafts: [], unexpected: true }),
        }),
        "a",
      ),
    ).toBeNull();
    const future = {
      version: 1,
      drafts: [
        {
          workspaceId: "a",
          definitionText: "{}",
          parametersText: "{}",
          updatedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        },
      ],
    };
    expect(loadGraphDraft(memoryStorage({ [GRAPH_DRAFT_STORAGE_KEY]: JSON.stringify(future) }), "a")).toBeNull();
    expect(
      saveGraphDraft(memoryStorage(), {
        workspaceId: "a",
        definitionText: "界".repeat(MAX_GRAPH_DRAFT_FIELD_BYTES),
        parametersText: "{}",
      }),
    ).toBe(false);
  });

  it("treats storage quota failures as loss of advisory persistence", () => {
    const storage: KVStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(saveGraphDraft(storage, { workspaceId: "a", definitionText: "{}", parametersText: "{}" })).toBe(false);
  });

  it("debounces to the newest payload, flushes lifecycle state, and supports explicit cancellation", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const writer = new DebouncedGraphDraftWriter(storage, 300);
    const settled = vi.fn();
    writer.schedule({ workspaceId: "a", definitionText: "first", parametersText: "{}" }, settled);
    writer.schedule({ workspaceId: "a", definitionText: "second", parametersText: "{}" }, settled);
    vi.advanceTimersByTime(299);
    expect(loadGraphDraft(storage, "a")).toBeNull();
    expect(writer.flush(false)).toBe(true);
    expect(loadGraphDraft(storage, "a")?.definitionText).toBe("second");
    expect(settled).not.toHaveBeenCalled();

    writer.schedule({ workspaceId: "a", definitionText: "cancelled", parametersText: "{}" }, settled);
    writer.cancel();
    vi.runAllTimers();
    expect(loadGraphDraft(storage, "a")?.definitionText).toBe("second");
  });
});
