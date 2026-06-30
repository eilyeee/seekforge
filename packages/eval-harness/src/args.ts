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
      case "--task":
        args.taskId = argv[++i];
        break;
      case "--baseline":
        args.baseline = argv[++i];
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--variant":
        args.variants.push(argv[++i] ?? "");
        break;
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
