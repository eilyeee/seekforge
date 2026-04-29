import { afterEach, describe, expect, it } from "vitest";
import { STRINGS, TIP_COUNT, detectLocale, getLocale, setLocale, t } from "../strings.js";
import { keyHints, pickTip } from "../render-helpers.js";

afterEach(() => setLocale("en"));

describe("detectLocale", () => {
  it("defaults to en with an empty environment", () => {
    expect(detectLocale({})).toBe("en");
  });

  it("picks zh-CN from LANG / LC_ALL zh prefixes", () => {
    expect(detectLocale({ LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
    expect(detectLocale({ LC_ALL: "zh_CN.UTF-8" })).toBe("zh-CN");
    expect(detectLocale({ LANG: "zh-TW" })).toBe("zh-CN");
    expect(detectLocale({ LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("lets SEEKFORGE_LANG override LANG/LC_ALL in both directions", () => {
    expect(detectLocale({ SEEKFORGE_LANG: "zh-CN", LANG: "en_US.UTF-8" })).toBe("zh-CN");
    expect(detectLocale({ SEEKFORGE_LANG: "en", LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN" })).toBe("en");
  });

  it("ignores an empty SEEKFORGE_LANG", () => {
    expect(detectLocale({ SEEKFORGE_LANG: "", LANG: "zh_CN.UTF-8" })).toBe("zh-CN");
  });
});

describe("t / setLocale", () => {
  it("returns the English value by default", () => {
    expect(t("status.ready")).toBe("ready");
    expect(t("hints.idle")).toBe("⏎ send · / commands · @ files · Ctrl+R history");
  });

  it("switches to zh-CN and back", () => {
    setLocale("zh-CN");
    expect(getLocale()).toBe("zh-CN");
    expect(t("status.ready")).toBe("就绪");
    setLocale("en");
    expect(t("status.ready")).toBe("ready");
  });

  it("returns the key itself for a missing key (never throws)", () => {
    expect(t("no.such.key")).toBe("no.such.key");
    setLocale("zh-CN");
    expect(t("no.such.key")).toBe("no.such.key");
  });
});

describe("STRINGS tables", () => {
  it("zh-CN covers exactly the same keys as en", () => {
    expect(Object.keys(STRINGS["zh-CN"]).sort()).toEqual(Object.keys(STRINGS.en).sort());
  });

  it("has TIP_COUNT tips in each locale", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      for (let i = 0; i < TIP_COUNT; i += 1) {
        expect(STRINGS[locale][`tips.${i}`]).toBeTruthy();
      }
      expect(STRINGS[locale][`tips.${TIP_COUNT}`]).toBeUndefined();
    }
  });

  it("keeps strings single-line", () => {
    for (const table of Object.values(STRINGS)) {
      for (const value of Object.values(table)) expect(value).not.toContain("\n");
    }
  });
});

describe("locale-aware UI helpers", () => {
  it("keyHints localizes with the active locale", () => {
    setLocale("zh-CN");
    expect(keyHints("permission")).toBe("y 允许 · a 本会话允许 · n 拒绝");
    setLocale("en");
    expect(keyHints("permission")).toBe("y allow · a allow session · n deny");
  });

  it("pickTip localizes with the active locale", () => {
    expect(pickTip(0)).toBe("Type @ to attach files to your message");
    setLocale("zh-CN");
    expect(pickTip(0)).toBe("输入 @ 将文件附加到消息");
  });
});
