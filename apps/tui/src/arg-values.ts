/**
 * Pure candidate builders for slash-command arguments. The app gathers an
 * ArgContext lazily when the argument picker opens, asks argCandidates() for
 * the FULL candidate list, and fuzzy-filters it separately (fuzzy.ts). An
 * empty `value` means "run the command without an argument"; the app
 * interprets it. No fs, no side effects.
 */

export type ArgCandidate = { value: string; hint?: string };

/** Data the app gathers lazily when the picker opens. */
export type ArgContext = {
  sessions: Array<{ id: string; title: string; status: string }>;
  todos: Array<{ index: number; text: string; done: boolean }>;
  bgTasks: Array<{ id: string; command: string; status: string }>;
  models: Array<{ id: string; note: string }>;
  memoryFactCount: number;
  /** Files under .seekforge/memory/ offered by "/memory edit ". */
  memoryFiles?: string[];
};

/** Caps `text` to `max` characters, ellipsizing when it overflows. */
function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const TODO_VERBS: readonly ArgCandidate[] = [
  { value: "add", hint: "add a new todo" },
  { value: "done", hint: "mark a todo done" },
  { value: "rm", hint: "remove a todo" },
];

function todoCandidates(argSoFar: string, ctx: ArgContext): ArgCandidate[] {
  if (argSoFar.startsWith("done ")) {
    return ctx.todos
      .filter((t) => !t.done)
      .map((t) => ({ value: `done ${t.index}`, hint: `☐ ${cap(t.text, 40)}` }));
  }
  if (argSoFar.startsWith("rm ")) {
    return ctx.todos.map((t) => ({
      value: `rm ${t.index}`,
      hint: `${t.done ? "☑" : "☐"} ${cap(t.text, 40)}`,
    }));
  }
  // Empty or a verb prefix ("a", "do", "r"…): offer the verbs.
  return [...TODO_VERBS];
}

function tasksCandidates(argSoFar: string, ctx: ArgContext): ArgCandidate[] {
  if (argSoFar.startsWith("kill")) {
    return ctx.bgTasks
      .filter((t) => t.status === "running")
      .map((t) => ({ value: `kill ${t.id}`, hint: cap(t.command, 40) }));
  }
  return [
    { value: "", hint: "list" },
    { value: "kill", hint: "stop one" },
  ];
}

/**
 * Candidates for `command`'s argument given the prefix typed so far (the app
 * fuzzy-filters separately — this returns the FULL list, unfiltered).
 * Null = this command has no completable argument.
 */
export function argCandidates(command: string, argSoFar: string, ctx: ArgContext): ArgCandidate[] | null {
  switch (command) {
    case "resume":
      return ctx.sessions.map((s) => ({
        value: s.id,
        hint: `[${s.status}] ${cap(s.title, 40)}`,
      }));
    case "approve":
      return [
        { value: "auto", hint: "edits and safe commands run without asking" },
        { value: "confirm", hint: "ask before every edit or command" },
        { value: "plan", hint: "read-only planning, no changes" },
      ];
    case "think":
      return [
        { value: "on", hint: "enable thinking mode" },
        { value: "off", hint: "disable thinking mode" },
        { value: "high", hint: "thinking with high reasoning effort" },
        { value: "max", hint: "thinking with maximum reasoning effort" },
      ];
    case "model":
      return ctx.models.map((m) => ({ value: m.id, hint: m.note }));
    case "rewind":
      return [
        { value: "", hint: "dry-run preview" },
        { value: "yes", hint: "apply" },
      ];
    case "memory":
      if (argSoFar.startsWith("edit ")) {
        return (ctx.memoryFiles ?? []).map((f) => ({ value: `edit ${f}`, hint: "open in $EDITOR" }));
      }
      return [
        { value: "", hint: `list ${ctx.memoryFactCount} facts` },
        { value: "edit", hint: "open in $EDITOR" },
      ];
    case "config":
      return [
        { value: "", hint: "show settings" },
        { value: "edit", hint: "open in $EDITOR" },
      ];
    case "todo":
      return todoCandidates(argSoFar, ctx);
    case "tasks":
      return tasksCandidates(argSoFar, ctx);
    case "export":
      return [{ value: "", hint: "default path" }];
    default:
      return null;
  }
}
