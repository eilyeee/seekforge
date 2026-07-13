import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeClient, RuntimeError } from "../../src/runtime/client.js";

/**
 * Stub runtime: a node script speaking the stdio protocol.
 * - echo → {ok, data:{got: params}}
 * - fail → {ok:false, error:{code:"sensitive_path",...}}
 * - die  → process.exit(7) without answering
 */
const STUB = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
const fs = require("node:fs");
const active = new Map();
let cancellationCount = 0;
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "cancel") {
    cancellationCount++;
    const running = active.get(req.params.id);
    if (running) {
      clearTimeout(running.timer);
      active.delete(req.params.id);
      if (running.marker) fs.writeFileSync(running.marker, "cancelled");
      process.stdout.write(JSON.stringify({ id: req.params.id, ok: false, error: { code: "cancelled", message: "cancelled" } }) + "\\n");
    }
    return;
  }
  if (req.method === "die") process.exit(7);
  if (req.method === "slow") {
    active.set(req.id, {
      marker: req.params.marker,
      timer: setTimeout(() => active.delete(req.id), 10000),
    });
    return;
  }
  if (req.method === "cancellation_count") {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { count: cancellationCount } }) + "\\n");
    return;
  }
  if (req.method === "malformed") {
    for (const value of [null, [], 42, { id: req.id, ok: "yes" }]) {
      process.stdout.write(JSON.stringify(value) + "\\n");
    }
  }
  if (req.method === "fail") {
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: "sensitive_path", message: "nope" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: { got: req.params } }) + "\\n");
});
`;

let dir: string;
let binPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "seekforge-rt-"));
  binPath = join(dir, "stub-runtime.js");
  writeFileSync(binPath, STUB);
  chmodSync(binPath, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runtime client", () => {
  it("round-trips a request and correlates by id", async () => {
    const client = createRuntimeClient({ binPath });
    try {
      const [a, b] = await Promise.all([
        client.call<{ got: unknown }>("echo", { workspace: "/w", n: 1 }),
        client.call<{ got: unknown }>("echo", { workspace: "/w", n: 2 }),
      ]);
      expect(a.got).toMatchObject({ n: 1 });
      expect(b.got).toMatchObject({ n: 2 });
    } finally {
      client.dispose();
    }
  });

  it("surfaces runtime errors with their code", async () => {
    const client = createRuntimeClient({ binPath });
    try {
      await expect(client.call("fail", { workspace: "/w" })).rejects.toMatchObject({
        name: "RuntimeError",
        code: "sensitive_path",
      });
    } finally {
      client.dispose();
    }
  });

  it("ignores valid JSON that is not a runtime response", async () => {
    const client = createRuntimeClient({ binPath });
    try {
      const result = await client.call<{ got: unknown }>("malformed", { workspace: "/w" });
      expect(result.got).toMatchObject({ workspace: "/w" });
    } finally {
      client.dispose();
    }
  });

  it("rejects pending requests when the runtime crashes, then respawns", async () => {
    const client = createRuntimeClient({ binPath });
    try {
      await expect(client.call("die", { workspace: "/w" })).rejects.toMatchObject({
        code: "runtime_crashed",
      });
      // next call must transparently respawn the child
      const again = await client.call<{ got: unknown }>("echo", { workspace: "/w", n: 3 });
      expect(again.got).toMatchObject({ n: 3 });
    } finally {
      client.dispose();
    }
  });

  it("times out unanswered requests", async () => {
    const client = createRuntimeClient({ binPath, requestTimeoutMs: 200 });
    try {
      await expect(client.call("slow", { workspace: "/w" })).rejects.toMatchObject({
        code: "runtime_timeout",
      });
      await expect(
        client.call<{ count: number }>("cancellation_count", {}, { timeoutMs: 2_000 }),
      ).resolves.toEqual({
        count: 1,
      });
      expect(new RuntimeError("x", "y")).toBeInstanceOf(Error);
    } finally {
      client.dispose();
    }
  });

  it("cancels a request through AbortSignal and remains usable", async () => {
    const client = createRuntimeClient({ binPath });
    const controller = new AbortController();
    try {
      const call = client.call("slow", { workspace: "/w" }, { signal: controller.signal });
      controller.abort();
      await expect(call).rejects.toMatchObject({ code: "cancelled" });
      await expect(client.call<{ count: number }>("cancellation_count", {})).resolves.toEqual({
        count: 1,
      });
    } finally {
      client.dispose();
    }
  });

  it("dispose cancels active requests before closing stdin", async () => {
    const client = createRuntimeClient({ binPath });
    const marker = join(dir, `disposed-${Date.now()}`);
    const call = client.call("slow", { workspace: "/w", marker });
    client.dispose();
    await expect(call).rejects.toMatchObject({ code: "disposed" });

    for (let i = 0; i < 100 && !existsSync(marker); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(marker)).toBe(true);
  });
});
