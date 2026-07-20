/**
 * CLI argument parsing for the eval harness, split out from cli.ts so it can be
 * unit-tested without importing cli.ts (whose module body invokes main()).
 */

export type CliArgs = {
  taskId?: string;
  suite?: string;
  repeat?: number;
  junit?: string;
  baseline?: string;
  keep: boolean;
  variants: string[];
  ab?: [string, string];
  skillRanking: boolean;
  listVariants: boolean;
  failOnRegression: boolean;
  requireApiKey: boolean;
};

export const MAX_REPEAT = 20;

function positiveInteger(raw: string | undefined, flag: string): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    throw new Error(`${flag} requires an integer from 1 to ${MAX_REPEAT}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REPEAT) {
    throw new Error(`${flag} requires an integer from 1 to ${MAX_REPEAT}`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    keep: false,
    variants: [],
    skillRanking: false,
    listVariants: false,
    failOnRegression: false,
    requireApiKey: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        // End-of-options separator. `pnpm … eval -- --flag` forwards a literal
        // `--` token before the flags; skip it and keep parsing (this CLI has
        // no positional args, so the flags after `--` are still options).
        break;
      case "--task": {
        const val = argv[++i];
        if (val === undefined || val.trim().length === 0) throw new Error("--task requires a task id");
        args.taskId = val;
        break;
      }
      case "--suite": {
        const val = argv[++i];
        if (val === undefined || val.trim().length === 0) throw new Error("--suite requires a name");
        args.suite = val;
        break;
      }
      case "--repeat":
        args.repeat = positiveInteger(argv[++i], "--repeat");
        break;
      case "--junit": {
        const val = argv[++i];
        if (val === undefined || val.trim().length === 0) throw new Error("--junit requires a file path");
        args.junit = val;
        break;
      }
      case "--baseline": {
        const val = argv[++i];
        if (val === undefined || val.trim().length === 0) throw new Error("--baseline requires a file path");
        args.baseline = val;
        break;
      }
      case "--keep":
        args.keep = true;
        break;
      case "--variant": {
        const val = argv[++i];
        if (val === undefined || val.trim().length === 0) throw new Error("--variant requires a name");
        args.variants.push(val);
        break;
      }
      case "--ab": {
        const pair = (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (pair.length !== 2) throw new Error("--ab expects exactly two comma-separated variant names");
        args.ab = [pair[0]!, pair[1]!];
        break;
      }
      case "--skill-ranking":
        args.skillRanking = true;
        break;
      case "--fail-on-regression":
        args.failOnRegression = true;
        break;
      case "--require-api-key":
        args.requireApiKey = true;
        break;
      case "--list-variants":
        args.listVariants = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.variants.length > 1) throw new Error("--variant may be specified only once; use --ab to compare variants");
  if (args.ab !== undefined && args.variants.length > 0) throw new Error("--variant cannot be combined with --ab");
  if (args.failOnRegression && args.baseline === undefined) {
    throw new Error("--fail-on-regression requires --baseline <file>");
  }
  return args;
}
