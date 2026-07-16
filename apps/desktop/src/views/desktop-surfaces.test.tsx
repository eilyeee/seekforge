import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n";
import type { McpServer } from "../types";
import { TeamPlanDialog } from "./AgentsView";
import { SecurityView } from "./SecurityView";
import { McpEditorDialog } from "./SettingsView";

setLocale("en");

describe("Desktop operational surfaces", () => {
  it("renders masked OAuth refresh credentials as password fields", () => {
    const initial: McpServer = {
      name: "secure-http",
      transport: "http",
      url: "https://mcp.example.test/rpc",
      args: [],
      env: {},
      headers: { Authorization: "********" },
      oauth: {
        tokenEndpoint: "https://auth.example.test/token",
        clientId: "desktop-client",
        clientSecret: "********",
        refreshToken: "********",
        scope: "mcp.read",
      },
      trusted: false,
      source: "project",
      shadowedGlobal: false,
    };
    const html = renderToStaticMarkup(
      createElement(McpEditorDialog, {
        initial,
        ws: "workspace-1",
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(html).toContain("OAuth refresh token");
    expect(html).toContain("OAuth client secret");
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('value="********"');
    expect(html).not.toContain("refresh-secret");
    expect(html).not.toContain("client-secret");
  });

  it("renders the Security Center scan and threat-model controls", () => {
    const html = renderToStaticMarkup(createElement(SecurityView));
    expect(html).toContain("Security Center");
    expect(html).toContain("Scan repository");
    expect(html).toContain("Build threat model");
    expect(html).toContain("Reports");
  });

  it("renders team plan submission controls for concurrency and dependencies", () => {
    const html = renderToStaticMarkup(
      createElement(TeamPlanDialog, {
        agents: [
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Reviews changes",
            triggers: [],
            mode: "ask",
            scope: "builtin",
          },
        ],
        onClose: () => {},
        onSubmit: () => {},
      }),
    );
    expect(html).toContain("Run agent team");
    expect(html).toContain("Max concurrency");
    expect(html).toContain("Depends on member IDs");
    expect(html).toContain("Run team");
  });
});
