/**
 * A small ANSI terminal screen for the Desktop terminal panel. It is not a
 * full emulator: it keeps a scrollback of styled cells and understands the
 * sequences shells and common CLIs emit — SGR colors and attributes, cursor
 * movement and positioning, line/screen erase, insert/delete, save/restore,
 * and the alternate screen — and drops everything else (OSC titles, mode
 * switches, charset selection). Full-screen programs render approximately.
 * Pure: no DOM; unit-tested in ansi.test.ts.
 */

export type CellStyle = {
  /** CSS color, or `ansi:<n>` for one of the 16 themed palette entries. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
};

export type Span = { text: string; style: CellStyle };

type Cell = { ch: string; style: CellStyle };

const PLAIN: CellStyle = Object.freeze({});
const TAB_WIDTH = 8;

/** xterm 256-color cube and grayscale ramp (indices 16-255). */
export function color256(index: number): string {
  if (index < 16) return `ansi:${index}`;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const n = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(n / 36) % 6]},${steps[Math.floor(n / 6) % 6]},${steps[n % 6]})`;
}

function blankLine(): Cell[] {
  return [];
}

export class TerminalScreen {
  private lines: Cell[][] = [blankLine()];
  private row = 0;
  private col = 0;
  private style: CellStyle = PLAIN;
  private saved: { row: number; col: number; style: CellStyle } | null = null;
  private pending = "";
  private mainBuffer: { lines: Cell[][]; row: number; col: number } | null = null;
  /** Bumped on every change, so a renderer can skip identical snapshots. */
  version = 0;

  constructor(
    public cols: number,
    public rows: number,
    private readonly maxLines = 2_000,
  ) {}

  resize(cols: number, rows: number): void {
    this.cols = Math.max(2, cols);
    this.rows = Math.max(2, rows);
    this.version++;
  }

  clear(): void {
    this.lines = [blankLine()];
    this.row = 0;
    this.col = 0;
    this.version++;
  }

  /** First line index of the visible screen (the part cursor addressing uses). */
  private get top(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  private line(row: number): Cell[] {
    while (this.lines.length <= row) this.lines.push(blankLine());
    return this.lines[row]!;
  }

  private trimScrollback(): void {
    const excess = this.lines.length - this.maxLines;
    if (excess > 0) {
      this.lines.splice(0, excess);
      this.row = Math.max(0, this.row - excess);
      if (this.saved) this.saved.row = Math.max(0, this.saved.row - excess);
    }
  }

  private newline(): void {
    this.row++;
    this.line(this.row);
    this.trimScrollback();
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.newline();
    }
    const cells = this.line(this.row);
    while (cells.length < this.col) cells.push({ ch: " ", style: PLAIN });
    cells[this.col] = { ch, style: this.style };
    this.col++;
  }

  private clampRow(row: number): number {
    return Math.min(Math.max(row, this.top), this.top + this.rows - 1);
  }

  write(data: string): void {
    const text = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\u001b") {
        const consumed = this.escape(text, i);
        if (consumed === 0) {
          // Incomplete sequence: keep it for the next chunk (bounded).
          const rest = text.slice(i);
          this.pending = rest.length > 256 ? "" : rest;
          break;
        }
        i += consumed;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (ch === "\r") this.col = 0;
      else if (ch === "\n") this.newline();
      else if (ch === "\b") this.col = Math.max(0, this.col - 1);
      else if (ch === "\t") this.col = Math.min(this.cols - 1, (Math.floor(this.col / TAB_WIDTH) + 1) * TAB_WIDTH);
      else if (code >= 0x20 && code !== 0x7f) {
        // Keep surrogate pairs in one cell.
        const next = text.charCodeAt(i + 1);
        if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          this.put(ch + text[i + 1]);
          i += 2;
          continue;
        }
        this.put(ch);
      }
      i++;
    }
    this.version++;
  }

  /** Handles one escape sequence at `start`; returns its length, or 0 when incomplete. */
  private escape(text: string, start: number): number {
    const kind = text[start + 1];
    if (kind === undefined) return 0;
    if (kind === "[") {
      let end = start + 2;
      while (end < text.length) {
        const code = text.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end++;
      }
      if (end >= text.length) return 0;
      this.csi(text.slice(start + 2, end), text[end]!);
      return end - start + 1;
    }
    if (kind === "]" || kind === "P" || kind === "_" || kind === "^") {
      // OSC / DCS / APC / PM: skip to BEL or ST.
      for (let end = start + 2; end < text.length; end++) {
        if (text[end] === "\u0007") return end - start + 1;
        if (text[end] === "\u001b") {
          if (end + 1 >= text.length) return 0;
          if (text[end + 1] === "\\") return end - start + 2;
        }
      }
      return 0;
    }
    if (kind === "(" || kind === ")" || kind === "*" || kind === "+" || kind === "#" || kind === "%") {
      return start + 2 < text.length ? 3 : 0;
    }
    switch (kind) {
      case "7":
        this.saved = { row: this.row, col: this.col, style: this.style };
        break;
      case "8":
        if (this.saved) {
          this.row = this.saved.row;
          this.col = this.saved.col;
          this.style = this.saved.style;
        }
        break;
      case "c":
        this.clear();
        this.style = PLAIN;
        break;
      case "M":
        this.row = this.clampRow(this.row - 1);
        break;
      case "D":
      case "E":
        this.newline();
        if (kind === "E") this.col = 0;
        break;
      default:
        break;
    }
    return 2;
  }

  private csi(paramText: string, final: string): void {
    const priv = paramText.startsWith("?") || paramText.startsWith(">") || paramText.startsWith("=");
    const params = (priv ? paramText.slice(1) : paramText).split(";").map((p) => (p === "" ? Number.NaN : Number(p)));
    const n = (index: number, fallback: number) => {
      const value = params[index];
      return value === undefined || Number.isNaN(value) ? fallback : value;
    };
    if (priv) {
      if ((final === "h" || final === "l") && params.includes(1049)) this.alternateScreen(final === "h");
      return;
    }
    switch (final) {
      case "m":
        this.sgr(params);
        return;
      case "A":
        this.row = this.clampRow(this.row - Math.max(1, n(0, 1)));
        return;
      case "B":
        this.row = this.clampRow(this.row + Math.max(1, n(0, 1)));
        this.line(this.row);
        return;
      case "C":
        this.col = Math.min(this.cols - 1, this.col + Math.max(1, n(0, 1)));
        return;
      case "D":
        this.col = Math.max(0, this.col - Math.max(1, n(0, 1)));
        return;
      case "E":
      case "F":
        this.row = this.clampRow(this.row + (final === "E" ? 1 : -1) * Math.max(1, n(0, 1)));
        this.line(this.row);
        this.col = 0;
        return;
      case "G":
      case "`":
        this.col = Math.min(this.cols - 1, Math.max(0, n(0, 1) - 1));
        return;
      case "d":
        this.row = this.clampRow(this.top + n(0, 1) - 1);
        this.line(this.row);
        return;
      case "H":
      case "f": {
        // Absolute addressing needs a full screen of lines to address into.
        this.line(this.top + this.rows - 1);
        this.row = this.clampRow(this.top + Math.max(1, n(0, 1)) - 1);
        this.col = Math.min(this.cols - 1, Math.max(0, n(1, 1) - 1));
        return;
      }
      case "J":
        this.eraseDisplay(n(0, 0));
        return;
      case "K":
        this.eraseLine(n(0, 0));
        return;
      case "X": {
        const cells = this.line(this.row);
        for (let c = this.col; c < Math.min(cells.length, this.col + Math.max(1, n(0, 1))); c++) {
          cells[c] = { ch: " ", style: PLAIN };
        }
        return;
      }
      case "P": {
        this.line(this.row).splice(this.col, Math.max(1, n(0, 1)));
        return;
      }
      case "@": {
        const cells = this.line(this.row);
        if (this.col <= cells.length) {
          cells.splice(this.col, 0, ...Array.from({ length: Math.max(1, n(0, 1)) }, () => ({ ch: " ", style: PLAIN })));
          cells.length = Math.min(cells.length, this.cols);
        }
        return;
      }
      case "L":
      case "M": {
        const count = Math.max(1, n(0, 1));
        const bottom = this.top + this.rows;
        this.line(bottom - 1);
        if (final === "L") {
          this.lines.splice(this.row, 0, ...Array.from({ length: count }, blankLine));
          this.lines.splice(bottom, count);
        } else {
          this.lines.splice(this.row, count);
          this.lines.splice(bottom - count, 0, ...Array.from({ length: count }, blankLine));
        }
        return;
      }
      case "S":
        for (let k = 0; k < Math.max(1, n(0, 1)); k++) this.lines.push(blankLine());
        this.trimScrollback();
        return;
      case "s":
        this.saved = { row: this.row, col: this.col, style: this.style };
        return;
      case "u":
        if (this.saved) {
          this.row = this.saved.row;
          this.col = this.saved.col;
        }
        return;
      default:
        return;
    }
  }

  private eraseLine(mode: number): void {
    const cells = this.line(this.row);
    if (mode === 0) cells.length = Math.min(cells.length, this.col);
    else if (mode === 1)
      for (let c = 0; c <= Math.min(this.col, cells.length - 1); c++) cells[c] = { ch: " ", style: PLAIN };
    else cells.length = 0;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      // Drop the scrollback, keep the visible screen.
      const top = this.top;
      this.lines = this.lines.slice(top);
      this.row = Math.max(0, this.row - top);
      if (this.saved) this.saved.row = Math.max(0, this.saved.row - top);
      return;
    }
    const top = this.top;
    const bottom = top + this.rows;
    this.line(bottom - 1);
    if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.lines.length; r++) this.lines[r] = blankLine();
    } else if (mode === 1) {
      for (let r = top; r < this.row; r++) this.lines[r] = blankLine();
      this.eraseLine(1);
    } else {
      // Clear the visible screen by scrolling it into the scrollback, the way
      // most emulators do, so `clear` keeps history reachable.
      const used = this.lines.length;
      for (let k = 0; k < this.rows; k++) this.lines.push(blankLine());
      this.row = this.row + (this.lines.length - used);
      this.trimScrollback();
    }
  }

  private alternateScreen(enter: boolean): void {
    if (enter && !this.mainBuffer) {
      this.mainBuffer = { lines: this.lines, row: this.row, col: this.col };
      this.lines = Array.from({ length: this.rows }, blankLine);
      this.row = 0;
      this.col = 0;
    } else if (!enter && this.mainBuffer) {
      ({ lines: this.lines, row: this.row, col: this.col } = this.mainBuffer);
      this.mainBuffer = null;
    }
  }

  private sgr(params: number[]): void {
    const next: CellStyle = { ...this.style };
    const list = params.length === 0 ? [0] : params;
    for (let k = 0; k < list.length; k++) {
      const p = Number.isNaN(list[k]!) ? 0 : list[k]!;
      if (p === 0) {
        for (const key of Object.keys(next)) delete next[key as keyof CellStyle];
      } else if (p === 1) next.bold = true;
      else if (p === 2) next.dim = true;
      else if (p === 3) next.italic = true;
      else if (p === 4) next.underline = true;
      else if (p === 7) next.inverse = true;
      else if (p === 22) {
        delete next.bold;
        delete next.dim;
      } else if (p === 23) delete next.italic;
      else if (p === 24) delete next.underline;
      else if (p === 27) delete next.inverse;
      else if (p >= 30 && p <= 37) next.fg = `ansi:${p - 30}`;
      else if (p >= 90 && p <= 97) next.fg = `ansi:${p - 90 + 8}`;
      else if (p === 39) delete next.fg;
      else if (p >= 40 && p <= 47) next.bg = `ansi:${p - 40}`;
      else if (p >= 100 && p <= 107) next.bg = `ansi:${p - 100 + 8}`;
      else if (p === 49) delete next.bg;
      else if (p === 38 || p === 48) {
        const target = p === 38 ? "fg" : "bg";
        if (list[k + 1] === 5 && list[k + 2] !== undefined) {
          next[target] = color256(list[k + 2]!);
          k += 2;
        } else if (list[k + 1] === 2 && list[k + 4] !== undefined) {
          next[target] = `rgb(${list[k + 2]},${list[k + 3]},${list[k + 4]})`;
          k += 4;
        }
      }
    }
    this.style = Object.keys(next).length === 0 ? PLAIN : next;
  }

  /** The buffer as styled spans per line (trailing blank lines dropped). */
  snapshot(): Span[][] {
    let last = this.lines.length - 1;
    while (last > this.row && this.lines[last]!.length === 0) last--;
    const out: Span[][] = [];
    for (let r = 0; r <= last; r++) {
      const spans: Span[] = [];
      for (const cell of this.lines[r]!) {
        const tail = spans[spans.length - 1];
        if (tail && tail.style === cell.style) tail.text += cell.ch;
        else spans.push({ text: cell.ch, style: cell.style });
      }
      out.push(spans);
    }
    return out;
  }

  /** Plain text of the buffer (for tests and URL detection). */
  text(): string {
    return this.snapshot()
      .map((spans) => spans.map((span) => span.text).join(""))
      .join("\n");
  }
}
