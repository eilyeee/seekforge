import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { findTrustedExecutable, parsePageRange } from "../../src/tools/pdf.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rest-of-a-png"),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("read_file images", () => {
  it("attaches a PNG for the model to view", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "shot.png"), PNG);
    const res = await dispatcher.execute(call("read_file", { path: "shot.png" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ path: "shot.png", type: "image", mediaType: "image/png", bytes: PNG.length });
    expect(res.images).toEqual([{ mediaType: "image/png", dataBase64: PNG.toString("base64"), label: "shot.png" }]);
  });

  it("trusts the bytes over the extension", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "photo.png"), JPEG);
    const res = await dispatcher.execute(call("read_file", { path: "photo.png" }), makeCtx(ws));
    expect(res.images?.[0]?.mediaType).toBe("image/jpeg");
  });

  it("refuses a file that is not really an image", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "fake.gif"), "just text");
    const res = await dispatcher.execute(call("read_file", { path: "fake.gif" }), makeCtx(ws));
    expect(res.error?.code).toBe("unsupported_image");
  });

  it("refuses an image too large to attach", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "huge.png"), Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]));
    const res = await dispatcher.execute(call("read_file", { path: "huge.png" }), makeCtx(ws));
    expect(res.error?.code).toBe("too_large");
    expect(res.error?.message).toContain("image_analyze");
    expect(res.images).toBeUndefined();
  });

  it("keeps the sensitive-file and containment rules", async () => {
    const ws = makeWorkspace();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-img-outside-"));
    fs.writeFileSync(path.join(outside, "secret.png"), PNG);
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(ws, "link.png"));
    const res = await dispatcher.execute(call("read_file", { path: "link.png" }), makeCtx(ws));
    expect(res.error?.code).toBe("outside_workspace");
    expect(res.images).toBeUndefined();
    fs.writeFileSync(path.join(ws, "id_rsa.png"), PNG);
    const sensitive = await dispatcher.execute(call("read_file", { path: "id_rsa.png" }), makeCtx(ws));
    expect(sensitive.error?.code).toBe("sensitive_path");
    expect(sensitive.images).toBeUndefined();
  });

  it("rejects pages for a non-PDF", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "a.txt"), "hi");
    const res = await dispatcher.execute(call("read_file", { path: "a.txt", pages: "1" }), makeCtx(ws));
    expect(res.error?.code).toBe("invalid_input");
  });
});

describe("read_file PDFs", () => {
  let binDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-poppler-"));
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function fakePoppler(pages: number): void {
    // Prints "page N text" for each page in -f..-l, form-feed separated, like pdftotext.
    fs.writeFileSync(
      path.join(binDir, "pdftotext"),
      [
        "#!/bin/sh",
        'first=1; last=1; while [ $# -gt 0 ]; do case "$1" in -f) first=$2; shift;; -l) last=$2; shift;; esac; shift; done',
        `[ "$last" -gt ${pages} ] && last=${pages}`,
        'i=$first; while [ $i -le $last ]; do printf "page %s text\\f" "$i"; i=$((i+1)); done',
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(binDir, "pdfinfo"), `#!/bin/sh\necho "Title: x"\necho "Pages:          ${pages}"\n`, {
      mode: 0o755,
    });
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  }

  function pdfWorkspace(): string {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "doc.pdf"), "%PDF-1.4 fake");
    return ws;
  }

  it("returns page-labelled text for the requested range", async () => {
    fakePoppler(30);
    const ws = pdfWorkspace();
    const res = await dispatcher.execute(call("read_file", { path: "doc.pdf", pages: "2-3" }), makeCtx(ws));
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.data).toMatchObject({ type: "pdf", pages: "2-3", totalPages: 30 });
    expect((res.data as { content: string }).content).toBe(
      "--- page 2 ---\npage 2 text\n\n--- page 3 ---\npage 3 text",
    );
  });

  it("reads the first pages by default and says how many there are", async () => {
    fakePoppler(25);
    const ws = pdfWorkspace();
    const res = await dispatcher.execute(call("read_file", { path: "doc.pdf" }), makeCtx(ws));
    expect(res.data).toMatchObject({ pages: "1-20", totalPages: 25 });
    fakePoppler(3);
    const short = await dispatcher.execute(call("read_file", { path: "doc.pdf" }), makeCtx(ws));
    expect(short.data).toMatchObject({ pages: "1-3", totalPages: 3 });
  });

  it("rejects a range past the end or wider than 20 pages", async () => {
    fakePoppler(5);
    const ws = pdfWorkspace();
    for (const pages of ["9", "1-21", "0", "3-2", "a"]) {
      const res = await dispatcher.execute(call("read_file", { path: "doc.pdf", pages }), makeCtx(ws));
      expect(res.error?.code, pages).toBe("invalid_input");
    }
  });

  it("explains how to get pdftotext when it is missing", async () => {
    process.env.PATH = binDir; // empty directory
    const ws = pdfWorkspace();
    const res = await dispatcher.execute(call("read_file", { path: "doc.pdf" }), makeCtx(ws));
    expect(res.error?.code).toBe("pdf_unsupported");
    expect(res.error?.message).toContain("poppler");
  });

  it("surfaces a pdftotext failure", async () => {
    fs.writeFileSync(path.join(binDir, "pdftotext"), "#!/bin/sh\necho 'Syntax Error: broken' >&2\nexit 1\n", {
      mode: 0o755,
    });
    process.env.PATH = binDir;
    const ws = pdfWorkspace();
    const res = await dispatcher.execute(call("read_file", { path: "doc.pdf" }), makeCtx(ws));
    expect(res.error?.code).toBe("pdf_failed");
    expect(res.error?.message).toContain("Syntax Error");
  });

  it("never runs a pdftotext that lives inside the workspace", () => {
    const ws = makeWorkspace();
    const planted = path.join(ws, "node_modules", ".bin");
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, "pdftotext"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findTrustedExecutable("pdftotext", ws, `${planted}${path.delimiter}relative/bin`)).toBeUndefined();
    fakePoppler(1);
    expect(findTrustedExecutable("pdftotext", ws, `${planted}${path.delimiter}${binDir}`)).toBe(
      path.join(fs.realpathSync(binDir), "pdftotext"),
    );
  });

  it("parses page ranges", () => {
    expect(parsePageRange("4")).toEqual({ first: 4, last: 4 });
    expect(parsePageRange(" 2 - 5 ")).toEqual({ first: 2, last: 5 });
    expect(() => parsePageRange("1-")).toThrow();
  });
});
