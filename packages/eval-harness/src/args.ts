/**
 * CLI argument parsing for the eval harness, split out from cli.ts so it can be
 * unit-tested without importing cli.ts (whose module body invokes main()).
 */

export type CliArgs = {
  taskId?: string;
  baseline?: string;
  keep: boolean;
  variants: string[];
  ab?: [string, string];
  skillRanking: boolean;
  listVariants: boolean;
  failOnRegression: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    keep: false,
    variants: [],
    skillRanking: false,
    listVariants: false,
    failOnRegression: false,
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
        if (val === undefined) throw new Error("--task requires a task id");
        args.taskId = val;
        break;
      }
      case "--baseline": {
        const val = argv[++i];
        if (val === undefined) throw new Error("--baseline requires a file path");
        args.baseline = val;
        break;
      }
      case "--keep":
        args.keep = true;
        break;
      case "--variant": {
        const val = argv[++i];
        if (val === undefined) throw new Error("--variant requires a name");
        args.variants.push(val);
        break;
      }
      case "--ab": {
        const pair = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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
      case "--list-variants":
        args.listVariants = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}
