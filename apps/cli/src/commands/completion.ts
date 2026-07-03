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
  "sandbox-run",
  "ask",
  "init",
  "diff",
  "schedule",
  "sessions",
  "status",
  "models",
  "resume",
  "replay",
  "audit",
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

/** Flags offered for the `seekforge run` subcommand (keep in sync with index.ts). */
const RUN_FLAGS = [
  "-y",
  "--yes",
  "-m",
  "--model",
  "--output-format",
  "--json",
  "-c",
  "--continue",
  "--resume",
  "--add-dir",
  "--max-turns",
  "--verbose",
  "--system-prompt",
  "--append-system-prompt",
  "--allowedTools",
  "--disallowedTools",
  "--permission-mode",
  "--fallback-model",
  "--output-style",
  "--plan",
] as const;

const BASH_SCRIPT = `# bash completion for seekforge — source <(seekforge completion bash)
_seekforge() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if (( COMP_CWORD == 1 )); then
    COMPREPLY=($(compgen -W "${WORDS}" -- "$cur"))
  elif (( COMP_CWORD >= 2 )) && [[ "\${COMP_WORDS[1]}" == "run" ]]; then
    COMPREPLY=($(compgen -W "${RUN_FLAGS.join(" ")}" -- "$cur"))
  fi
}
complete -F _seekforge seekforge
`;

const ZSH_SCRIPT = `#compdef seekforge
# zsh completion for seekforge — seekforge completion zsh > _seekforge (in your fpath)
_seekforge() {
  local -a commands
  commands=(${[...COMMANDS, "--help"].map((w) => `"${w}"`).join(" ")})
  if (( CURRENT == 2 )); then
    compadd -- $commands
  elif (( CURRENT >= 3 )) && [[ \${words[2]} == "run" ]]; then
    local -a run_flags
    run_flags=(${RUN_FLAGS.map((f) => `"${f}"`).join(" ")})
    compadd -- $run_flags
  fi
}
compdef _seekforge seekforge
`;

import { t } from "../i18n.js";

export function completionCommand(shell: string): void {
  if (shell === "bash") {
    process.stdout.write(BASH_SCRIPT);
  } else if (shell === "zsh") {
    process.stdout.write(ZSH_SCRIPT);
  } else {
    console.error(t("cmd.completion.unsupportedShell", { shell }));
    process.exitCode = 1;
  }
}
