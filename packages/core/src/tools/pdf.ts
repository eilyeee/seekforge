/**
 * PDF text for read_file, through poppler's `pdftotext` when it is installed.
 *
 * SeekForge ships no PDF parser of its own: a JS one is a large dependency for
 * a side feature, and poppler is already on most machines that handle PDFs.
 * Without it the read fails with an error that says how to get it.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clipLine } from "@seekforge/shared/format";
import { onAbortOnce } from "../util/abort.js";
import { killProcessTree } from "../util/process-tree.js";
import { scrubSecretEnv } from "../util/scrub-env.js";
import { ToolError } from "./errors.js";

const PDF_TIMEOUT_MS = 30_000;
const MAX_PDF_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PDF_STDERR_CHARS = 400;
export const MAX_PDF_PAGES_PER_READ = 20;

const PDF_INSTALL_HINT =
  "Reading PDFs needs poppler's `pdftotext` on PATH (macOS: `brew install poppler`; Debian/Ubuntu: `apt install poppler-utils`).";

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve `name` on PATH, skipping relative entries and any directory inside
 * the workspace: a checkout must not be able to supply the binary that reads
 * its own files (think `node_modules/.bin` on the PATH of an npm script).
 */
export function findTrustedExecutable(
  name: string,
  workspace: string,
  envPath: string | undefined = process.env.PATH,
): string | undefined {
  let workspaceReal = workspace;
  try {
    workspaceReal = fs.realpathSync(workspace);
  } catch {
    // keep the given path
  }
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (dir === "" || !path.isAbsolute(dir)) continue;
    let dirReal: string;
    try {
      dirReal = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (isInside(dirReal, workspaceReal)) continue;
    for (const ext of exts) {
      const candidate = path.join(dirReal, name + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** "3" or "2-7" → inclusive 1-based range, at most MAX_PDF_PAGES_PER_READ pages. */
export function parsePageRange(spec: string): { first: number; last: number } {
  const m = /^\s*(\d{1,6})\s*(?:-\s*(\d{1,6})\s*)?$/.exec(spec);
  const first = m ? Number(m[1]) : Number.NaN;
  const last = m ? Number(m[2] ?? m[1]) : Number.NaN;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
    throw new ToolError("invalid_input", `Invalid pages "${spec}": use a page ("3") or an inclusive range ("1-5")`);
  }
  if (last - first + 1 > MAX_PDF_PAGES_PER_READ) {
    throw new ToolError(
      "invalid_input",
      `pages "${spec}" spans ${last - first + 1} pages; read at most ${MAX_PDF_PAGES_PER_READ} per call`,
    );
  }
  return { first, last };
}

type ProcessOutput = { code: number | null; stdout: Buffer; stderr: string; overflow: boolean };

function runBounded(bin: string, args: string[], signal: AbortSignal | undefined): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: scrubSecretEnv(),
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offAbort();
      fn();
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(() => reject(new ToolError("timeout", `pdftotext did not finish within ${PDF_TIMEOUT_MS / 1000}s`)));
    }, PDF_TIMEOUT_MS);
    const offAbort = onAbortOnce(signal, () => {
      killProcessTree(child);
      finish(() => reject(new ToolError("cancelled", "Tool call cancelled")));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflow) return;
      if (bytes + chunk.length > MAX_PDF_STDOUT_BYTES) {
        chunks.push(chunk.subarray(0, MAX_PDF_STDOUT_BYTES - bytes));
        bytes = MAX_PDF_STDOUT_BYTES;
        overflow = true;
        killProcessTree(child);
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_PDF_STDERR_CHARS * 4) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) =>
      finish(() => resolve({ code, stdout: Buffer.concat(chunks, bytes), stderr, overflow })),
    );
  });
}

async function pageCount(
  workspace: string,
  file: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const pdfinfo = findTrustedExecutable("pdfinfo", workspace);
  if (!pdfinfo) return undefined;
  try {
    const out = await runBounded(pdfinfo, [file], signal);
    const m = /^Pages:\s+(\d+)\s*$/m.exec(out.stdout.toString("utf8"));
    return out.code === 0 && m ? Number(m[1]) : undefined;
  } catch (error) {
    if (error instanceof ToolError && error.code === "cancelled") throw error;
    return undefined;
  }
}

export type PdfText = {
  text: string;
  first: number;
  last: number;
  /** Known only when poppler's `pdfinfo` is available too. */
  totalPages?: number;
  truncated: boolean;
};

/** Extract the text of `pages` (default: the first MAX_PDF_PAGES_PER_READ). */
export async function extractPdfText(opts: {
  workspace: string;
  file: string;
  pages?: string;
  signal?: AbortSignal;
}): Promise<PdfText> {
  const pdftotext = findTrustedExecutable("pdftotext", opts.workspace);
  if (!pdftotext) throw new ToolError("pdf_unsupported", PDF_INSTALL_HINT);
  const totalPages = await pageCount(opts.workspace, opts.file, opts.signal);
  let { first, last } =
    opts.pages !== undefined ? parsePageRange(opts.pages) : { first: 1, last: MAX_PDF_PAGES_PER_READ };
  if (totalPages !== undefined) {
    if (first > totalPages) {
      throw new ToolError("invalid_input", `pages "${opts.pages}" is past the end: the PDF has ${totalPages} page(s)`);
    }
    last = Math.min(last, totalPages);
  }
  // "--" is not needed: `file` is absolute, so it can never read as an option.
  const out = await runBounded(
    pdftotext,
    ["-layout", "-enc", "UTF-8", "-f", String(first), "-l", String(last), opts.file, "-"],
    opts.signal,
  );
  if (out.code !== 0 && !out.overflow) {
    const detail = clipLine(out.stderr.trim().split("\n").slice(-3).join(" "), MAX_PDF_STDERR_CHARS);
    throw new ToolError("pdf_failed", `pdftotext failed (exit ${out.code ?? "signal"})${detail ? `: ${detail}` : ""}`);
  }
  const pages = out.stdout.toString("utf8").split("\f");
  // pdftotext ends every page with a form feed, leaving one empty tail.
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === "") pages.pop();
  const text = pages.map((page, i) => `--- page ${first + i} ---\n${page.replace(/\s+$/, "")}`).join("\n\n");
  return {
    text,
    first,
    last: totalPages !== undefined ? last : first + Math.max(pages.length, 1) - 1,
    ...(totalPages !== undefined ? { totalPages } : {}),
    truncated: out.overflow,
  };
}
