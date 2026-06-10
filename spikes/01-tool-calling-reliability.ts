/**
 * Spike: DeepSeek native tool-calling reliability.
 *
 * Runs N multi-turn conversations against deepseek-chat with two fake tools
 * (read_file, get_weather) whose results are canned and fed back. Every
 * conversation requires >= 2 sequential tool calls (read a file to learn the
 * city, then fetch that city's weather).
 *
 * Run: DEEPSEEK_API_KEY=... pnpm tsx spikes/01-tool-calling-reliability.ts [--n 10]
 */

import type { ChatMessage, ToolDefinitionForModel } from "../packages/shared/src/index.js";
import { createDeepSeekProvider } from "../packages/core/src/provider/index.js";

type Scenario = {
  path: string;
  city: string;
  temperatureC: number;
  condition: string;
};

const SCENARIOS: Scenario[] = [
  { path: "config/city.txt", city: "Tokyo", temperatureC: 21, condition: "sunny" },
  { path: "data/destination.txt", city: "Berlin", temperatureC: 14, condition: "cloudy" },
  { path: "notes/trip.txt", city: "Sydney", temperatureC: 26, condition: "clear" },
  { path: "settings/location.txt", city: "Oslo", temperatureC: 3, condition: "snow" },
  { path: "docs/office.txt", city: "Lisbon", temperatureC: 19, condition: "windy" },
];

const TOOLS: ToolDefinitionForModel[] = [
  {
    name: "read_file",
    description: "Read a text file from the workspace and return its content.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Workspace-relative file path." } },
      required: ["path"],
    },
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name, e.g. Tokyo." } },
      required: ["city"],
    },
  },
];

function cannedToolResult(scenario: Scenario, name: string, argsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ error: "could not parse arguments JSON" });
  }
  if (name === "read_file") {
    if (args.path === scenario.path) {
      return JSON.stringify({ path: scenario.path, content: `city: ${scenario.city}\n` });
    }
    return JSON.stringify({ error: `file not found: ${String(args.path)}` });
  }
  if (name === "get_weather") {
    if (typeof args.city === "string" && args.city.toLowerCase() === scenario.city.toLowerCase()) {
      return JSON.stringify({
        city: scenario.city,
        temperature_c: scenario.temperatureC,
        condition: scenario.condition,
      });
    }
    return JSON.stringify({ error: `unknown city: ${String(args.city)}` });
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

type Stats = {
  conversations: number;
  completed: number;
  turnsNeedingTool: number;
  validToolTurns: number;
  totalToolCalls: number;
  malformedJson: number;
  apiErrors: number;
};

async function runConversation(
  provider: ReturnType<typeof createDeepSeekProvider>,
  scenario: Scenario,
  stats: Stats,
): Promise<void> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Use the provided tools to gather facts; " +
        "never invent file contents or weather data.",
    },
    {
      role: "user",
      content:
        `The file "${scenario.path}" names a city. Read it with read_file, then call ` +
        "get_weather for that city, and finally tell me the city and the current " +
        "temperature in Celsius.",
    },
  ];
  const toolsCalled = new Set<string>();
  const knownTools = new Set(TOOLS.map((t) => t.name));

  for (let turn = 0; turn < 6; turn++) {
    const needsTool = !(toolsCalled.has("read_file") && toolsCalled.has("get_weather"));
    let resp;
    try {
      resp = await provider.chat({ messages, tools: TOOLS, temperature: 0 });
    } catch (err) {
      stats.apiErrors++;
      console.error(`  API error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (resp.toolCalls.length > 0) {
      stats.totalToolCalls += resp.toolCalls.length;
      let allValid = true;
      for (const call of resp.toolCalls) {
        let jsonOk = true;
        try {
          JSON.parse(call.argumentsJson);
        } catch {
          jsonOk = false;
          stats.malformedJson++;
        }
        if (!jsonOk || !knownTools.has(call.name)) allValid = false;
      }
      if (needsTool) {
        stats.turnsNeedingTool++;
        if (allValid) stats.validToolTurns++;
      }
      messages.push({ role: "assistant", content: resp.content, toolCalls: resp.toolCalls });
      for (const call of resp.toolCalls) {
        toolsCalled.add(call.name);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: cannedToolResult(scenario, call.name, call.argumentsJson),
        });
      }
      continue;
    }

    // Text answer with no tool call.
    if (needsTool) stats.turnsNeedingTool++; // tool was needed but not produced -> invalid turn
    const answered =
      !needsTool &&
      resp.content.toLowerCase().includes(scenario.city.toLowerCase()) &&
      resp.content.includes(String(scenario.temperatureC));
    if (answered) stats.completed++;
    console.log(
      `  ${answered ? "completed" : "NOT completed"} (tools used: ${[...toolsCalled].join(", ") || "none"})`,
    );
    return;
  }
  console.log("  NOT completed (turn limit reached)");
}

function pct(num: number, den: number): string {
  return den === 0 ? "n/a" : `${((100 * num) / den).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log("DEEPSEEK_API_KEY not set — skipping tool-calling reliability spike.");
    return;
  }

  const argv = process.argv.slice(2);
  let n = 10;
  const nIdx = argv.indexOf("--n");
  if (nIdx !== -1 && argv[nIdx + 1]) n = Number(argv[nIdx + 1]);
  const nEq = argv.find((a) => a.startsWith("--n="));
  if (nEq) n = Number(nEq.split("=")[1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error("invalid --n value");
    process.exitCode = 1;
    return;
  }

  const provider = createDeepSeekProvider({ apiKey, model: "deepseek-chat" });
  const stats: Stats = {
    conversations: n,
    completed: 0,
    turnsNeedingTool: 0,
    validToolTurns: 0,
    totalToolCalls: 0,
    malformedJson: 0,
    apiErrors: 0,
  };

  for (let i = 0; i < n; i++) {
    const scenario = SCENARIOS[i % SCENARIOS.length]!;
    console.log(`Conversation ${i + 1}/${n} (${scenario.city})...`);
    await runConversation(provider, scenario, stats);
  }

  console.log("\n## Tool-calling reliability summary\n");
  console.log("| Metric | Value |");
  console.log("| --- | --- |");
  console.log(`| Conversations | ${stats.conversations} |`);
  console.log(
    `| Conversations completed | ${stats.completed} (${pct(stats.completed, stats.conversations)}) |`,
  );
  console.log(`| Turns where a tool call was needed | ${stats.turnsNeedingTool} |`);
  console.log(
    `| ...with a syntactically valid tool call | ${stats.validToolTurns} (${pct(stats.validToolTurns, stats.turnsNeedingTool)}) |`,
  );
  console.log(`| Total tool calls | ${stats.totalToolCalls} |`);
  console.log(`| Malformed-JSON tool calls | ${stats.malformedJson} |`);
  console.log(`| API errors | ${stats.apiErrors} |`);
  const passed =
    stats.turnsNeedingTool > 0 && stats.validToolTurns / stats.turnsNeedingTool >= 0.9;
  console.log(`\nPass threshold: >= 90% valid tool calls -> ${passed ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
