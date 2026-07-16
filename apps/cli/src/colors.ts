// Central color/ANSI gating + a consistent error helper for the CLI.
//
// Why one module: previously every file hardcoded `\x1b[32m` and emitted it
// unconditionally, so piped output, NO_COLOR users, and the machine output
// formats (--output-format json|stream-json / --json) all got raw escape
// bytes. Here we gate ALL ANSI behind a single predicate and expose tiny
// `green()/red()/dim()/…` helpers that return the plain string when color is
// off. Callers can either rely on the module default (`setColorEnabled` is
// called once at startup) or pass an explicit `color` flag where the mode is
// known per run (e.g. the renderer in a json run).

const CODES = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
} as const;
const RESET = "\x1b[0m";

type ColorName = keyof typeof CODES;

/**
 * Decides whether ANSI color should be emitted. Color is ON only when ALL of:
 *  - stdout is an interactive TTY (so piped/redirected output is plain);
 *  - NO_COLOR is unset (https://no-color.org);
 *  - we are not in a machine output mode (json / stream-json / --json), where
 *    even a TTY must stay byte-clean for the consumer.
 *
 * Inputs are injectable so the logic is unit-testable without touching the
 * real process.
 */
export function useColor(opts: { isTTY?: boolean; noColor?: boolean; machine?: boolean } = {}): boolean {
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const noColor = opts.noColor ?? Boolean(process.env.NO_COLOR);
  const machine = opts.machine ?? false;
  return isTTY && !noColor && !machine;
}

// Module-level default, resolved once at startup (see setColorEnabled). Starts
// from the environment so helpers behave sanely even before wiring runs.
let colorEnabled = useColor();

/** Set the process-wide default used by the bare color helpers. */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

/** Current process-wide color default (exposed for tests/diagnostics). */
export function colorIsEnabled(): boolean {
  return colorEnabled;
}

/** Wrap `s` in an ANSI code (+ reset) when color is on; otherwise return `s`. */
function paint(name: ColorName, s: string, enabled: boolean): string {
  return enabled ? `${CODES[name]}${s}${RESET}` : s;
}

// Bare helpers use the module default. Pass `enabled` to force a decision
// (e.g. a renderer created for a json run threads its own `color: false`).
export const green = (s: string, enabled = colorEnabled): string => paint("green", s, enabled);
export const red = (s: string, enabled = colorEnabled): string => paint("red", s, enabled);
export const yellow = (s: string, enabled = colorEnabled): string => paint("yellow", s, enabled);
export const dim = (s: string, enabled = colorEnabled): string => paint("dim", s, enabled);
export const italic = (s: string, enabled = colorEnabled): string => paint("italic", s, enabled);

/** dim+italic, used for streamed reasoning ("thinking") output. */
export const dimItalic = (s: string, enabled = colorEnabled): string =>
  enabled ? `${CODES.dim}${CODES.italic}${s}${RESET}` : s;

/**
 * A color factory bound to a fixed `enabled` decision. Handy where the mode is
 * known once (the renderer) so call sites read `c.green(x)` without threading
 * the flag through every call.
 */
export type Colorizer = {
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
  italic: (s: string) => string;
  dimItalic: (s: string) => string;
  enabled: boolean;
};

export function makeColorizer(enabled: boolean): Colorizer {
  return {
    green: (s) => paint("green", s, enabled),
    red: (s) => paint("red", s, enabled),
    yellow: (s) => paint("yellow", s, enabled),
    dim: (s) => paint("dim", s, enabled),
    italic: (s) => paint("italic", s, enabled),
    dimItalic: (s) => (enabled ? `${CODES.dim}${CODES.italic}${s}${RESET}` : s),
    enabled,
  };
}

/**
 * Format an error message the one consistent way: `error: <message>`, with an
 * optional `→ <hint>` line. Returns the string(s) so it is unit-testable; use
 * `fail()` to also print to stderr and set the exit code.
 */
export function formatError(message: string, hint?: string): string {
  const head = `error: ${message}`;
  return hint ? `${head}\n  → ${hint}` : head;
}

/**
 * Print a standardized error to STDERR (never stdout — so it can't corrupt
 * --output-format json) and set a non-zero exit code. Does not throw; callers
 * `return` after it. Color is applied to the "error:"/hint chrome only when the
 * module default permits (off in machine mode / NO_COLOR / non-TTY); the
 * message text itself is left untouched.
 */
export function fail(message: string, opts: { hint?: string; code?: number } = {}): void {
  const head = `${red("error:")} ${message}`;
  process.stderr.write(`${head}\n`);
  if (opts.hint) process.stderr.write(`${dim(`  → ${opts.hint}`)}\n`);
  process.exitCode = opts.code ?? 1;
}
