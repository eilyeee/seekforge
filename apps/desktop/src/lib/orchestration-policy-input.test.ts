import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, setTokenProvider, setWorkspaceProvider } from "./api";
import {
  EMPTY_ORCHESTRATION_POLICY_DRAFT,
  orchestrationPolicyChanged,
  orchestrationPolicyDraft,
  orchestrationPolicySaveVersion,
  parseOrchestrationPolicyInput,
} from "./orchestration-policy-input";

afterEach(() => {
  setWorkspaceProvider(() => "");
  setTokenProvider(() => "");
  vi.restoreAllMocks();
});

const policyState = {
  version: 1 as const,
  policy: { maxP95DurationMs: 120_000, maxCostUsd: 1.5, maxFailureRate: 0.2, minForecastCoverage: 0.8 },
  evaluationWindow: 50,
  maxBreachRate: 0.1,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("orchestrationPolicyDraft", () => {
  it("prefills from the policy the breach verdict was computed against", () => {
    expect(orchestrationPolicyDraft(policyState)).toEqual({
      maxP95DurationMs: "120000",
      maxCostUsd: "1.5",
      maxFailureRate: "0.2",
      minForecastCoverage: "0.8",
      evaluationWindow: "50",
      maxBreachRate: "0.1",
    });
  });

  it("is empty when no policy is stored, and tracks whether an edit changed anything", () => {
    expect(orchestrationPolicyDraft(undefined)).toEqual(EMPTY_ORCHESTRATION_POLICY_DRAFT);
    expect(orchestrationPolicyChanged(orchestrationPolicyDraft(policyState), policyState)).toBe(false);
    expect(orchestrationPolicyChanged({ ...orchestrationPolicyDraft(policyState), maxCostUsd: "2" }, policyState)).toBe(
      true,
    );
    // A partially-filled first policy is a change; an all-blank one is not.
    expect(orchestrationPolicyChanged(EMPTY_ORCHESTRATION_POLICY_DRAFT, undefined)).toBe(false);
    expect(orchestrationPolicyChanged({ ...EMPTY_ORCHESTRATION_POLICY_DRAFT, maxCostUsd: "2" }, undefined)).toBe(true);
  });
});

describe("orchestrationPolicySaveVersion", () => {
  const draft = EMPTY_ORCHESTRATION_POLICY_DRAFT;

  it("checks the save against the version the fields were filled from", () => {
    // A report reload during an edit must not re-point the token at the newer
    // document: that is exactly how a concurrent edit gets silently overwritten.
    const reloaded = { ...policyState, updatedAt: "2026-02-02T00:00:00.000Z" };
    expect(orchestrationPolicySaveVersion({ draft, baseUpdatedAt: policyState.updatedAt }, reloaded)).toEqual({
      expectedUpdatedAt: policyState.updatedAt,
    });
  });

  it("uses the current policy when nothing has been typed yet", () => {
    expect(orchestrationPolicySaveVersion(undefined, policyState)).toEqual({
      expectedUpdatedAt: policyState.updatedAt,
    });
    expect(orchestrationPolicySaveVersion(undefined, undefined)).toEqual({});
  });

  it("refuses a first write once someone else created the policy mid-edit", () => {
    // The route can only say "expect this version", never "expect none", so the
    // only non-destructive answer is to stop here.
    expect(orchestrationPolicySaveVersion({ draft }, policyState)).toEqual({ conflict: true });
    expect(orchestrationPolicySaveVersion({ draft }, undefined)).toEqual({});
  });
});

describe("parseOrchestrationPolicyInput", () => {
  it("omits blank fields so the stored value is kept", () => {
    expect(parseOrchestrationPolicyInput({ ...EMPTY_ORCHESTRATION_POLICY_DRAFT, maxCostUsd: " 2.5 " })).toEqual({
      maxCostUsd: 2.5,
    });
  });

  it("carries the loaded policy version so a concurrent edit is not overwritten", () => {
    expect(parseOrchestrationPolicyInput(EMPTY_ORCHESTRATION_POLICY_DRAFT, policyState.updatedAt)).toEqual({
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  /**
   * The bounds belong to the route and to core. Clamping or dropping an
   * out-of-range value here would silently accept an edit the server refuses —
   * the exact second rule set this decoder exists to avoid.
   */
  it("passes values the server will reject through unchanged instead of fixing them", () => {
    expect(
      parseOrchestrationPolicyInput({
        maxP95DurationMs: "0",
        maxCostUsd: "-1",
        maxFailureRate: "5",
        minForecastCoverage: "-0.5",
        evaluationWindow: "1000.5",
        maxBreachRate: "2",
      }),
    ).toEqual({
      maxP95DurationMs: 0,
      maxCostUsd: -1,
      maxFailureRate: 5,
      minForecastCoverage: -0.5,
      evaluationWindow: 1000.5,
      maxBreachRate: 2,
    });
  });

  /** What JSON cannot carry cannot reach the route as typed, so it is named here. */
  it("refuses text that is not a finite number", () => {
    for (const text of ["abc", "Infinity", "1,5", "--2"]) {
      expect(() => parseOrchestrationPolicyInput({ ...EMPTY_ORCHESTRATION_POLICY_DRAFT, maxCostUsd: text })).toThrow(
        /maxCostUsd must be a number/,
      );
    }
  });
});

describe("api.orchestrationPolicySet", () => {
  it("PUTs the workspace-scoped policy route with the values as typed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );

    await api.orchestrationPolicySet(
      parseOrchestrationPolicyInput({ ...EMPTY_ORCHESTRATION_POLICY_DRAFT, maxCostUsd: "-1" }, policyState.updatedAt),
      "ws-a",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/orchestration/policy?ws=ws-a");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ maxCostUsd: -1, expectedUpdatedAt: policyState.updatedAt });
  });

  it("surfaces the route's own rejection rather than a client-side verdict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "bad_request", message: "orchestration policy values are invalid" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );

    await expect(api.orchestrationPolicySet({ maxCostUsd: -1 })).rejects.toMatchObject({
      code: "bad_request",
      message: "orchestration policy values are invalid",
      status: 400,
    });
    await expect(api.orchestrationPolicySet({ maxCostUsd: -1 })).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces the stale-policy conflict instead of overwriting a concurrent edit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "busy", message: "Orchestration SLO policy changed since it was read" } }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(
      api.orchestrationPolicySet({ maxCostUsd: 2, expectedUpdatedAt: policyState.updatedAt }),
    ).rejects.toMatchObject({ status: 409, message: "Orchestration SLO policy changed since it was read" });
  });
});
