import { describe, expect, it } from "vitest";
import { color256, TerminalScreen } from "./ansi";

const screen = (cols = 20, rows = 5) => new TerminalScreen(cols, rows, 50);

describe("TerminalScreen", () => {
  it("renders plain lines with CR/LF, backspace and tabs", () => {
    const s = screen();
    s.write("hello\r\nworld\b!\r\na\tb");
    expect(s.text()).toBe("hello\nworl!\na       b");
  });

  it("overwrites from column 0 after a bare carriage return", () => {
    const s = screen();
    s.write("progress 10%\rprogress 99%");
    expect(s.text()).toBe("progress 99%");
  });

  it("applies SGR colors and resets, merging equal styles into spans", () => {
    const s = screen();
    s.write("\u001b[31mred\u001b[0m plain \u001b[1;38;5;196mX\u001b[38;2;1;2;3mY\u001b[m");
    const [line] = s.snapshot();
    expect(line).toEqual([
      { text: "red", style: { fg: "ansi:1" } },
      { text: " plain ", style: {} },
      { text: "X", style: { bold: true, fg: "rgb(255,0,0)" } },
      { text: "Y", style: { bold: true, fg: "rgb(1,2,3)" } },
    ]);
  });

  it("keeps an escape split across writes", () => {
    const s = screen();
    s.write("a\u001b[3");
    s.write("2mb");
    expect(s.snapshot()[0]).toEqual([
      { text: "a", style: {} },
      { text: "b", style: { fg: "ansi:2" } },
    ]);
  });

  it("drops OSC titles and private modes, including the SeekForge tty marker", () => {
    const s = screen();
    s.write("\u001b]0;title\u0007\u001b[?2004h$ \u001b]1337;SeekForgeTty=/dev/ttys1\u001b\\ls");
    expect(s.text()).toBe("$ ls");
  });

  it("erases to end of line and moves the cursor", () => {
    const s = screen();
    s.write("abcdef\u001b[3D\u001b[K!\r\nxyz\u001b[1A\u001b[2Cq");
    expect(s.text()).toBe("abc! q\nxyz");
  });

  it("wraps long lines at the column limit", () => {
    const s = screen(4, 5);
    s.write("abcdefgh");
    expect(s.text()).toBe("abcd\nefgh");
  });

  it("positions absolutely within the visible screen and clears it into scrollback", () => {
    const s = screen(10, 3);
    s.write("one\r\ntwo\r\nthree\r\nfour");
    s.write("\u001b[1;1HX");
    expect(s.text()).toBe("one\nXwo\nthree\nfour");
    s.write("\u001b[H\u001b[2J$ ");
    expect(s.text().split("\n").at(-1)).toBe("$ ");
    expect(s.text()).toContain("four");
    s.write("\u001b[3J");
    expect(s.text()).toBe("$ ");
  });

  it("restores the main screen after an alternate-screen program", () => {
    const s = screen(10, 3);
    s.write("before\r\n");
    s.write("\u001b[?1049h\u001b[Hvim stuff");
    expect(s.text()).toContain("vim stuff");
    s.write("\u001b[?1049lafter");
    expect(s.text()).toBe("before\nafter");
  });

  it("saves and restores the cursor, inserts and deletes characters", () => {
    const s = screen();
    s.write("abc\u001b7def\u001b8X\u001b[2@\u001b[1P");
    expect(s.text()).toBe("abcX ef");
  });

  it("caps scrollback", () => {
    const s = new TerminalScreen(10, 3, 5);
    for (let i = 0; i < 20; i++) s.write(`line ${i}\r\n`);
    expect(s.text().split("\n")).toEqual(["line 16", "line 17", "line 18", "line 19", ""]);
  });

  it("maps 256-color indices", () => {
    expect(color256(3)).toBe("ansi:3");
    expect(color256(16)).toBe("rgb(0,0,0)");
    expect(color256(231)).toBe("rgb(255,255,255)");
    expect(color256(232)).toBe("rgb(8,8,8)");
  });
});
