/**
 * `seekforge completion bash|zsh` — prints a static shell completion script
 * covering the top-level commands. No dynamic completion: users pipe the
 * output into their rc file or completion directory.
 *
 *   bash: source <(seekforge completion bash)
 *   zsh:  seekforge completion zsh > ~/.zsh/completions/_seekforge
 */

/** Top-level commands registered in index.ts (keep in sync when adding commands). */
const COMMANDS = [
  "run",
  "ask",
  "init",
  "diff",
  "sessions",
  "status",
  "resume",
  "rewind",
  "serve",
  "skill",
  "agent",
  "mcp",
  "mcp-serve",
  "memory",
  "evolve",
  "config",
  "chat",
  "doctor",
  "update",
  "prune",
  "completion",
  "help",
] as const;

const WORDS = [...COMMANDS, "--help"].join(" ");

const BASH_SCRIPT = `# bash completion for seekforge — source <(seekforge completion bash)
complete -W "${WORDS}" seekforge
`;

const ZSH_SCRIPT = `#compdef seekforge
# zsh completion for seekforge — seekforge completion zsh > _seekforge (in your fpath)
_seekforge() {
  local -a commands
  commands=(${[...COMMANDS, "--help"].map((w) => `"${w}"`).join(" ")})
  if (( CURRENT == 2 )); then
    compadd -- $commands
  fi
}
compdef _seekforge seekforge
`;

export function completionCommand(shell: string): void {
  if (shell === "bash") {
    process.stdout.write(BASH_SCRIPT);
  } else if (shell === "zsh") {
    process.stdout.write(ZSH_SCRIPT);
  } else {
    console.error(`unsupported shell: ${shell} (expected bash or zsh)`);
    process.exitCode = 1;
  }
}
