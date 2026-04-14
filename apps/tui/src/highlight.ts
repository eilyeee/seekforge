/**
 * Lightweight syntax highlighter for fenced code blocks. No dependency: a
 * tiny per-line state machine that colors comments, strings, numbers,
 * keywords, and literals for a handful of common languages. The only state
 * carried across lines is whether a C-family block comment is open.
 * Correctness over completeness — it must never throw on weird input.
 */

export type CodeToken = { text: string; color?: string };

type LangDef = {
  keywords: Set<string>;
  literals: Set<string>;
  lineComment?: string;
  blockComment?: boolean;
};

const words = (s: string): Set<string> => new Set(s.split(" "));

const ALIASES: Record<string, string> = {
  ts: "ts", tsx: "ts", typescript: "ts",
  js: "ts", jsx: "ts", javascript: "ts", mjs: "ts",
  py: "py", python: "py",
  rs: "rs", rust: "rs",
  go: "go",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh",
  json: "json", css: "css", html: "html",
  yaml: "yaml", yml: "yaml",
};

const DEFS: Record<string, LangDef> = {
  ts: {
    lineComment: "//", blockComment: true,
    keywords: words(
      "const let var function return if else for while class extends new " +
      "import export from default async await try catch finally throw " +
      "typeof instanceof interface type switch case break continue of in",
    ),
    literals: words("true false null undefined"),
  },
  py: {
    lineComment: "#",
    keywords: words(
      "def return if elif else for while class import from as with try " +
      "except finally raise lambda pass break continue yield global " +
      "async await not and or in is del",
    ),
    literals: words("True False None"),
  },
  rs: {
    lineComment: "//", blockComment: true,
    keywords: words(
      "fn let mut pub use mod struct enum impl trait return if else for " +
      "while loop match break continue const static ref move async await " +
      "dyn where unsafe as in",
    ),
    literals: words("true false"),
  },
  go: {
    lineComment: "//", blockComment: true,
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
      "return local export exit break continue select",
    ),
    literals: words("true false"),
  },
  json: { keywords: new Set(), literals: words("true false null") },
  css: { blockComment: true, keywords: new Set(), literals: new Set() },
  html: { keywords: new Set(), literals: new Set() },
  yaml: { lineComment: "#", keywords: new Set(), literals: words("true false null") },
};

/**
 * Tokenize `code` for terminal display: one token array per line. Colors are
 * ink color names. Unknown or absent `lang` returns plain (uncolored) lines.
 */
export function highlightLines(code: string, lang?: string): CodeToken[][] {
  const def = lang ? DEFS[ALIASES[lang.trim().toLowerCase()] ?? ""] : undefined;
  const lines = code.split("\n");
  if (!def) return lines.map((line) => [{ text: line }]);
  let inBlock = false;
  return lines.map((line) => {
    const r = tokenizeLine(line, def, inBlock);
    inBlock = r.inBlock;
    return r.tokens;
  });
}

function tokenizeLine(
  line: string,
  def: LangDef,
  inBlock: boolean,
): { tokens: CodeToken[]; inBlock: boolean } {
  const tokens: CodeToken[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain) {
      tokens.push({ text: plain });
      plain = "";
    }
  };
  const push = (text: string, color: string): void => {
    flush();
    tokens.push({ text, color });
  };

  let i = 0;
  if (inBlock) {
    const end = line.indexOf("*/");
    if (end === -1) {
      if (line) tokens.push({ text: line, color: "gray" });
      return { tokens, inBlock: true };
    }
    push(line.slice(0, end + 2), "gray");
    i = end + 2;
  }

  while (i < line.length) {
    const ch = line[i] as string;
    if (def.blockComment && ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push(line.slice(i), "gray");
        return { tokens, inBlock: true };
      }
      push(line.slice(i, end + 2), "gray");
      i = end + 2;
      continue;
    }
    if (def.lineComment && line.startsWith(def.lineComment, i)) {
      push(line.slice(i), "gray");
      break;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      const end = j < line.length ? j + 1 : line.length; // tolerate unterminated
      push(line.slice(i, end), "green");
      i = end;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < line.length && /[\w.]/.test(line[j] as string)) j++;
      push(line.slice(i, j), "yellow");
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < line.length && /[\w$]/.test(line[j] as string)) j++;
      const word = line.slice(i, j);
      if (def.keywords.has(word)) push(word, "magenta");
      else if (def.literals.has(word)) push(word, "yellow");
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
