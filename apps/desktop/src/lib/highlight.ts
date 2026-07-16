/**
 * Dependency-free syntax highlighter for fenced code blocks and diff content.
 * Re-derived from the TUI's highlighter (apps/tui/src/highlight.ts) — apps must
 * not import across each other — but emits web token *classes* instead of ink
 * color names, so the React renderer maps them to design tokens.
 *
 * A tiny per-line state machine colors comments, strings, numbers, keywords and
 * literals for a handful of common languages. The only state carried across
 * lines is whether a C-family block comment is open. Correctness over
 * completeness — it must never throw on weird input.
 */

/** Semantic token classes; the renderer maps each to a design-token color. */
export type TokenClass = "comment" | "string" | "number" | "keyword" | "literal";

export type CodeToken = { text: string; cls?: TokenClass };

type LangDef = {
  keywords: Set<string>;
  literals: Set<string>;
  lineComment?: string;
  blockComment?: boolean;
};

const words = (s: string): Set<string> => new Set(s.split(" "));

const ALIASES: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  typescript: "ts",
  js: "ts",
  jsx: "ts",
  javascript: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "py",
  python: "py",
  rs: "rs",
  rust: "rs",
  go: "go",
  golang: "go",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  html: "html",
  xml: "html",
  yaml: "yaml",
  yml: "yaml",
};

const DEFS: Record<string, LangDef> = {
  ts: {
    lineComment: "//",
    blockComment: true,
    keywords: words(
      "const let var function return if else for while class extends new " +
        "import export from default async await try catch finally throw " +
        "typeof instanceof interface type switch case break continue of in " +
        "this super static get set public private protected readonly enum " +
        "implements namespace declare as satisfies keyof",
    ),
    literals: words("true false null undefined void NaN Infinity"),
  },
  py: {
    lineComment: "#",
    keywords: words(
      "def return if elif else for while class import from as with try " +
        "except finally raise lambda pass break continue yield global " +
        "nonlocal async await not and or in is del assert",
    ),
    literals: words("True False None"),
  },
  rs: {
    lineComment: "//",
    blockComment: true,
    keywords: words(
      "fn let mut pub use mod struct enum impl trait return if else for " +
        "while loop match break continue const static ref move async await " +
        "dyn where unsafe as in crate self super type",
    ),
    literals: words("true false None Some Ok Err"),
  },
  go: {
    lineComment: "//",
    blockComment: true,
    keywords: words(
      "func var const type struct interface map chan return if else for " +
        "range switch case break continue default go defer select package " +
        "import goto fallthrough",
    ),
    literals: words("true false nil iota"),
  },
  sh: {
    lineComment: "#",
    keywords: words(
      "if then else elif fi for while until do done case esac function in " +
        "return local export exit break continue select echo cd source",
    ),
    literals: words("true false"),
  },
  json: { keywords: new Set(), literals: words("true false null") },
  css: { lineComment: undefined, blockComment: true, keywords: new Set(), literals: new Set() },
  html: { keywords: new Set(), literals: new Set() },
  yaml: { lineComment: "#", keywords: new Set(), literals: words("true false null yes no") },
};

/** Resolves an info-string language to a known def, or undefined if unknown. */
function resolveDef(lang?: string): LangDef | undefined {
  if (!lang) return undefined;
  // The info-string may carry extra words ("ts {1,3}"); take the first token.
  const first = lang.trim().toLowerCase().split(/\s+/)[0] ?? "";
  return DEFS[ALIASES[first] ?? ""];
}

/** True when the language is known to the highlighter (drives renderer fallback). */
export function isKnownLang(lang?: string): boolean {
  return resolveDef(lang) !== undefined;
}

/**
 * Tokenize one line of code. `inBlock` carries an open C-family block comment
 * across lines; the returned `inBlock` feeds the next line. Pure, never throws.
 */
export function highlightLine(line: string, lang?: string, inBlock = false): { tokens: CodeToken[]; inBlock: boolean } {
  const def = resolveDef(lang);
  if (!def) return { tokens: [{ text: line }], inBlock: false };
  return tokenizeLine(line, def, inBlock);
}

/**
 * Tokenize `code` for display: one token array per line. Unknown or absent
 * `lang` returns plain (unclassified) single-token lines. Never throws.
 */
export function highlightLines(code: string, lang?: string): CodeToken[][] {
  const def = resolveDef(lang);
  const lines = code.split("\n");
  if (!def) return lines.map((line) => [{ text: line }]);
  let inBlock = false;
  return lines.map((line) => {
    const r = tokenizeLine(line, def, inBlock);
    inBlock = r.inBlock;
    return r.tokens;
  });
}

function tokenizeLine(line: string, def: LangDef, inBlock: boolean): { tokens: CodeToken[]; inBlock: boolean } {
  const tokens: CodeToken[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      tokens.push({ text: plain });
      plain = "";
    }
  };
  const push = (text: string, cls: TokenClass): void => {
    if (text === "") return;
    flush();
    tokens.push({ text, cls });
  };

  let i = 0;
  if (inBlock) {
    const end = line.indexOf("*/");
    if (end === -1) {
      if (line) tokens.push({ text: line, cls: "comment" });
      return { tokens, inBlock: true };
    }
    push(line.slice(0, end + 2), "comment");
    i = end + 2;
  }

  while (i < line.length) {
    const ch = line[i] as string;
    if (def.blockComment && ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push(line.slice(i), "comment");
        return { tokens, inBlock: true };
      }
      push(line.slice(i, end + 2), "comment");
      i = end + 2;
      continue;
    }
    if (def.lineComment && line.startsWith(def.lineComment, i)) {
      push(line.slice(i), "comment");
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      const end = j < line.length ? j + 1 : line.length; // tolerate unterminated
      push(line.slice(i, end), "string");
      i = end;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < line.length && /[\w.]/.test(line[j] as string)) j++;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w$]/.test(line[j] as string)) j++;
      const word = line.slice(i, j);
      if (def.keywords.has(word)) push(word, "keyword");
      else if (def.literals.has(word)) push(word, "literal");
      else plain += word;
      i = j;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return { tokens, inBlock: false };
}

/** Infers a highlighter language from a file path's extension; "" if unknown. */
export function langFromPath(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  if (!m) return "";
  const ext = (m[1] as string).toLowerCase();
  return ext in ALIASES ? ext : "";
}
