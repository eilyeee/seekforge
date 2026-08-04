import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { readUtf8FileBoundedSync } from "../../util/fs.js";
import { loadSkills } from "../../skills/load.js";

/**
 * Reading the rest of a skill.
 *
 * A selected skill reaches the model as a brief: its description plus as much
 * of the procedure as fits a shared budget, cut mid-sentence when it does not.
 * Until now that was the end of it — the truncated half was unreachable, so a
 * procedure longer than a paragraph could not be followed, and nothing told the
 * model it was working from an excerpt.
 *
 * This is the second level of that disclosure: the brief says what a skill is
 * for and the model reads the rest when it decides the skill applies. It is
 * also what makes a skill able to SHIP something — a checklist, a template, a
 * script — instead of only describing it.
 */

/** A skill definition is already bounded at load; this bounds what one read returns. */
const MAX_SKILL_READ_BYTES = 256 * 1024;
/** Bundled files are listed, not walked: a skill directory is small by design. */
const MAX_LISTED_FILES = 100;

const readSkillSchema = z.object({
  id: z.string().describe("Skill id, exactly as it appears in the injected skill brief."),
  file: z
    .string()
    .optional()
    .describe("A file bundled with the skill (relative to its directory). Omit for the full SKILL.md."),
});

/**
 * Resolve a path inside the skill's own directory.
 *
 * A skill can come from the repository, so its files are as untrusted as any
 * other repo content: `../../.ssh/id_rsa` is a plausible thing for a
 * repo-provided skill to name, and a symlink out of the directory is the same
 * request wearing a different hat. Both are resolved and rejected here rather
 * than trusted because the id looked familiar.
 */
function resolveInsideSkill(dir: string, relative: string): string {
  const root = fs.realpathSync(dir);
  const target = path.resolve(root, relative);
  const real = fs.existsSync(target) ? fs.realpathSync(target) : target;
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ToolError("outside_skill", `${relative} is outside the skill directory`);
  }
  return real;
}

const readSkill = defineTool({
  name: "read_skill",
  description:
    "Read the full SKILL.md of the skill with this `id` — the complete procedure, not the excerpt injected into your prompt, which is truncated when it does not fit. " +
    "Pass `file` to read something the skill ships beside it (a checklist, template or script). Call this when a skill's brief looks relevant and you need the steps it did not have room for. Read-only.",
  schema: readSkillSchema,
  classify: (args) => ({
    permission: "readonly",
    description: args.file ? `Read skill ${args.id} file ${args.file}` : `Read skill ${args.id}`,
  }),
  async run(args, ctx) {
    const skill = loadSkills(ctx.workspace).find((candidate) => candidate.id === args.id);
    if (!skill) {
      throw new ToolError("skill_not_found", `No skill with id "${args.id}" is available in this workspace`);
    }
    if (args.file === undefined) {
      return {
        data: {
          id: skill.id,
          name: skill.name,
          risk: skill.risk,
          content: skill.content,
          // What else it ships, so a procedure can point at its own template
          // without the model having to guess a filename.
          files: listBundledFiles(skill.dir),
        },
      };
    }
    if (!skill.dir) {
      throw new ToolError("no_skill_files", `Skill "${args.id}" is built in and ships no files`);
    }
    const resolved = resolveInsideSkill(skill.dir, args.file);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ToolError("not_found", `${args.file} is not a file in skill ${args.id}`);
    }
    return {
      data: {
        id: skill.id,
        file: args.file,
        content: readUtf8FileBoundedSync(resolved, MAX_SKILL_READ_BYTES),
      },
    };
  },
});

/** Files beside SKILL.md, so the model can see what a skill brought with it. */
function listBundledFiles(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "SKILL.md" && entry.name !== "skill.json")
      .slice(0, MAX_LISTED_FILES)
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export const skillTools: ToolSpec[] = [readSkill];
