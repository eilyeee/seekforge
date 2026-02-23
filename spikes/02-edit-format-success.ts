/**
 * Spike: search/replace edit format success rate.
 *
 * Sends 5 small inline source-file fixtures plus edit instructions to
 * deepseek-chat and asks for edits ONLY as a JSON block:
 *   {"path": "...", "edits": [{"oldString": "...", "newString": "..."}]}
 * Validates that each oldString appears exactly once in the fixture and that
 * applying the edits yields the expected result.
 *
 * Run: DEEPSEEK_API_KEY=... pnpm tsx spikes/02-edit-format-success.ts
 */

import { createDeepSeekProvider } from "../packages/core/src/provider/index.js";

type Fixture = {
  path: string;
  content: string;
  instruction: string;
  /** Returns true when the edited content satisfies the instruction. */
  expect: (edited: string) => boolean;
};

const FIXTURES: Fixture[] = [
  {
    path: "src/greet.ts",
    content: [
      "export function greet(name: string): string {",
      "  return `Hello, ${name}!`;",
      "}",
      "",
      'console.log(greet("world"));',
      "",
    ].join("\n"),
    instruction:
      "Rename the function `greet` to `sayHello` everywhere (definition and call site).",
    expect: (s) => s.includes("function sayHello") && s.includes('sayHello("world")') && !s.includes("greet("),
  },
  {
    path: "src/server.js",
    content: [
      'const http = require("http");',
      "",
      "const PORT = 3000;",
      "const server = http.createServer((req, res) => {",
      '  res.end("ok");',
      "});",
      "",
      "server.listen(PORT);",
      "",
    ].join("\n"),
    instruction: "Change the port from 3000 to 8080.",
    expect: (s) => s.includes("const PORT = 8080;") && !s.includes("3000"),
  },
  {
    path: "src/math.py",
    content: [
      "def add(a, b):",
      '    """Return the sum of a and b."""',
      "    return a - b",
      "",
      "",
      "def sub(a, b):",
      "    return a - b",
      "",
    ].join("\n"),
    instruction: "Fix the bug in `add`: it should return the sum, not the difference. Do not change `sub`.",
    expect: (s) => s.includes("return a + b") && s.split("return a - b").length === 2,
  },
  {
    path: "src/Counter.tsx",
    content: [
      'import { useState } from "react";',
      "",
      "export function Counter() {",
      "  const [count, setCount] = useState(0);",
      "  return (",
      "    <button onClick={() => setCount(count + 1)}>",
      "      Count: {count}",
      "    </button>",
      "  );",
      "}",
      "",
    ].join("\n"),
    instruction: 'Start the counter at 10 instead of 0, and change the button label prefix from "Count:" to "Clicks:".',
    expect: (s) => s.includes("useState(10)") && s.includes("Clicks:") && !s.includes("Count:"),
  },
  {
    path: "src/config.ts",
    content: [
      "export const config = {",
      '  env: "development",',
      "  debug: true,",
      "  retries: 1,",
      "};",
      "",
    ].join("\n"),
    instruction: 'Set env to "production", debug to false, and retries to 5.',
    expect: (s) =>
      s.includes('env: "production"') && s.includes("debug: false") && s.includes("retries: 5"),
  },
];

const SYSTEM_PROMPT = [
  "You are a precise code-editing assistant.",
  "Reply ONLY with a single fenced ```json block containing one JSON object of the form:",
  '{"path": "<file path>", "edits": [{"oldString": "<exact text>", "newString": "<replacement>"}]}',
  "Rules:",
  "- Each oldString must be copied VERBATIM from the file (including whitespace and newlines)",
  "  and must occur exactly once in the file. Include surrounding lines if needed for uniqueness.",
  "- Edits are applied in order; later oldStrings must match the file after earlier edits.",
  "- No prose, no explanations, nothing outside the JSON block.",
].join("\n");

type EditPlan = { path: string; edits: Array<{ oldString: string; newString: string }> };

function extractEditPlan(reply: string): EditPlan | null {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(reply);
  const raw = (fenced?.[1] ?? reply).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const plan = parsed as Partial<EditPlan>;
  if (typeof plan.path !== "string" || !Array.isArray(plan.edits)) return null;
  for (const e of plan.edits) {
    if (typeof e?.oldString !== "string" || typeof e?.newString !== "string") return null;
  }
  return plan as EditPlan;
}

function countOccurrences(haystack: string, needle: string): number {
  return needle.length === 0 ? 0 : haystack.split(needle).length - 1;
}

type Row = { fixture: string; parsed: boolean; applied: string; ok: boolean; note: string };

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log("DEEPSEEK_API_KEY not set — skipping edit-format spike.");
    return;
  }
  const provider = createDeepSeekProvider({ apiKey, model: "deepseek-chat" });
  const rows: Row[] = [];

  for (const fixture of FIXTURES) {
    console.log(`Fixture ${fixture.path}...`);
    const row: Row = { fixture: fixture.path, parsed: false, applied: "0/0", ok: false, note: "" };
    rows.push(row);
    let reply: string;
    try {
      const resp = await provider.chat({
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `File \`${fixture.path}\`:\n\n\`\`\`\n${fixture.content}\`\`\`\n\n` +
              `Instruction: ${fixture.instruction}`,
          },
        ],
      });
      reply = resp.content;
    } catch (err) {
      row.note = `API error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    const plan = extractEditPlan(reply);
    if (!plan) {
      row.note = "reply was not a valid edit JSON block";
      continue;
    }
    row.parsed = true;

    let content = fixture.content;
    let appliedCount = 0;
    for (const edit of plan.edits) {
      const occurrences = countOccurrences(content, edit.oldString);
      if (occurrences !== 1) {
        row.note = `oldString matched ${occurrences} times (need exactly 1)`;
        break;
      }
      content = content.replace(edit.oldString, edit.newString);
      appliedCount++;
    }
    row.applied = `${appliedCount}/${plan.edits.length}`;
    if (appliedCount !== plan.edits.length) continue;
    if (!fixture.expect(content)) {
      row.note = "edits applied but result does not satisfy the instruction";
      continue;
    }
    row.ok = true;
    row.note = "ok";
  }

  console.log("\n## Edit-format success summary\n");
  console.log("| Fixture | JSON parsed | Edits applied | Success | Note |");
  console.log("| --- | --- | --- | --- | --- |");
  for (const row of rows) {
    console.log(
      `| ${row.fixture} | ${row.parsed ? "yes" : "no"} | ${row.applied} | ${row.ok ? "yes" : "no"} | ${row.note} |`,
    );
  }
  const okCount = rows.filter((r) => r.ok).length;
  const rate = (100 * okCount) / rows.length;
  console.log(`\nOverall: ${okCount}/${rows.length} (${rate.toFixed(1)}%)`);
  console.log(`Pass threshold: >= 80% applicable edits -> ${rate >= 80 ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
