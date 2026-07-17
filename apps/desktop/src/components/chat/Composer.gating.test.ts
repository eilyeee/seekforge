import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../../lib/i18n";
import { Composer } from "./Composer";

setLocale("en");

const baseProps = {
  onChange: () => {},
  onSend: () => {},
  disabled: false,
  placeholder: "ask",
  commands: [],
  workspaceId: "",
};

describe("Composer send gating", () => {
  it("disables the send button and shows the hint while sending is blocked", () => {
    const hint = "Connection lost — you can send once reconnected";
    const html = renderToStaticMarkup(
      createElement(Composer, { ...baseProps, value: "hello", sendBlocked: true, sendBlockedHint: hint }),
    );
    expect(html).toContain(hint);
    // Only the send button is disabled (input + pills stay enabled so the draft
    // is preserved and can still be edited while reconnecting).
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(1);
  });

  it("enables the send button when connected with a non-empty draft", () => {
    const html = renderToStaticMarkup(createElement(Composer, { ...baseProps, value: "hello" }));
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(0);
  });
});
