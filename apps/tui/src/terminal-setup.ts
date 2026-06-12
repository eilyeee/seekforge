/**
 * /terminal-setup — instructions for making Shift+Enter insert a newline.
 *
 * Deliberately informational only: we print steps for the user to apply
 * themselves and never mutate another application's configuration. Editing
 * iTerm2/VS Code settings uninvited would be hostile, so we do not do it.
 */

/** Detects the host terminal from TERM_PROGRAM (defaults to process.env). */
export function detectTerminal(
  env: Record<string, string | undefined> = process.env,
): "iterm2" | "apple-terminal" | "vscode" | "unknown" {
  switch (env["TERM_PROGRAM"]) {
    case "iTerm.app":
      return "iterm2";
    case "Apple_Terminal":
      return "apple-terminal";
    case "vscode":
      return "vscode";
    default:
      return "unknown";
  }
}

/**
 * Concrete, copy-pasteable setup steps per terminal. Pure strings — this
 * never touches the terminal's own config files (see module JSDoc).
 */
export function terminalSetupInstructions(
  terminal: ReturnType<typeof detectTerminal>,
): string[] {
  switch (terminal) {
    case "iterm2":
      return [
        "iTerm2 detected — to make Shift+Enter insert a newline:",
        "  1. Open iTerm2 → Preferences → Keys → Key Bindings",
        "  2. Click + to add a binding, press Shift-Enter as the shortcut",
        '  3. Set Action to "Send Text" and the text to \\n',
        "Note: \\-Enter (backslash then Enter) and Ctrl+J already insert a newline without any setup.",
      ];
    case "vscode":
      return [
        "VS Code terminal detected — add this to keybindings.json (Cmd/Ctrl+Shift+P → \"Open Keyboard Shortcuts (JSON)\"):",
        "  {",
        '    "key": "shift+enter",',
        '    "command": "workbench.action.terminal.sendSequence",',
        '    "args": { "text": "\\n" },',
        '    "when": "terminalFocus"',
        "  }",
        "Note: \\-Enter (backslash then Enter) and Ctrl+J already insert a newline without any setup.",
      ];
    case "apple-terminal":
      return [
        "Apple Terminal does not support rebinding Shift+Enter.",
        "Use \\-Enter (backslash then Enter) or Ctrl+J to insert a newline instead.",
      ];
    default:
      return [
        "Unknown terminal — check its key-binding settings for a way to send \\n on Shift+Enter.",
        "Either way, \\-Enter (backslash then Enter) and Ctrl+J insert a newline in SeekForge.",
      ];
  }
}
