import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * The point of these tools is that a notebook is cells, not JSON. The tests
 * therefore care about two things: the cells come back readable, and an edit
 * changes one cell without reformatting the file around it.
 */

const dispatcher = createDefaultDispatcher();

/** nbformat's own shape: one-space indent, source as an array of lines. */
const NOTEBOOK = {
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: ["# Analysis\n", "\n", "Load the data.\n"],
    },
    {
      cell_type: "code",
      execution_count: 3,
      metadata: { tags: ["load"] },
      outputs: [
        { output_type: "stream", name: "stdout", text: ["loaded 42 rows\n"] },
        { output_type: "execute_result", data: { "text/plain": ["<DataFrame>"] }, metadata: {} },
      ],
      source: ["import pandas as pd\n", "df = pd.read_csv('data.csv')\n"],
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [{ output_type: "error", ename: "KeyError", evalue: "'missing'", traceback: ["…"] }],
      source: ["df['missing']\n"],
    },
  ],
  metadata: { kernelspec: { display_name: "Python 3", name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
};

function notebookWorkspace(): { ws: string; file: string; raw: string } {
  const ws = makeWorkspace();
  const raw = `${JSON.stringify(NOTEBOOK, null, 1)}\n`;
  const file = path.join(ws, "analysis.ipynb");
  fs.writeFileSync(file, raw);
  return { ws, file, raw };
}

const read = (file: string): string => fs.readFileSync(file, "utf8");

describe("notebook_read", () => {
  it("returns each cell as source plus what it printed", async () => {
    const { ws } = notebookWorkspace();
    const res = await dispatcher.execute(call("notebook_read", { path: "analysis.ipynb" }), makeCtx(ws));
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const data = res.data as {
      count: number;
      cells: Array<{ index: number; type: string; source: string; output?: string }>;
    };

    expect(data.count).toBe(3);
    expect(data.cells[0]).toEqual({
      index: 0,
      type: "markdown",
      source: "# Analysis\n\nLoad the data.\n",
    });
    expect(data.cells[1]?.source).toBe("import pandas as pd\ndf = pd.read_csv('data.csv')\n");
    // A stream and an execute_result both read as text.
    expect(data.cells[1]?.output).toBe("loaded 42 rows\n\n<DataFrame>");
    // An error output says what the error was.
    expect(data.cells[2]?.output).toBe("KeyError: 'missing'");
  });

  it("omits outputs when asked", async () => {
    const { ws } = notebookWorkspace();
    const res = await dispatcher.execute(
      call("notebook_read", { path: "analysis.ipynb", includeOutputs: false }),
      makeCtx(ws),
    );
    const data = res.data as { cells: Array<{ output?: string }> };
    expect(data.cells.every((cell) => cell.output === undefined)).toBe(true);
  });

  it("says what is wrong with a file that is not a notebook", async () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "notes.ipynb"), "not json at all");
    const res = await dispatcher.execute(call("notebook_read", { path: "notes.ipynb" }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_notebook");
  });
});

