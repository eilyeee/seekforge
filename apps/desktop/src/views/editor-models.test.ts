import { describe, expect, it } from "vitest";
import {
  draftFromForm,
  emptyAgentForm,
  formFromDefinition,
  formFromSource,
  type AgentEditorForm,
} from "./agent-editor-model";
import { actionsForScope, formFromRule, ruleFromForm } from "./permission-rules-model";

describe("agent editor model", () => {
  const form = (patch: Partial<AgentEditorForm>): AgentEditorForm => ({
    ...emptyAgentForm(),
    id: "reviewer",
    ...patch,
  });

  it("round-trips a loaded definition, keeping extra frontmatter verbatim", () => {
    const source = {
      id: "keeper",
      scope: "global" as const,
      path: "/home/u/.seekforge/agents/keeper/AGENT.md",
      name: "Keeper",
      description: "Keeps",
      tools: ["read_file"],
      mode: "ask" as const,
      model: "deepseek-v4-pro",
      maxTurns: 8,
      body: "Body",
      extra: [{ key: "skills", value: "\n  - lint" }],
    };
    const loaded = formFromSource(source);
    expect(loaded).toMatchObject({ restrictTools: true, tools: "read_file", maxTurns: "8", scope: "global" });
    const { path: _path, id: _id, scope: _scope, ...draft } = source;
    expect(draftFromForm(loaded)).toEqual({ ok: true, draft });
  });

  it("maps 'every tool' to null and an empty restricted list to []", () => {
    expect(draftFromForm(form({ restrictTools: false, tools: "read_file" }))).toMatchObject({
      ok: true,
      draft: { tools: null },
    });
    expect(draftFromForm(form({ restrictTools: true, tools: " , " }))).toMatchObject({
      ok: true,
      draft: { tools: [] },
    });
    expect(draftFromForm(form({ restrictTools: true, tools: "a, b, a" }))).toMatchObject({
      ok: true,
      draft: { tools: ["a", "b"] },
    });
  });

  it("reports the first invalid field", () => {
    expect(draftFromForm(form({ id: "Bad Id" }))).toEqual({ ok: false, error: "id" });
    expect(draftFromForm(form({ maxTurns: "0" }))).toEqual({ ok: false, error: "maxTurns" });
    expect(draftFromForm(form({ restrictTools: true, tools: "a,b c" }))).toEqual({ ok: false, error: "tools" });
    expect(draftFromForm(form({ extra: [{ key: "1bad", value: "" }] }))).toEqual({ ok: false, error: "extraKey" });
    expect(draftFromForm(form({ extra: [{ key: "Mode", value: "ask" }] }))).toEqual({
      ok: false,
      error: "extraDuplicate",
    });
    expect(
      draftFromForm(
        form({
          extra: [
            { key: "color", value: "red" },
            { key: "COLOR", value: "blue" },
          ],
        }),
      ),
    ).toEqual({ ok: false, error: "extraDuplicate" });
    // A blank row is simply ignored.
    expect(draftFromForm(form({ extra: [{ key: " ", value: "x" }] }))).toMatchObject({
      ok: true,
      draft: { extra: [] },
    });
  });

  it("copies a builtin definition into a project form, prose fields as extras", () => {
    const copy = formFromDefinition({
      id: "reviewer",
      scope: "builtin",
      name: "Reviewer",
      description: "Reviews",
      triggers: ["review", "audit"],
      mode: "ask",
      own: "the review",
      boundary: 'never "edit"',
      body: "Look closely.",
    });
    expect(copy).toMatchObject({ scope: "project", id: "reviewer", restrictTools: false, body: "Look closely." });
    expect(copy.extra).toEqual([
      { key: "trigger", value: '"review | audit"' },
      { key: "own", value: '"the review"' },
      { key: "boundary", value: '"never \\"edit\\""' },
    ]);
  });
});

describe("permission rules model", () => {
  it("offers allow only in user scope", () => {
    expect(actionsForScope("project")).toEqual(["deny", "ask"]);
    expect(actionsForScope("user")).toEqual(["deny", "ask", "allow"]);
    expect(formFromRule(undefined, "project").action).toBe("deny");
  });

  it("builds a trimmed rule and refuses a blank tool or an allow in project scope", () => {
    expect(ruleFromForm({ action: "ask", tool: " web_fetch ", match: " GET https://docs " }, "project")).toEqual({
      ok: true,
      rule: { action: "ask", tool: "web_fetch", match: "GET https://docs" },
    });
    expect(ruleFromForm({ action: "deny", tool: "*", match: "  " }, "user")).toEqual({
      ok: true,
      rule: { action: "deny", tool: "*" },
    });
    expect(ruleFromForm({ action: "deny", tool: "  ", match: "" }, "user")).toEqual({ ok: false, error: "tool" });
    expect(ruleFromForm({ action: "allow", tool: "x", match: "" }, "project")).toEqual({ ok: false, error: "action" });
    expect(formFromRule({ action: "allow", tool: "run_command", match: "pnpm test" }, "user")).toEqual({
      action: "allow",
      tool: "run_command",
      match: "pnpm test",
    });
  });
});
