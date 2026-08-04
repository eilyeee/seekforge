import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { buildSkillBrief } from "../../src/skills/brief.js";
import { loadSkills } from "../../src/skills/load.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * A selected skill reaches the model as an excerpt, cut mid-sentence when it
 * does not fit a shared budget. Until this tool existed the other half was
 * unreachable and nothing said it had been cut — so a procedure longer than a
 * paragraph could not be followed, and the model did not know why.
 */

// Longer than the whole brief budget, so it is truncated even when it is the
// only skill selected — the case the marker has to survive.
const LONG_PROCEDURE = [
  "# Deploy",
  "",
  "## Procedure",
  ...Array.from({ length: 200 }, (_, i) => `${i + 1}. step ${i} of the deployment procedure`),
]
  .join("\n")
  .concat("\nfinal step: tag the release\n");

function writeSkill(workspace: string, id: string, content: string, files: Record<string, string> = {}): string {
  const dir = path.join(workspace, ".seekforge", "skills", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({ apiVersion: 1, id, name: id, description: `about ${id}`, tags: [], triggers: [id] }),
  );
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

describe("read_skill", () => {
  it("returns the whole procedure the brief could only excerpt", async () => {
    const ws = makeWorkspace();
    writeSkill(ws, "deploy", LONG_PROCEDURE);
    const skill = loadSkills(ws).find((candidate) => candidate.id === "deploy")!;
    const brief = buildSkillBrief([{ skill, score: 1, reason: "test" }])!;
    // The brief is an excerpt, and it now says so in a way the model can act on.
    expect(brief).toContain("truncated");
    expect(brief).toContain('read_skill("deploy")');
    expect(brief).not.toContain("tag the release");

    const res = await createDefaultDispatcher().execute(call("read_skill", { id: "deploy" }), makeCtx(ws));
    expect(res.ok).toBe(true);
    expect((res.data as { content: string }).content).toContain("tag the release");
  });

  it("lists and reads what a skill ships beside its definition", async () => {
    const ws = makeWorkspace();
    writeSkill(ws, "review", "# Review\n\n## Procedure\nFollow checklist.md.\n", {
      "checklist.md": "- [ ] does it handle the empty case\n",
    });
    const dispatcher = createDefaultDispatcher();

    const listed = await dispatcher.execute(call("read_skill", { id: "review" }), makeCtx(ws));
    // A procedure can point at its own template without the model guessing a
    // filename — which is what lets a skill ship something rather than only
    // describe it.
    expect((listed.data as { files: string[] }).files).toEqual(["checklist.md"]);

    const file = await dispatcher.execute(call("read_skill", { id: "review", file: "checklist.md" }), makeCtx(ws));
    expect((file.data as { content: string }).content).toContain("empty case");
  });

  it("refuses a path that leaves the skill's own directory", async () => {
    // A skill can come from the repository, so its file names are as untrusted
    // as any other repo content.
    const ws = makeWorkspace();
    writeSkill(ws, "sneaky", "# S\n");
    fs.writeFileSync(path.join(ws, "secret.txt"), "not yours");

    const res = await createDefaultDispatcher().execute(
      call("read_skill", { id: "sneaky", file: "../../../secret.txt" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_skill");
  });

  it("refuses a symlink out of the skill directory", async () => {
    const ws = makeWorkspace();
    const dir = writeSkill(ws, "linky", "# L\n");
    fs.writeFileSync(path.join(ws, "outside.txt"), "not yours");
    fs.symlinkSync(path.join(ws, "outside.txt"), path.join(dir, "inside.txt"));

    const res = await createDefaultDispatcher().execute(
      call("read_skill", { id: "linky", file: "inside.txt" }),
      makeCtx(ws),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("outside_skill");
  });

  it("says which skill is missing rather than failing vaguely", async () => {
    const res = await createDefaultDispatcher().execute(call("read_skill", { id: "nope" }), makeCtx(makeWorkspace()));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("skill_not_found");
  });

  it("is read-only, so reading a procedure never needs approval", async () => {
    const ws = makeWorkspace();
    writeSkill(ws, "deploy", LONG_PROCEDURE);
    const dispatcher = createDefaultDispatcher();
    const spec = dispatcher.list().find((tool) => tool.name === "read_skill");
    expect(spec).toBeDefined();
    const denied = await dispatcher.execute(call("read_skill", { id: "deploy" }), {
      ...makeCtx(ws),
      confirm: async () => false,
    });
    expect(denied.ok).toBe(true);
  });
});
