import { readFileSync } from "node:fs";

/** Read a UTF-8 file, or undefined when it is missing/unreadable. */
export function readFileIfExists(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
