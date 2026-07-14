import type { Command } from "commander";
import {
  skillCreateCommand,
  skillDisableCommand,
  skillEnableCommand,
  skillImportCommand,
  skillListCommand,
  skillRemoveCommand,
  skillShowCommand,
} from "./skill.js";

export function registerSkillCommands(program: Command): void {
  const skill = program.command("skill").description("manage skills (procedure libraries)");
  skill
    .command("list", { isDefault: true })
    .description("list available skills (project > global > builtin)")
    .action(() => {
      skillListCommand();
    });
  skill
    .command("show")
    .argument("<skill-id>")
    .description("print a skill's metadata and SKILL.md")
    .action((id: string) => {
      skillShowCommand(id);
    });
  skill
    .command("create")
    .argument("<skill-id>", "lowercase letters, digits, dashes")
    .description("scaffold a project skill in .seekforge/skills/<id>/")
    .action((id: string) => {
      skillCreateCommand(id);
    });
  skill
    .command("import")
    .argument("<path>", "SKILL.md file (or its directory) with YAML frontmatter (Claude-style)")
    .option("-g, --global", "import into ~/.seekforge/skills (all projects) instead of this project")
    .option("-f, --force", "replace an existing skill with the same id")
    .description("import an external skill (e.g. Claude Code / Meta_Kim format)")
    .action((sourcePath: string, opts: { global?: boolean; force?: boolean }) => {
      skillImportCommand(sourcePath, opts);
    });
  skill
    .command("enable")
    .argument("<skill-id>")
    .option("-g, --global", "act on ~/.seekforge/skills instead of this project")
    .description("enable a skill (removes a disable marker for a builtin)")
    .action((id: string, opts: { global?: boolean }) => {
      skillEnableCommand(id, opts);
    });
  skill
    .command("disable")
    .argument("<skill-id>")
    .option("-g, --global", "act on ~/.seekforge/skills instead of this project")
    .description("disable a skill (writes a disable marker for a builtin)")
    .action((id: string, opts: { global?: boolean }) => {
      skillDisableCommand(id, opts);
    });
  skill
    .command("remove")
    .argument("<skill-id>")
    .option("-g, --global", "act on ~/.seekforge/skills instead of this project")
    .description("delete a project/global skill dir (builtins must be disabled, not removed)")
    .action((id: string, opts: { global?: boolean }) => {
      skillRemoveCommand(id, opts);
    });
}
