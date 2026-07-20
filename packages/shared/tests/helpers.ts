import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "seekforge-shared-test-"));
}
