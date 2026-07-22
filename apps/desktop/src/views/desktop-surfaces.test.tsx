import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../lib/i18n";
import { Modal } from "../components/ui/Modal";
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

    expect(html).toContain("refresh token (masked after save)");
    expect(html).toContain("client secret (masked after save)");
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('value="********"');
    expect(html).not.toContain("actual-refresh-credential");
    expect(html).not.toContain("actual-client-credential");
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
    expect(html).toContain("Agent team plan");
    expect(html).toContain("max concurrency");
    expect(html).toContain("depends on");
    expect(html).toContain("Run team");
  });

  it("gives shared dialogs an accessible name and removes the backdrop from tab order", () => {
    const html = renderToStaticMarkup(
      createElement(
        Modal,
        { title: "Named dialog", onDismiss: () => {} },
        createElement("button", { type: "button" }, "Action"),
      ),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain('aria-label="Close dialog" tabindex="-1"');
  });
});
