import type React from "react";
import { Box, Text } from "ink";
import { ACCENT } from "./Header.js";
import { highlightLines } from "../highlight.js";
import { layoutTable, osc8Link, supportsHyperlinks } from "../render-helpers.js";

/**
 * Minimal terminal markdown: headings, nested bullet/numbered lists, fenced
 * code blocks (syntax highlighted), tables, blockquotes, horizontal rules,
 * and inline spans (code, bold, italic, links). Deliberately small — no
 * heavy markdown dep. Streaming tolerant: partial input must never crash.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.replace(/\s+$/, "").split("\n");
  const out: React.ReactElement[] = [];
  let fence: { lang?: string; body: string[] } | null = null;
  let key = 0;

  const flushFence = (): void => {
    if (!fence) return;
    if (fence.lang) {
      out.push(
        <Text key={key++} dimColor>
          {"  "}
          {fence.lang}
        </Text>,
      );
    }
    const rows = highlightLines(fence.body.join("\n"), fence.lang);
    for (const row of rows) {
      out.push(
        <Text key={key++}>
          {"  "}
          {row.map((token, i) =>
            token.color ? (
              <Text key={i} color={token.color}>
                {token.text}
              </Text>
            ) : (
              <Text key={i}>{token.text}</Text>
            ),
          )}
        </Text>,
      );
    }
    fence = null;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] as string;
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (fence) {
        flushFence(); // closing fence
      } else {
        const lang = trimmed.slice(3).trim();
        fence = lang ? { lang, body: [] } : { body: [] };
      }
      continue;
    }
    if (fence) {
      fence.body.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <Text key={key++} color={ACCENT} bold>
          {heading[2]}
        </Text>,
      );
      continue;
    }
    // Horizontal rule (checked before bullets: "---" has no trailing space).
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(
        <Text key={key++} dimColor>
          {"─".repeat(40)}
        </Text>,
      );
      continue;
    }
    // Table: a run of |-rows starting here that layoutTable accepts.
    if (trimmed.startsWith("|")) {
      let end = idx;
      while (end < lines.length && (lines[end] as string).trim().startsWith("|")) end += 1;
      const table = layoutTable(lines.slice(idx, end));
      if (table) {
        table.forEach((row, i) => {
          out.push(
            <Text key={key++} bold={i === 0} dimColor={i === 1}>
              {row}
            </Text>,
          );
        });
        idx = end - 1;
        continue;
      }
      // Malformed (or still streaming): fall through and render as plain text.
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const inner = /^>\s?(.*)$/.exec(quote[1] ?? "");
      out.push(
        <Text key={key++}>
          <Text dimColor>│ {inner ? "│ " : ""}</Text>
          {renderInline(inner ? (inner[1] ?? "") : (quote[1] ?? ""))}
        </Text>,
      );
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      const indent = bullet[1] ?? "";
      const glyphs = ["•", "◦", "▪"];
      const glyph = glyphs[Math.floor(indent.length / 2) % glyphs.length];
      out.push(
        <Text key={key++}>
          {indent}
          <Text color={ACCENT}>{glyph} </Text>
          {renderInline(bullet[2] ?? "")}
        </Text>,
      );
      continue;
    }
    const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      out.push(
        <Text key={key++}>
          {numbered[1]}
          <Text color={ACCENT}>{numbered[2]}. </Text>
          {renderInline(numbered[3] ?? "")}
        </Text>,
      );
      continue;
    }
    out.push(<Text key={key++}>{renderInline(line)}</Text>);
  }
  flushFence(); // unterminated fence (still streaming): render the partial body

  return <Box flexDirection="column">{out}</Box>;
}

/** Inline spans: `code`, [text](url), **bold**, *italic*, bare URLs. */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s)\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      parts.push(
        <Text key={key++} color="green">
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        const label = link[1] as string;
        const url = link[2] as string;
        // OSC 8-capable terminals get a real clickable hyperlink (the URL
        // travels in zero-width escapes); others keep the "(url)" suffix.
        parts.push(
          supportsHyperlinks() ? (
            <Text key={key++} color={ACCENT} underline>
              {osc8Link(label, url)}
            </Text>
          ) : (
            <Text key={key++}>
              <Text color={ACCENT} underline>
                {label}
              </Text>
              {url !== label ? <Text dimColor> ({url})</Text> : null}
            </Text>
          ),
        );
      } else {
        parts.push(token);
      }
    } else if (token.startsWith("**")) {
      parts.push(
        <Text key={key++} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith("*")) {
      parts.push(
        <Text key={key++} italic>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      // Bare URL: also OSC 8-wrapped when supported (label stays the URL).
      parts.push(
        <Text key={key++} underline>
          {osc8Link(token, token)}
        </Text>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
