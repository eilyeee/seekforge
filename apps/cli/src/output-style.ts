// Output styles now live in @seekforge/core so the server/desktop share them.
// This module re-exports the CLI-facing surface for backward compatibility.

export {
  OUTPUT_STYLES,
  isOutputStyle,
  outputStylePrompt,
  loadCustomOutputStyle,
  resolveOutputStyle,
  listOutputStyles,
  type OutputStyle,
  type OutputStyleInfo,
} from "@seekforge/core";
