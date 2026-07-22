import { readFileSync } from "node:fs";

/** Read one page after a physical byte cursor. */
export function readEventPage(path, byteOffset = 0, limit = 1) {
  const data = readFileSync(path, "utf8");
  const tail = data.slice(byteOffset);
  const lines = tail.split("\n").filter(Boolean).slice(0, limit);
  const events = lines.map((line) => JSON.parse(line));
  const consumed = lines.reduce((bytes, line) => bytes + Buffer.byteLength(`${line}\n`), 0);
  return { events, byteOffset: byteOffset + consumed };
}
