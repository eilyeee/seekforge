import { describe, expect, it } from "vitest";
import {
  decodeDesktopGraphTemplates,
  graphTemplateDefaultParameters,
  graphTemplateVisualDefinition,
} from "./graph-template-ui";

const template = {
  schemaVersion: 2,
  kind: "engineering-graph-template",
  templateId: "release",
  version: "1.0.0",
  parameters: {},
  definition: { graphId: "release", nodes: [{ id: "start", kind: "function", handler: "noop" }] },
};

describe("desktop Graph template adapter", () => {
  it("unwraps registry records and retains the semantic template payload", () => {
    const decoded = decodeDesktopGraphTemplates([{ template, registeredAt: "2026-07-31T00:00:00.000Z" }]);
    expect(decoded).toMatchObject({ templates: [{ key: "release@1.0.0", template }], skipped: 0 });
    expect(graphTemplateVisualDefinition(decoded.templates[0]!.template)).toEqual(template.definition);
  });

  it("skips malformed and sparse registry records", () => {
    const input = new Array(3);
    input[1] = { template: null, registeredAt: "bad" };
    input[2] = { template, registeredAt: "2026-07-31T00:00:00.000Z", deprecatedAt: "bad" };
    expect(decodeDesktopGraphTemplates(input)).toEqual({ templates: [], skipped: 3 });
    expect(decodeDesktopGraphTemplates(null)).toEqual({ templates: [], skipped: 1 });
  });

  it("keeps the first record when transport identities collide", () => {
    const first = { template, registeredAt: "2026-07-31T00:00:00.000Z" };
    const duplicate = { template: { ...template }, registeredAt: "2026-07-31T01:00:00.000Z" };
    expect(decodeDesktopGraphTemplates([first, duplicate])).toMatchObject({
      templates: [{ key: "release@1.0.0" }],
      skipped: 1,
    });
  });

  it("extracts only supported template defaults into a null-prototype parameter map", () => {
    const defaults = graphTemplateDefaultParameters({
      parameters: {
        channel: { type: "string", default: "stable" },
        retries: { type: "number", default: 2 },
        required: { type: "boolean" },
        invalid: { default: Number.NaN },
      },
    });
    expect(defaults).toEqual({ channel: "stable", retries: 2 });
    expect(Object.getPrototypeOf(defaults)).toBeNull();
  });
});
