import type { ToolSpec } from "../registry.js";
import { fsTools } from "./fs.js";
import { globTools } from "./glob.js";
import { commandTools } from "./command.js";
import { gitTools } from "./git.js";
import { projectTools } from "./project.js";
import { planTools } from "./plan.js";
import { webTools } from "./web.js";
import { askTools } from "./ask.js";
import { visionTools } from "./vision.js";
import { memoryTools } from "./memory.js";
import { commandInvokeTools } from "./command-invoke.js";

export { configureVision, type VisionConfig } from "./vision.js";

export function builtinTools(): ToolSpec[] {
  return [...fsTools, ...globTools, ...commandTools, ...gitTools, ...projectTools, ...planTools, ...webTools, ...askTools, ...visionTools, ...memoryTools, ...commandInvokeTools];
}
