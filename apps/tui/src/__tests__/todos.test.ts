import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireSessionLease, SessionBusyError } from "@seekforge/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTodo, formatTodoLines, loadTodos, removeTodo, toggleTodo } from "../todos.js";

let workspace: string;

function todosPath(): string {
  return path.join(workspace, ".seekforge", "todos.md");
}

function writeFile(content: string): void {
  fs.mkdirSync(path.dirname(todosPath()), { recursive: true });
  fs.writeFileSync(todosPath(), content, "utf8");
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-todos-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("loadTodos", () => {
  it("returns [] when the file is missing", () => {
    expect(loadTodos(workspace)).toEqual([]);
  });

  it("parses checklist lines with 1-based indices, skipping prose", () => {
    writeFile("# Plan\n\n- [ ] first\nsome prose\n- [x] second\n");
    expect(loadTodos(workspace)).toEqual([
      { index: 1, text: "first", done: false },
      { index: 2, text: "second", done: true },
    ]);
  });
});

describe("addTodo", () => {
  it("creates .seekforge/ and appends, returning the new item", () => {
    const todo = addTodo(workspace, "write tests");
    expect(todo).toEqual({ index: 1, text: "write tests", done: false });
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("- [ ] write tests\n");
    expect(addTodo(workspace, "second").index).toBe(2);
  });

  it("preserves prose lines when appending", () => {
    writeFile("# Plan\nintro prose\n- [ ] a\n");
    addTodo(workspace, "b");
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("# Plan\nintro prose\n- [ ] a\n- [ ] b\n");
  });

  it("does not follow a symlinked todo file outside the workspace", () => {
    const outside = path.join(workspace, "..", `${path.basename(workspace)}-outside.md`);
    fs.mkdirSync(path.dirname(todosPath()), { recursive: true });
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, todosPath());
    try {
      expect(() => addTodo(workspace, "must stay inside")).toThrow(/regular file/);
      expect(fs.readFileSync(outside, "utf8")).toBe("outside\n");
      expect(loadTodos(workspace)).toEqual([]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("rejects mutation while another session owns the workspace", () => {
    const lease = acquireSessionLease(workspace, "active-session");
    try {
      expect(() => addTodo(workspace, "racing write")).toThrow(SessionBusyError);
    } finally {
      lease.release();
    }
  });
});

describe("toggleTodo", () => {
  it("flips [ ] to [x] and back, counting checklist lines only", () => {
    writeFile("# Plan\n- [ ] a\nprose\n- [x] b\n");
    expect(toggleTodo(workspace, 2)).toEqual({ index: 2, text: "b", done: false });
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("# Plan\n- [ ] a\nprose\n- [ ] b\n");
    expect(toggleTodo(workspace, 1)).toEqual({ index: 1, text: "a", done: true });
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("# Plan\n- [x] a\nprose\n- [ ] b\n");
  });

  it("returns null when out of range", () => {
    writeFile("- [ ] only\n");
    expect(toggleTodo(workspace, 0)).toBeNull();
    expect(toggleTodo(workspace, 2)).toBeNull();
    expect(toggleTodo(workspace, 1)).not.toBeNull();
  });

  it("returns null when the file is missing", () => {
    expect(toggleTodo(workspace, 1)).toBeNull();
  });
});

describe("removeTodo", () => {
  it("removes only the checklist line, preserving surrounding prose", () => {
    writeFile("# Plan\n- [ ] a\nprose between\n- [x] b\ntrailing prose\n");
    expect(removeTodo(workspace, 2)).toEqual({ index: 2, text: "b", done: true });
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("# Plan\n- [ ] a\nprose between\ntrailing prose\n");
  });

  it("returns null when out of range", () => {
    writeFile("- [ ] only\n");
    expect(removeTodo(workspace, 5)).toBeNull();
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("- [ ] only\n");
  });
});

describe("round-trips", () => {
  it("preserves non-checklist lines untouched across add/toggle/remove", () => {
    writeFile("# Heading\n\nfree text\n- [ ] one\n> quote\n");
    addTodo(workspace, "two");
    toggleTodo(workspace, 1);
    removeTodo(workspace, 2);
    toggleTodo(workspace, 1);
    expect(fs.readFileSync(todosPath(), "utf8")).toBe("# Heading\n\nfree text\n- [ ] one\n> quote\n");
  });
});

describe("formatTodoLines", () => {
  it("formats with box symbols", () => {
    expect(
      formatTodoLines([
        { index: 1, text: "open", done: false },
        { index: 2, text: "closed", done: true },
      ]),
    ).toEqual(["1. ☐ open", "2. ☑ closed"]);
  });

  it("has an empty-state hint", () => {
    expect(formatTodoLines([])).toEqual(["no todos — /todo add <text>"]);
  });
});
