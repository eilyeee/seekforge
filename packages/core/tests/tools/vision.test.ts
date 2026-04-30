import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { configureVision } from "../../src/tools/builtins/vision.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const CONFIG = { model: "test-vision", baseUrl: "https://vision.example/v1", apiKey: "vk" };

function fetchReturningCompletion(content: unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

function writeImage(workspace: string, name: string, bytes = 64): string {
  const p = path.join(workspace, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
}

describe("image_analyze tool (through dispatcher)", () => {
  afterEach(() => {
    configureVision(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fails with vision_unconfigured when no vision endpoint is set", async () => {
    const ws = makeWorkspace();
    writeImage(ws, "shot.png");
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(call("image_analyze", { path: "shot.png" }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("vision_unconfigured");
    expect(res.error?.message).toContain("visionModel");
  });

  it("rejects invalid arguments before running", async () => {
    configureVision(CONFIG);
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(call("image_analyze", {}), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });

  it("is env-permission: prompts even in auto mode, showing the raw path", async () => {
    configureVision(CONFIG);
    fetchReturningCompletion("a screenshot");
    const ws = makeWorkspace();
    writeImage(ws, "shot.png");
    const requests: PermissionRequest[] = [];
    const ctx = makeCtx(ws, {
      policy: { approvalMode: "auto" },
      confirm: async (req) => {
        requests.push(req);
        return true;
      },
    });
    const res = await createDefaultDispatcher().execute(call("image_analyze", { path: "shot.png" }), ctx);
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.permission).toBe("env");
    expect(requests[0]?.path).toBe("shot.png");
  });

  it("denies when the user declines — no network call", async () => {
    configureVision(CONFIG);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy as unknown as typeof fetch);
    const ws = makeWorkspace();
    writeImage(ws, "shot.png");
    const ctx = makeCtx(ws, { confirm: async () => false });
    const res = await createDefaultDispatcher().execute(call("image_analyze", { path: "shot.png" }), ctx);
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects unsupported extensions by extension, before any IO", async () => {
    configureVision(CONFIG);
    const ws = makeWorkspace();
    writeImage(ws, "vector.svg");
    const res = await createDefaultDispatcher().execute(
      call("image_analyze", { path: "vector.svg" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unsupported_image");
  });

  it("rejects paths escaping the workspace", async () => {
    configureVision(CONFIG);
    const res = await createDefaultDispatcher().execute(
      call("image_analyze", { path: "../outside.png" }),
      makeCtx(makeWorkspace()),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_workspace");
  });

  it("enforces the 4MB size cap", async () => {
    configureVision(CONFIG);
    const ws = makeWorkspace();
    writeImage(ws, "huge.png", 4 * 1024 * 1024 + 1);
    const res = await createDefaultDispatcher().execute(
      call("image_analyze", { path: "huge.png" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("too_large");
  });

  it("happy path: posts an OpenAI-style image_url request and returns the description", async () => {
    configureVision(CONFIG);
    const spy = fetchReturningCompletion("A login form with two fields.");
    const ws = makeWorkspace();
    writeImage(ws, "ui.jpg");
    const res = await createDefaultDispatcher().execute(
      call("image_analyze", { path: "ui.jpg", question: "What UI is this?" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    expect((res.data as { description: string }).description).toBe("A login form with two fields.");

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vision.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer vk");
    const body = JSON.parse(init.body as string) as {
      model: string;
      max_tokens: number;
      messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[];
    };
    expect(body.model).toBe("test-vision");
    expect(body.max_tokens).toBe(1000);
    const parts = body.messages[0]!.content;
    expect(parts[0]).toEqual({ type: "text", text: "What UI is this?" });
    expect(parts[1]!.image_url!.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("uses the default question and accepts absolute in-workspace paths", async () => {
    configureVision(CONFIG);
    const spy = fetchReturningCompletion("desc");
    const ws = makeWorkspace();
    const abs = writeImage(ws, "shot.webp");
    const res = await createDefaultDispatcher().execute(
      call("image_analyze", { path: abs }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(true);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: { content: { type: string; text?: string }[] }[];
    };
    expect(body.messages[0]!.content[0]!.text).toBe("Describe this image in detail for a coding agent.");
  });

  it("maps HTTP errors and missing content to vision_failed", async () => {
    configureVision(CONFIG);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch,
    );
    const ws = makeWorkspace();
    writeImage(ws, "shot.gif");
    const res = await createDefaultDispatcher().execute(
      call("image_analyze", { path: "shot.gif" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("vision_failed");
  });
});
