import { describe, expect, it } from "vitest";
import { isNearTranscriptEnd } from "./chat-scroll";

describe("isNearTranscriptEnd", () => {
  it("follows at the end and within the live-output threshold", () => {
    expect(isNearTranscriptEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isNearTranscriptEnd({ scrollTop: 604, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
  });

  it("stops following when the reader has opened older transcript content", () => {
    expect(isNearTranscriptEnd({ scrollTop: 603, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
  });

  it("fails closed for malformed measurements", () => {
    expect(isNearTranscriptEnd({ scrollTop: Number.NaN, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    expect(isNearTranscriptEnd({ scrollTop: -1, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
  });
});
