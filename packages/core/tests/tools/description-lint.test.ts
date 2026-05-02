import { describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";

/**
 * Lint for model-facing tool descriptions: the description is the only thing
 * the model sees when choosing tools, so every advertised tool must teach its
 * usage tersely. Guards against future regressions (empty/bloated descriptions
 * or descriptions that never name the argument the model must fill in).
 */

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: string[];
};

const MAX_DESCRIPTION_CHARS = 600;

const defs = createDefaultDispatcher().list();

describe("tool description lint", () => {
  it("advertises at least the builtin tools", () => {
    expect(defs.length).toBeGreaterThan(0);
  });

  for (const def of defs) {
    describe(def.name, () => {
      it("has a non-empty description", () => {
        expect(def.description.trim().length).toBeGreaterThan(0);
      });

      it(`stays under ${MAX_DESCRIPTION_CHARS} chars`, () => {
        expect(def.description.length).toBeLessThan(MAX_DESCRIPTION_CHARS);
      });

      it("mentions its primary argument by name", () => {
        const params = def.parameters as JsonSchemaObject;
        const propNames = Object.keys(params.properties ?? {});
        if (propNames.length === 0) return; // zero-arg tool: nothing to mention
        const primary = params.required?.[0] ?? propNames[0]!;
        expect(def.description).toContain(primary);
      });
    });
  }
});
