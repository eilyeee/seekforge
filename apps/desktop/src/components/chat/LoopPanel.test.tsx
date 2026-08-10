import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { setLocale } from "../../lib/i18n";
import type { LoopProgress } from "../../lib/loop";
import { LoopPanel } from "./LoopPanel";

setLocale("en");

const noop = (): void => undefined;

function render(progress: LoopProgress): string {
  return renderToStaticMarkup(
    createElement(LoopPanel, {
      progress,
      running: false,
      loopRunning: false,
      onRun: noop,
      onResume: noop,
      onStop: noop,
      onPause: noop,
      onContinue: noop,
      onSteer: noop,
    }),
  );
}

const empty: LoopProgress = { events: [], result: null, requirements: null, acceptanceReview: null };

describe("LoopPanel layout", () => {
  /**
   * A Loop appends a row per iteration and this panel sits above the
   * conversation in a fixed-height flex column, so unbounded growth pushed the
   * composer clean out of the viewport — measured at 856px below the fold with
   * 60 iterations. These classes are the fix; deleting one brings the bug back
   * and nothing else in the suite would notice.
   */
  it("bounds its own height and scrolls instead of displacing the composer", () => {
    const markup = render(empty);
    const root = markup.slice(0, markup.indexOf(">") + 1);
    expect(root).toContain("max-h-[45vh]");
    // Without min-h-0 + overflow-hidden the panel cannot shrink below its
    // content, so a short window pushes the composer out even under the cap.
    expect(root).toContain("min-h-0");
    expect(root).toContain("overflow-hidden");
    expect(root).toContain("flex-col");
  });

  it("keeps the collapsed header visible and never shrinks it away", () => {
    expect(render(empty)).toContain("shrink-0");
  });
});
