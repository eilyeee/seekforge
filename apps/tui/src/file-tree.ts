/**
 * Pure workspace file-tree model for the sidebar (à la DeepSeek-TUI
 * file_tree). Built once from the scanWorkspaceFiles flat path list —
 * directories are derived, not re-scanned — and flattened collapse-aware at
 * render time. All functions are pure so expansion/cursor behavior is
 * testable without touching the filesystem.
 */

export type TreeNode = {
  /** Workspace-relative path with "/" separators (no trailing slash). */
  path: string;
  /** Last path segment. */
  name: string;
  dir: boolean;
  /** 0 for top-level entries. */
  depth: number;
};

export type TreeState = {
  /** Full tree in depth-first order (every node, expanded or not). */
  nodes: TreeNode[];
  /** Directory paths currently expanded. */
  expanded: Set<string>;
  /** Index into visibleNodes(nodes, expanded). */
  cursor: number;
};

type Level = {
  dirs: Map<string, Level>;
  files: string[];
};

function newLevel(): Level {
  return { dirs: new Map(), files: [] };
}

/** Case-insensitive alpha with a case-sensitive tiebreak for stability. */
function alpha(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds the full tree from workspace-relative file paths (as produced by
 * scanWorkspaceFiles). Directories are derived from the paths; each level is
 * sorted directories-first, then alphabetically within each group.
 */
export function buildTree(files: readonly string[]): TreeNode[] {
  const root = newLevel();
  for (const file of files) {
    const parts = file.split("/").filter((p) => p !== "");
    if (parts.length === 0) continue;
    let level = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = level.dirs.get(part);
      if (!child) {
        child = newLevel();
        level.dirs.set(part, child);
      }
      level = child;
    }
    level.files.push(parts[parts.length - 1] as string);
  }

  const out: TreeNode[] = [];
  const emit = (level: Level, prefix: string, depth: number): void => {
    const dirNames = [...level.dirs.keys()].sort(alpha);
    for (const name of dirNames) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      out.push({ path, name, dir: true, depth });
      emit(level.dirs.get(name) as Level, path, depth + 1);
    }
    for (const name of [...level.files].sort(alpha)) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      out.push({ path, name, dir: false, depth });
    }
  };
  emit(root, "", 0);
  return out;
}

/**
 * Collapse-aware flatten: top-level nodes are always visible; children only
 * appear when every ancestor directory is in `expanded`.
 */
export function visibleNodes(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  let skipBelow: number | null = null; // hide nodes deeper than this depth
  for (const node of nodes) {
    if (skipBelow !== null) {
      if (node.depth > skipBelow) continue;
      skipBelow = null;
    }
    out.push(node);
    if (node.dir && !expanded.has(node.path)) skipBelow = node.depth;
  }
  return out;
}

function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, cursor));
}

/** Toggles a directory's expansion, keeping the cursor inside the visible list. */
export function toggleDir(state: TreeState, path: string): TreeState {
  const expanded = new Set(state.expanded);
  if (expanded.has(path)) expanded.delete(path);
  else expanded.add(path);
  const cursor = clampCursor(state.cursor, visibleNodes(state.nodes, expanded).length);
  return { nodes: state.nodes, expanded, cursor };
}

/** Moves the cursor over the VISIBLE nodes, clamped to both ends. */
export function moveCursor(state: TreeState, delta: number): TreeState {
  const count = visibleNodes(state.nodes, state.expanded).length;
  const cursor = clampCursor(state.cursor + delta, count);
  if (cursor === state.cursor) return state;
  return { ...state, cursor };
}
