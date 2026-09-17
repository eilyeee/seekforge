import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearApiKeyHelperCache, resolveApiKeyHelperSync } from "@seekforge/shared/api-key-helper";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyHelperError, createDeepSeekProvider, DeepSeekApiError } from "../../src/provider/index.js";
import { resolveProviderConfig } from "../../src/provider/presets.js";

/** Keys the fake endpoint accepts; everything else is a 401. */
const accepted = new Set<string>();
const seen: string[] = [];
let server: Server;
let baseUrl: string;
let dir: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      seen.push(key);
      if (!accepted.has(key)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"invalid api key"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: `ok with ${key}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sf-provider-helper-"));
  accepted.clear();
  seen.length = 0;
  clearApiKeyHelperCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearApiKeyHelperCache();
  rmSync(dir, { recursive: true, force: true });
});

/** Prints `rotated-<n>` where n counts its runs (or a fixed key). */
function rotatingHelper(fixed?: string): { command: string; runs: () => number } {
  const counter = join(dir, "runs");
  writeFileSync(counter, "0");
  const script = join(dir, "helper.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const n = Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
console.log(${fixed === undefined ? '"rotated-" + n' : JSON.stringify(fixed)});`,
  );
  return { command: `"${process.execPath}" "${script}"`, runs: () => Number(readFileSync(counter, "utf8")) };
}

const ask = { messages: [{ role: "user" as const, content: "hi" }] };

describe("provider with an apiKeyHelper", { timeout: 30_000 }, () => {
  it("re-runs the helper once on a 401 and retries with the new key", async () => {
    const helper = rotatingHelper();
    // What the config merge does: the key reaches the provider as a plain apiKey.
    const apiKey = resolveApiKeyHelperSync(helper.command);
    expect(apiKey).toBe("rotated-1");
    accepted.add("rotated-2");

    const provider = createDeepSeekProvider(resolveProviderConfig({ apiKey, baseUrl, model: "deepseek-v4-flash" }));
    const response = await provider.chat(ask);
    expect(response.content).toBe("ok with rotated-2");
    expect(seen).toEqual(["rotated-1", "rotated-2"]);
    expect(helper.runs()).toBe(2);

    // The fresh key is cached: the next request neither re-runs nor fails first.
    await provider.chat(ask);
    expect(seen.slice(2)).toEqual(["rotated-2"]);
    expect(helper.runs()).toBe(2);
  });

  it("surfaces the 401 when the helper hands back the same rejected key", async () => {
    const helper = rotatingHelper("still-bad");
    const provider = createDeepSeekProvider(
      resolveProviderConfig({ apiKey: "ignored", apiKeyHelper: helper.command, baseUrl, model: "deepseek-v4-flash" }),
    );
    const failure = await provider.chat(ask).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeepSeekApiError);
    expect((failure as DeepSeekApiError).status).toBe(401);
    expect(seen).toEqual(["still-bad"]);
    expect(helper.runs()).toBe(2);
  });

  it("runs the helper before a request once its key is past the TTL", async () => {
    vi.stubEnv("SEEKFORGE_API_KEY_HELPER_TTL_MS", "0");
    const helper = rotatingHelper();
    for (const key of ["rotated-1", "rotated-2", "rotated-3"]) accepted.add(key);
    const provider = createDeepSeekProvider(
      resolveProviderConfig({ apiKey: "", apiKeyHelper: helper.command, baseUrl, model: "deepseek-v4-flash" }),
    );
    await provider.chat(ask);
    await provider.chat(ask);
    expect(seen).toEqual(["rotated-1", "rotated-2"]);
  });

  it("fails with the helper's error, and sends nothing, when the helper cannot produce a key", async () => {
    const provider = createDeepSeekProvider(
      resolveProviderConfig({ apiKey: "", apiKeyHelper: "exit 9", baseUrl, model: "deepseek-v4-flash" }),
    );
    const failure = await provider.chat(ask).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiKeyHelperError);
    expect((failure as Error).message).toContain("exited with code 9");
    expect(seen).toEqual([]);
  });

  it("keeps a plain apiKey exactly as before: no helper, no retry on 401", async () => {
    const provider = createDeepSeekProvider(resolveProviderConfig({ apiKey: "sk-plain", baseUrl }));
    const config = resolveProviderConfig({ apiKey: "sk-plain", baseUrl });
    expect(config).not.toHaveProperty("apiKeyHelper");
    const failure = await provider.chat(ask).catch((error: unknown) => error);
    expect((failure as DeepSeekApiError).status).toBe(401);
    expect(seen).toEqual(["sk-plain"]);
  });
});
