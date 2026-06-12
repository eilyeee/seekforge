/**
 * /init — the canned task dispatched to the agent to bootstrap or refresh
 * the repository's AGENTS.md.
 */

/** Task prompt sent verbatim when the user runs /init. */
export const INIT_PROMPT = `Explore this repository and create or update AGENTS.md at the repo root.

First, understand the codebase:
- Read the manifest files (package.json, Cargo.toml, pyproject.toml, etc.), top-level README, and directory layout to identify the tech stack, package manager, and workspace structure.
- Find the exact commands for installing dependencies, building, running tests (including a single test file), linting, and type checking — verify them against scripts/config rather than guessing.
- Note conventions that are non-obvious from a single file: module system, formatting rules, naming patterns, test layout, important entry points.

Then write AGENTS.md:
- If AGENTS.md already exists, UPDATE it in place: keep its existing structure and headings, correct anything stale, and preserve all user-written rules and notes verbatim.
- Keep it concise and factual — only what an agent needs to work effectively here. No placeholders, no boilerplate, no restating things obvious from file names.
- Include: a one-paragraph project overview, the verified commands, architecture/layout notes, and code style conventions.`;
