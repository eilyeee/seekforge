import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "die") process.exit(7);
  if (req.method === "slow") return; // never answers
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
      expect(new RuntimeError("x", "y")).toBeInstanceOf(Error);
    } finally {
      client.dispose();
    }
  });
});
