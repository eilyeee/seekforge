import React from "react";
import { Box, Text } from "ink";
import { ACCENT } from "./Header.js";

/**
 * Minimal terminal markdown: headings, bullet/numbered lists, fenced code
 * blocks, and inline spans (code, bold, italic). Deliberately small — no heavy
 * markdown dep. Good enough for streamed assistant prose.
 */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.replace(/\s+$/, "").split("\n");
  const out: React.ReactElement[] = [];
  let inFence = false;
  let key = 0;

  for (const line of lines) {
    const fence = line.trim().startsWith("```");
    if (fence) {
      inFence = !inFence;
      continue; // drop the fence markers themselves
    }
    if (inFence) {
      out.push(
        <Text key={key++} color="green">
          {"  "}
          {line}
        </Text>,
      );
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
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(
        <Text key={key++}>
          {bullet[1]}
          <Text color={ACCENT}>• </Text>
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

  return <Box flexDirection="column">{out}</Box>;
}

/** Inline spans: `code`, **bold**, *italic*. */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
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
    } else if (token.startsWith("**")) {
      parts.push(
        <Text key={key++} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={key++} italic>
          {token.slice(1, -1)}
        </Text>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
