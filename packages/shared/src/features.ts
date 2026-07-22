export const SEEKFORGE_PROTOCOL_VERSION = 1;

/** One manifest drives both the health response and the WS hello capability list. */
export const SERVER_FEATURES = [
  { id: "runs.v1", status: "stable" },
  { id: "runs.cancel", status: "stable" },
  { id: "runs.background", status: "stable" },
  { id: "runs.background-disconnect-continues", status: "stable" },
  { id: "runs.retention", status: "stable" },
  { id: "runs.worktree-isolation", status: "stable" },
  { id: "ws.replay", status: "stable" },
  { id: "ws.disconnect-cancels", status: "stable" },
  { id: "metrics.v1", status: "stable" },
] as const;

export type ServerFeatureId = (typeof SERVER_FEATURES)[number]["id"];
export const SERVER_CAPABILITIES: readonly ServerFeatureId[] = SERVER_FEATURES.map((feature) => feature.id);
