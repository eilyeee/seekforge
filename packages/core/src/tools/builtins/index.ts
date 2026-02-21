import type { ToolSpec } from "../registry.js";
import { fsTools } from "./fs.js";
import { commandTools } from "./command.js";
import { gitTools } from "./git.js";
import { projectTools } from "./project.js";

export function builtinTools(): ToolSpec[] {
  return [...fsTools, ...commandTools, ...gitTools, ...projectTools];
}
