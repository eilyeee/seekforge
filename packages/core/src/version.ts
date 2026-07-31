/**
 * The single source of the SeekForge version inside Core.
 *
 * Core is not published, so it has no package version of its own to read, yet
 * it still announces a version on the wire (MCP client and server info). Those
 * literals used to drift — the MCP server still claimed 0.7.0 and the client
 * 0.3.0 — so they now share this constant, which `scripts/release.mjs` bumps
 * with every other versioned file and `scripts/surface-drift.test.mjs` pins to
 * the published CLI version.
 */
export const SEEKFORGE_VERSION = "1.0.0";
