import { describe, expect, it } from "vitest";
import { buildMcpServerDraft, recordOf, rowsOf } from "./mcp-editor-model";

describe("MCP editor model", () => {
  it("round-trips rows and rejects duplicate trimmed keys", () => {
    expect(rowsOf({ A: "1" })).toEqual([{ key: "A", value: "1" }]);
    expect(
      recordOf([
        { key: " A ", value: "1" },
        { key: "A", value: "2" },
      ]),
    ).toBeNull();
    expect(
      recordOf([
        { key: "", value: "ignored" },
        { key: "B", value: "2" },
      ]),
    ).toEqual({ B: "2" });
  });

  it("builds a trimmed HTTP OAuth draft without altering masked secrets", () => {
    expect(
      buildMcpServerDraft({
        name: " remote ",
        scope: "global",
        transport: "http",
        command: "",
        args: [],
        env: {},
        url: " https://mcp.example/rpc ",
        headers: { Authorization: "********" },
        oauthEnabled: true,
        tokenEndpoint: " https://auth.example/token ",
        clientId: " client ",
        clientSecret: "********",
        refreshToken: "********",
        oauthScope: " offline_access ",
        trusted: true,
        permission: "readonly",
        toolPermissions: { mutate: "dangerous" },
      }),
    ).toEqual({
      name: "remote",
      scope: "global",
      url: "https://mcp.example/rpc",
      headers: { Authorization: "********" },
      oauth: {
        tokenEndpoint: "https://auth.example/token",
        clientId: "client",
        clientSecret: "********",
        refreshToken: "********",
        scope: "offline_access",
      },
      trusted: true,
      permission: "readonly",
      toolPermissions: { mutate: "dangerous" },
    });
  });

  it("preserves explicit clear values for permission overrides", () => {
    expect(
      buildMcpServerDraft({
        name: "local",
        scope: "global",
        transport: "stdio",
        command: "node",
        args: [],
        env: {},
        url: "",
        headers: {},
        oauthEnabled: false,
        tokenEndpoint: "",
        clientId: "",
        clientSecret: "",
        refreshToken: "",
        oauthScope: "",
        trusted: true,
        permission: null,
        toolPermissions: {},
      }),
    ).toMatchObject({ permission: null, toolPermissions: {} });
  });
});
