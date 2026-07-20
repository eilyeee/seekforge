import { describe, expect, it } from "vitest";
import { abortablePromise } from "../../src/util/abort.js";

describe("abortablePromise", () => {
  it("observes a rejected producer promise when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const producer = Promise.reject(new Error("producer failed"));

    await expect(abortablePromise(producer, controller.signal, () => new Error("cancelled"))).rejects.toThrow(
      "cancelled",
    );
    await Promise.resolve();
  });
});
