import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveProjectMcpServer,
  formatMcpServerDefinition,
  listPendingProjectMcpServers,
  listProjectMcpServers,
  mcpServerDigest,
  projectMcpApprovalsPath,
  projectMcpServerStatus,
  rejectProjectMcpServer,
  resetProjectMcpChoices,
} from "../../src/mcp/approvals.js";

let home: string;
let workspace: string;
const previousHome = process.env.SEEKFORGE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seekforge-approvals-home-"));
  workspace = mkdtempSync(join(tmpdir(), "seekforge-approvals-ws-"));
  process.env.SEEKFORGE_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const server = { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "${TOKEN}" } };

describe("mcpServerDigest", () => {
  it("ignores key order and the trust flag, and sees every other field", () => {
    const reordered = { env: { TOKEN: "${TOKEN}" }, args: ["-y", "pkg"], command: "npx", trusted: true };
    expect(mcpServerDigest(reordered)).toBe(mcpServerDigest(server));
    expect(mcpServerDigest({ ...server, args: ["-y", "other"] })).not.toBe(mcpServerDigest(server));
    expect(mcpServerDigest({ ...server, env: { TOKEN: "${OTHER}" } })).not.toBe(mcpServerDigest(server));
    expect(mcpServerDigest({ ...server, somethingNew: 1 })).not.toBe(mcpServerDigest(server));
  });

  it("formats the unexpanded definition for review", () => {
    expect(formatMcpServerDefinition({ ...server, trusted: true })).toBe(
      JSON.stringify({ args: ["-y", "pkg"], command: "npx", env: { TOKEN: "${TOKEN}" } }, null, 2),
    );
  });
});

describe("project approvals", () => {
  it("records a decision against the exact definition", () => {
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("pending");
    approveProjectMcpServer(workspace, "fs", server);
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("approved");
    expect(projectMcpServerStatus(workspace, "fs", { ...server, args: ["-y", "evil"] })).toBe("pending");
    expect(projectMcpServerStatus(workspace, "other", server)).toBe("pending");
    rejectProjectMcpServer(workspace, "fs", server);
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("rejected");
  });

  it("is keyed by the real workspace path, not its spelling", () => {
    const link = join(home, "link");
    symlinkSync(workspace, link);
    approveProjectMcpServer(link, "fs", server);
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("approved");
    expect(projectMcpServerStatus(`${workspace}/`, "fs", server)).toBe("approved");
    const elsewhere = mkdtempSync(join(tmpdir(), "seekforge-approvals-other-"));
    try {
      expect(projectMcpServerStatus(elsewhere, "fs", server)).toBe("pending");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("resets one workspace without touching another", () => {
    const other = mkdtempSync(join(tmpdir(), "seekforge-approvals-other-"));
    try {
      approveProjectMcpServer(workspace, "a", server);
      rejectProjectMcpServer(workspace, "b", server);
      approveProjectMcpServer(other, "a", server);
      expect(resetProjectMcpChoices(workspace)).toBe(2);
      expect(projectMcpServerStatus(workspace, "a", server)).toBe("pending");
      expect(projectMcpServerStatus(other, "a", server)).toBe("approved");
      expect(resetProjectMcpChoices(workspace)).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("lists repository servers with their standing and skips the user's own", () => {
    approveProjectMcpServer(workspace, "approved", server);
    rejectProjectMcpServer(workspace, "rejected", server);
    const servers = {
      approved: server,
      rejected: server,
      pending: server,
      mine: server,
      bad: { type: "websocket", url: "wss://x" },
    };
    const origins = {
      approved: "repository",
      rejected: "repository",
      pending: "repository",
      mine: "user",
      bad: "repository",
    } as const;
    expect(
      listProjectMcpServers(workspace, servers, origins).map(({ name, status, transport }) => ({
        name,
        status,
        transport,
      })),
    ).toEqual([
      { name: "approved", status: "approved", transport: "stdio" },
      { name: "rejected", status: "rejected", transport: "stdio" },
      { name: "pending", status: "pending", transport: "stdio" },
      { name: "bad", status: "pending", transport: "invalid" },
    ]);
    expect(listPendingProjectMcpServers(workspace, servers, origins).map((entry) => entry.name)).toEqual([
      "pending",
      "bad",
    ]);
  });

  it("stores decisions owner-only and fails closed on a corrupt or forged store", () => {
    approveProjectMcpServer(workspace, "fs", server);
    const path = projectMcpApprovalsPath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain(mcpServerDigest(server));

    writeFileSync(path, "{ not json");
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("pending");

    const store = (record: Record<string, unknown>) =>
      writeFileSync(path, JSON.stringify({ version: 1, workspaces: { [realpathSync(workspace)]: { fs: record } } }));
    const decidedAt = new Date().toISOString();
    store({ digest: mcpServerDigest(server), decision: "approved", decidedAt });
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("approved");
    store({ digest: "not-a-digest", decision: "approved", decidedAt });
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("pending");
    store({ digest: mcpServerDigest(server), decision: "approved", decidedAt, trusted: true });
    expect(projectMcpServerStatus(workspace, "fs", server)).toBe("pending");
  });

  it("keeps a server named __proto__ as data", () => {
    approveProjectMcpServer(workspace, "__proto__", server);
    expect(projectMcpServerStatus(workspace, "__proto__", server)).toBe("approved");
    expect(projectMcpServerStatus(workspace, "constructor", server)).toBe("pending");
  });

  it("refuses an empty name", () => {
    mkdirSync(join(home, ".seekforge"), { recursive: true });
    expect(() => approveProjectMcpServer(workspace, "", server)).toThrow(RangeError);
  });
});