describe("notebook_edit", () => {
  it("replaces one cell and leaves the rest of the file byte-identical", async () => {
    const { ws, file, raw } = notebookWorkspace();
    const res = await dispatcher.execute(
      call("notebook_edit", {
        path: "analysis.ipynb",
        cellIndex: 2,
        mode: "replace",
        source: "df['present']\n",
      }),
      makeCtx(ws),
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);

    const after = read(file);
    const parsed = JSON.parse(after) as typeof NOTEBOOK;
    expect(parsed.cells[2]?.source).toEqual(["df['present']\n"]);
    // Everything else — key order, indentation, trailing newline, the other
    // cells — is untouched, so the change is reviewable in a git diff. A
    // reformat would rewrite nearly every line; measure how many survive
    // verbatim rather than by position, since removing the stale outputs
    // legitimately shifts what follows.
    expect(after.endsWith("\n")).toBe(true);
    const survived = new Set(after.split("\n"));
    const originalLines = raw.split("\n");
    const kept = originalLines.filter((line) => survived.has(line)).length;
    expect(kept / originalLines.length).toBeGreaterThan(0.8);
    expect(parsed.metadata).toEqual(NOTEBOOK.metadata);
    expect(parsed.cells[0]).toEqual(NOTEBOOK.cells[0]);
  });

  it("clears the outputs of a cell whose code it replaced", async () => {
    const { ws, file } = notebookWorkspace();
    await dispatcher.execute(
      call("notebook_edit", { path: "analysis.ipynb", cellIndex: 1, mode: "replace", source: "print('hi')\n" }),
      makeCtx(ws),
    );
    const parsed = JSON.parse(read(file)) as { cells: Array<{ outputs?: unknown[]; execution_count?: unknown }> };
    // Keeping them would show a result the new code never produced.
    expect(parsed.cells[1]?.outputs).toEqual([]);
    expect(parsed.cells[1]?.execution_count).toBeNull();
  });

  it("inserts before the given index and deletes by index", async () => {
    const { ws, file } = notebookWorkspace();
    await dispatcher.execute(
      call("notebook_edit", {
        path: "analysis.ipynb",
        cellIndex: 0,
        mode: "insert",
        source: "# Setup\n",
        cellType: "markdown",
      }),
      makeCtx(ws),
    );
    let parsed = JSON.parse(read(file)) as { cells: Array<{ cell_type: string; source: string[] }> };
    expect(parsed.cells).toHaveLength(4);
    expect(parsed.cells[0]).toMatchObject({ cell_type: "markdown", source: ["# Setup\n"] });

    await dispatcher.execute(
      call("notebook_edit", { path: "analysis.ipynb", cellIndex: 0, mode: "delete" }),
      makeCtx(ws),
    );
    parsed = JSON.parse(read(file)) as { cells: Array<{ cell_type: string; source: string[] }> };
    expect(parsed.cells).toHaveLength(3);
    expect(parsed.cells[0]?.cell_type).toBe("markdown");
    expect(parsed.cells[0]?.source).toEqual(NOTEBOOK.cells[0]!.source);
  });

  it("shows the cell's diff for approval, not the notebook's JSON", async () => {
    const { ws } = notebookWorkspace();
    const requests: PermissionRequest[] = [];
    const res = await dispatcher.execute(
      call("notebook_edit", { path: "analysis.ipynb", cellIndex: 2, mode: "replace", source: "df['present']\n" }),
      makeCtx(ws, {
        policy: { approvalMode: "confirm" },
        confirm: async (req) => {
          requests.push(req);
          return true;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(requests[0]?.preview?.path).toBe("analysis.ipynb#cell2");
    expect(requests[0]?.preview?.diff).toContain("-df['missing']");
    expect(requests[0]?.preview?.diff).toContain("+df['present']");
    // Not the raw JSON.
    expect(requests[0]?.preview?.diff).not.toContain("nbformat");
  });

  it("refuses a cell index the notebook does not have", async () => {
    const { ws, file, raw } = notebookWorkspace();
    const res = await dispatcher.execute(
      call("notebook_edit", { path: "analysis.ipynb", cellIndex: 9, mode: "replace", source: "x" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("cell_not_found");
    expect(read(file)).toBe(raw);
  });

  it("requires a source for anything but a delete", async () => {
    const { ws } = notebookWorkspace();
    const res = await dispatcher.execute(
      call("notebook_edit", { path: "analysis.ipynb", cellIndex: 0, mode: "replace" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalid_args");
  });

  it("checkpoints the file before writing, so a rewind can undo it", async () => {
    const { ws, raw } = notebookWorkspace();
    const checkpoints: Array<{ path: string; before: string | null }> = [];
    await dispatcher.execute(
      call("notebook_edit", { path: "analysis.ipynb", cellIndex: 0, mode: "delete" }),
      makeCtx(ws, { checkpoint: (p, before) => checkpoints.push({ path: p, before }) }),
    );
    expect(checkpoints).toEqual([{ path: "analysis.ipynb", before: raw }]);
  });
});
