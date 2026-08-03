import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

describe("ask_user tool", () => {
  const dispatcher = createDefaultDispatcher();

  it("rejects invalid arguments (empty question, too few/many or empty options)", async () => {
    const ctx = makeCtx(makeWorkspace(), { askUser: async () => "x" });
    for (const args of [
      {},
      { question: "", options: ["a", "b"] },
      { question: "pick one", options: ["only"] },
      { question: "pick one", options: ["a", "b", "c", "d", "e", "f", "g"] },
      { question: "pick one", options: ["a", ""] },
      // Neither choices nor an open question: nothing to answer.
      { question: "what now?" },
    ]) {
      const res = await dispatcher.execute(call("ask_user", args), ctx);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("invalid_args");
    }
  });

  it("fails with not_interactive when the context has no askUser channel", async () => {
    const ctx = makeCtx(makeWorkspace()); // no askUser
    const res = await dispatcher.execute(
      call("ask_user", { question: "keep or drop?", options: ["keep", "drop"] }),
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_interactive");
    expect(res.error?.message).toBe("ask_user is unavailable in this session");
  });

  it("passes the question through and returns the user's answer", async () => {
    const seen: Array<{ question: string; options: string[] }> = [];
    const ctx = makeCtx(makeWorkspace(), {
      askUser: async (q) => {
        seen.push(q);
        return q.options[1]!;
      },
    });
    const res = await dispatcher.execute(
      call("ask_user", { question: "keep or drop?", options: ["keep", "drop"] }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ answer: "drop" });
    expect(seen).toEqual([{ question: "keep or drop?", options: ["keep", "drop"] }]);
  });

  it("asks an open question with a Skip option, so it stays answerable anywhere", async () => {
    const seen: Array<{ question: string; options: string[]; freeText?: boolean }> = [];
    const ctx = makeCtx(makeWorkspace(), {
      askUser: async (q) => {
        seen.push(q);
        return "https://api.example.com";
      },
    });
    const res = await dispatcher.execute(
      call("ask_user", { question: "What is the API base url?", freeText: true }),
      ctx,
    );

    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ answer: "https://api.example.com" });
    // A frontend that ignores freeText still shows one answerable choice.
    expect(seen).toEqual([{ question: "What is the API base url?", options: ["Skip"], freeText: true }]);
  });

  it("reports a skipped open question as declined rather than as an answer", async () => {
    const ctx = makeCtx(makeWorkspace(), { askUser: async () => "Skip" });
    const res = await dispatcher.execute(call("ask_user", { question: "Which account?", freeText: true }), ctx);
    expect(res.data).toEqual({ answer: "Skip", declined: true });
  });

  it("keeps the choices when an open question also offers them", async () => {
    const seen: Array<{ options: string[]; freeText?: boolean }> = [];
    const ctx = makeCtx(makeWorkspace(), {
      askUser: async (q) => {
        seen.push(q);
        return "typed answer";
      },
    });
    const res = await dispatcher.execute(
      call("ask_user", { question: "Which branch?", options: ["main", "develop"], freeText: true }),
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(seen[0]).toMatchObject({ options: ["main", "develop"], freeText: true });
    expect(res.data).toEqual({ answer: "typed answer" });
  });

  it("is readonly: runs without confirmation even in stricter approval modes", async () => {
    const ctx = makeCtx(makeWorkspace(), {
      askUser: async () => "a",
      confirm: async () => {
        throw new Error("ask_user must never reach the permission prompt");
      },
      policy: { approvalMode: "manual", mode: "ask" },
    });
    const res = await dispatcher.execute(call("ask_user", { question: "a or b?", options: ["a", "b"] }), ctx);
    expect(res.ok).toBe(true);
    expect(res.meta?.permission).toBe("readonly");
  });
});
