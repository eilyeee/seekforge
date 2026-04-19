/**
 * Launch-flag parsing for the seekforge-tui binary. Pure and dependency-free:
 * index.tsx passes process.argv.slice(2) and acts on the result (print help,
 * resume the last session, force vim mode, pick a model).
 */

export type TuiArgs = {
  /** -c / --continue: resume the most recent session of this project. */
  continueLast: boolean;
  /** --vim / --no-vim override the config's vim setting; absent = use config. */
  vim?: boolean;
  /** --model <name> or --model=<name>. */
  model?: string;
  /** -h / --help: print TUI_HELP and exit. */
  help: boolean;
};

/** Parses TUI launch flags. Unknown flags are ignored; argv excludes node+script. */
export function parseTuiArgs(argv: readonly string[]): TuiArgs {
  const args: TuiArgs = { continueLast: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-c" || arg === "--continue") {
      args.continueLast = true;
    } else if (arg === "--vim") {
      args.vim = true;
    } else if (arg === "--no-vim") {
      args.vim = false;
    } else if (arg === "--model") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        args.model = next;
        i++;
      }
    } else if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length);
      if (value !== "") args.model = value;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    }
    // Anything else is ignored so future flags don't break older scripts.
  }
  return args;
}

/** Short usage text printed for -h/--help. */
export const TUI_HELP = `Usage: seekforge-tui [options]

Options:
  -c, --continue      resume the most recent session of this project
  --vim / --no-vim    start the composer in (or out of) vim mode
  --model <name>      model for the session (e.g. deepseek-chat)
  -h, --help          show this help and exit
`;
