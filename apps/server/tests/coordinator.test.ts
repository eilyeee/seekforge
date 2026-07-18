import { join } from "node:path";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalRepositoryKey } from "../src/coordinator.js";
import { makeWorkspace } from "./helpers.js";

describe("canonicalRepositoryKey", () => {
  it("uses a physical workspace key for an existing non-Git directory", async () => {
    const workspace = makeWorkspace();
    await expect(canonicalRepositoryKey(workspace)).resolves.toBe(`workspace:${realpathSync(workspace)}`);
  });

  it("surfaces Git spawn failures instead of weakening repository serialization", async () => {
    const missing = join(makeWorkspace(), "missing-workspace");
    await expect(canonicalRepositoryKey(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
