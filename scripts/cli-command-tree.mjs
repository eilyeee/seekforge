// Independent oracle for what the CLI actually registers.
//
// The drift gates learn the CLI surface by grepping sources. That is the same
// method that produced three blind spots in a row, so it cannot also be its own
// cross-check: a registrar the grep never reads is missing from both sides of
// any comparison the grep derives. This probe asks commander instead.
//
// It patches `Command.prototype.parseAsync` before importing the real entry
// point, so `apps/cli/src/index.ts` builds the whole program exactly as it does
// for a user and then hands it here instead of parsing argv. Commander is a
// singleton in the module graph, so the patch is seen by every registrar the
// entry point pulls in — including any that no static list knows about.
//
// Prints one JSON object on stdout: {commands, subcommands, options, optionSites}.
// Run it under tsx: `tsx scripts/cli-command-tree.mjs`.

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const entry = process.argv[2] ?? resolve(import.meta.dirname, "..", "apps", "cli", "src", "index.ts");

// pnpm's node_modules are strict: `commander` is a dependency of apps/cli, not
// of the workspace root, so this file cannot name it in a static import. It is
// resolved from the entry point's own package and imported by real path, which
// is the same URL Node will hand the entry point — one module instance, one
// prototype to patch.
const { Command } = await import(pathToFileURL(createRequire(entry).resolve("commander")).href);

/** Walk a commander tree into `{path: [names]}` plus the flat option set. */
function collect(program) {
  const commands = new Set();
  const aliases = new Set();
  const subcommands = new Map();
  const options = new Set();
  // One row per (long flag, command) registration, so a gate can say *where* a
  // flag lives and can tell a flag this repository registers from one commander
  // generates for every program it builds. `options` alone could say neither.
  const sites = [];
  const addOptions = (cmd, path) => {
    for (const option of cmd.options ?? []) {
      // `.version()` registers `-V, --version` itself; commander remembers it by
      // attribute name. Reading that back is how "commander's own option" stays
      // a derived fact instead of a `--version` literal in a gate's ignore list.
      let builtin = false;
      try {
        builtin = cmd._versionOptionName !== undefined && option.attributeName() === cmd._versionOptionName;
      } catch {
        builtin = false;
      }
      for (const flag of String(option.flags ?? "").matchAll(/--([a-z][a-z0-9-]*)/g)) {
        options.add(flag[1]);
        sites.push({
          name: flag[1],
          command: path.join(" "),
          flags: String(option.flags ?? ""),
          description: String(option.description ?? ""),
          // An option commander hides from `--help` is not advertised to users.
          hidden: option.hidden === true,
          builtin,
        });
      }
    }
  };
  addOptions(program, []);
  const walk = (cmd, path) => {
    for (const child of cmd.commands ?? []) {
      const name = child.name();
      if (path.length === 0) commands.add(name);
      else {
        const key = path.join(" ");
        if (!subcommands.has(key)) subcommands.set(key, new Set());
        subcommands.get(key).add(name);
      }
      // Aliases are kept apart from names. `plugins` and `upgrade` are
      // synonyms for `plugin` and `update`, and a gate that demanded a
      // documentation row for each would be asking for the same command to be
      // written up twice.
      for (const alias of child.aliases?.() ?? [])
        aliases.add(path.length === 0 ? alias : `${path.join(" ")} ${alias}`);
      addOptions(child, [...path, name]);
      walk(child, [...path, name]);
    }
  };
  walk(program, []);
  return {
    commands: [...commands].sort(),
    aliases: [...aliases].sort(),
    subcommands: Object.fromEntries([...subcommands].map(([key, set]) => [key, [...set].sort()]).sort()),
    options: [...options].sort(),
    optionSites: sites.sort((a, b) => a.name.localeCompare(b.name) || a.command.localeCompare(b.command)),
  };
}

let dumped = false;
const emit = (program) => {
  if (dumped) return;
  dumped = true;
  process.stdout.write(`\n__CLI_COMMAND_TREE__${JSON.stringify(collect(program))}\n`);
};

// The entry point ends in `program.parseAsync()`; intercepting it is what turns
// a CLI run into an introspection run. `parse` is patched too so a future entry
// point that calls the sync form is not silently missed.
Command.prototype.parseAsync = async function patched() {
  emit(this);
  process.exit(0);
};
Command.prototype.parse = function patched() {
  emit(this);
  process.exit(0);
};

await import(pathToFileURL(entry).href);

// The entry point imported cleanly but never parsed — that is a real change in
// how the CLI boots, and reporting nothing would let the cross-check pass
// vacuously.
if (!dumped) {
  process.stderr.write(`${entry} did not call parse()/parseAsync(); the command-tree probe saw no program\n`);
  process.exit(3);
}
