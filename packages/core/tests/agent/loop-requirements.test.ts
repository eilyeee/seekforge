import { describe, expect, it } from "vitest";
import {
  fallbackLoopAcceptanceReview,
  parseLoopAcceptanceReview,
  parseLoopRequirementSpec,
} from "../../src/agent/loop-requirements.js";

const validSpec = {
  version: 1,
  goal: "Ship the complete feature",
  deliverables: ["Implementation", "Tests"],
  requirements: [{ id: "REQ-1", text: "Implement it", required: true }],
  constraints: [],
  outOfScope: [],
  assumptions: [],
  acceptanceCriteria: [{ id: "AC-1", text: "Tests and code prove it", requirementIds: ["REQ-1"] }],
  unresolvedQuestions: [],
} as const;

describe("loop requirement parsing", () => {
  it("accepts a fenced bounded specification", () => {
    expect(parseLoopRequirementSpec(`\`\`\`json\n${JSON.stringify(validSpec)}\n\`\`\``)).toEqual(validSpec);
  });

  it("rejects duplicate ids and uncovered required requirements", () => {
    expect(
      parseLoopRequirementSpec({
        ...validSpec,
        requirements: [...validSpec.requirements, { id: "REQ-1", text: "duplicate", required: true }],
      }),
    ).toBeNull();
    expect(parseLoopRequirementSpec({ ...validSpec, acceptanceCriteria: [] })).toBeNull();
    expect(
      parseLoopRequirementSpec({
        ...validSpec,
        requirements: validSpec.requirements.map((item) => ({ ...item, required: false })),
      }),
    ).toBeNull();
  });

  it("derives completion and rejects a model's inconsistent complete flag", () => {
    const spec = parseLoopRequirementSpec(validSpec)!;
    expect(
      parseLoopAcceptanceReview(
        { complete: true, criteria: [{ id: "AC-1", status: "unmet", evidence: [] }], gaps: ["missing"] },
        spec,
      ),
    ).toBeNull();
    expect(
      parseLoopAcceptanceReview(
        { complete: true, criteria: [{ id: "AC-1", status: "met", evidence: [] }], gaps: [] },
        spec,
      ),
    ).toBeNull();
    expect(
      parseLoopAcceptanceReview(
        { complete: true, criteria: [{ id: "AC-1", status: "met", evidence: ["src/a.ts"] }], gaps: [] },
        spec,
      )?.complete,
    ).toBe(true);
  });

  it("normalizes review criteria to the frozen specification order", () => {
    const spec = parseLoopRequirementSpec({
      ...validSpec,
      acceptanceCriteria: [
        validSpec.acceptanceCriteria[0],
        { id: "AC-2", text: "Documentation proves it", requirementIds: ["REQ-1"] },
      ],
    })!;
    const review = parseLoopAcceptanceReview(
      {
        complete: true,
        criteria: [
          { id: "AC-2", status: "met", evidence: ["docs/feature.md"] },
          { id: "AC-1", status: "met", evidence: ["src/feature.ts"] },
        ],
        gaps: [],
      },
      spec,
    );
    expect(review?.criteria.map((item) => item.id)).toEqual(["AC-1", "AC-2"]);
  });

  it("fails closed when review output is invalid", () => {
    const spec = parseLoopRequirementSpec(validSpec)!;
    expect(fallbackLoopAcceptanceReview(spec, "invalid")).toMatchObject({
      complete: false,
      criteria: [{ id: "AC-1", status: "unknown" }],
    });
  });
});
