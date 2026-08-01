function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const CONTROL_PLANE_SCENARIO_EXAMPLE = JSON.stringify(
  [
    {
      id: "provider-recovery-week",
      observations: [
        {
          day: 1,
          fault: "provider-timeout",
          baseline: { recovered: false, recoveryMs: 180_000, costUsd: 0.18 },
          controlled: { recovered: true, recoveryMs: 72_000, costUsd: 0.12 },
        },
        {
          day: 2,
          fault: "stale-route",
          baseline: { recovered: true, recoveryMs: 240_000, costUsd: 0.24 },
          controlled: { recovered: true, recoveryMs: 95_000, costUsd: 0.15 },
        },
      ],
    },
  ],
  null,
  2,
);

/** Decodes the Desktop text field; Eval Harness remains the semantic validator. */
export function parseControlPlaneScenarioInput(text: string): unknown[] {
  if (text.length > 256 * 1024) throw new Error("Control-plane scenario JSON is too large");
  const parsed = JSON.parse(text) as unknown;
  const scenarios = Array.isArray(parsed) ? parsed : record(parsed) ? parsed.scenarios : undefined;
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 32) {
    throw new Error("Control-plane input must contain 1-32 scenarios");
  }
  for (let index = 0; index < scenarios.length; index++) {
    if (!Object.hasOwn(scenarios, index)) throw new Error("Control-plane scenarios must be a dense array");
  }
  return scenarios;
}
