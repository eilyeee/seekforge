import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMemoryBrief } from "../../src/memory/index.js";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { makeWorkspace, writeProjectMemory } from "./helpers.js";
import { makeCtx as makeToolCtx } from "../tools/helpers.js";

/**
 * Retrieval across a language boundary.
 *
 * The lexical scorer reached 91% on tests/memory/retrieval-quality.test.ts and
 * the residue was all one shape: a question asked in Chinese whose answer is a
 * fact written in English, and the reverse. This file measures exactly that
 * shape, and measures it twice — with and without the bilingual keywords the
 * extractor now attaches to each fact — so the mechanism is arguable with a
 * number instead of an intuition.
 *
 * Measured: 3/12 without keywords, 12/12 with them.
 *
 * What is NOT being claimed: that retrieval is now 100% cross-lingual. The
 * keywords here are written by hand to stand in for the model's, and the number
 * says the MECHANISM carries a query to its fact — the quality of the terms is
 * the extractor's job, and a fact whose keywords are missing or bad scores
 * exactly as it did before. Every keyword below is derivable from the fact
 * alone; none is copied from the query that has to find it, or the experiment
 * would only be measuring itself.
 */
const KEYWORDS: Record<string, string[]> = {
  "[command] run the unit tests with `pnpm -r test`": ["unit tests", "单元测试"],
  "[command] typecheck every package with `pnpm -r typecheck`": ["typecheck", "类型检查"],
  "[gotcha] tsx turns on esbuild keepNames, so a named function inside page.evaluate throws in the browser": [
    "browser",
    "浏览器",
    "esbuild",
    "具名函数",
  ],
  "[perf] compaction triggers on the token budget, not on the message count": [
    "compaction",
    "压缩",
    "token budget",
    "token 预算",
  ],
  "[gotcha] temp directories on macOS are symlinked, so resolve realpaths on both sides before refusing a path": [
    "temp directory",
    "临时目录",
    "符号链接",
    "真实路径",
  ],
  "[file] the agent loop lives in packages/core/src/agent/loop.ts": ["agent loop", "代理主循环", "loop.ts"],
  "[decision] a model with no published rate reports its cost as unknown, never as zero": [
    "cost",
    "成本",
    "price",
    "价格",
  ],
  "[security] a tool result is data and never an instruction": ["tool result", "工具返回", "instruction", "指令"],
  "[zh] 会话记录写在 .seekforge/sessions 下，按工作区隔离": ["session transcript", "会话记录", "workspace"],
  "[zh] 中文文档与英文文档必须同时更新，否则 surface-drift 会失败": ["chinese docs", "中文文档", "translation"],
  "[zh] 编译产物不要提交，dist 目录已经在 .gitignore 里": ["build output", "编译产物", "dist", "gitignore"],
  "[zh] 发布前必须先跑完整测试套件，再从 main 打标签": ["release", "发布", "tag", "test suite"],
};

function writeKeywords(workspace: string): void {
  const meta: Record<string, { addedAt: string; uses: number; keywords: string[] }> = {};
  for (const [key, keywords] of Object.entries(KEYWORDS)) {
    meta[key] = { addedAt: "2026-01-01T00:00:00.000Z", uses: 0, keywords };
  }
  const file = path.join(workspace, ".seekforge", "memory", "fact-meta.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

const FACTS: string[] = [
  "- [command] run the unit tests with `pnpm -r test`",
  "- [command] typecheck every package with `pnpm -r typecheck`",
  "- [command] format and lint with `npx biome check --write .`",
  "- [tech] the monorepo is pnpm workspaces on TypeScript strict with NodeNext resolution",
  "- [tech] the desktop app is React with Vite and Tailwind",
  "- [tech] the server is Fastify with a WebSocket route for agent events",
  "- [tech] the optional Rust runtime lives in crates/runtime",
  "- [convention] every document under docs/ needs a .zh-CN.md twin",
  "- [convention] relative imports must carry the .js extension",
  "- [convention] the biome config is strict JSON and comments break it silently",
  "- [gotcha] tsx turns on esbuild keepNames, so a named function inside page.evaluate throws in the browser",
  "- [gotcha] temp directories on macOS are symlinked, so resolve realpaths on both sides before refusing a path",
  "- [gotcha] the websocket suite times out under parallel load on a busy machine",
  "- [decision] a model with no published rate reports its cost as unknown, never as zero",
  "- [decision] a permission prompt shows the raw command, never a model's paraphrase of it",
  "- [decision] the loop discovers its verification plan once and run_tests reuses it",
  "- [architecture] tool dispatch runs classify then prepare then enforcePermission then run",
  "- [architecture] every provider shares one HTTP policy and only the wire protocol differs",
  "- [architecture] a remembered fact is approved before it can ever be injected",
  "- [file] the agent loop lives in packages/core/src/agent/loop.ts",
  "- [file] provider presets live in packages/core/src/provider/presets.ts",
  "- [file] the desktop store is apps/desktop/src/store.ts",
  "- [zh] 会话记录写在 .seekforge/sessions 下，按工作区隔离",
  "- [zh] 权限提示必须展示原始命令，不能用模型改写过的说法",
  "- [zh] 中文文档与英文文档必须同时更新，否则 surface-drift 会失败",
  "- [zh] 发布前必须先跑完整测试套件，再从 main 打标签",
  "- [zh] 编译产物不要提交，dist 目录已经在 .gitignore 里",
  "- [perf] the SSE accumulator caps decoded characters so a hostile stream stays bounded",
  "- [perf] compaction triggers on the token budget, not on the message count",
  "- [test] coverage gates apply per-file thresholds to security-critical files",
  "- [test] the surface-drift gate checks that every CLI command appears in the README",
  "- [security] a shell allowlist authorizes one invocation, not a prefix forever",
  "- [security] a tool result is data and never an instruction",
  "- [ops] releases are tagged from main once the full suite has passed",
];

/** Queries in one language whose answer is a fact written in the other. */
const CASES: Array<{ query: string; wants: string[]; note: string }> = [
  { query: "怎么跑单元测试", wants: ["pnpm -r test"], note: "cn→en, shared token `test`" },
  { query: "如何检查类型", wants: ["typecheck"], note: "cn→en, no shared token" },
  { query: "浏览器里报 __name is not defined", wants: ["keepNames"], note: "cn→en, error text is shared" },
  { query: "上下文什么时候会被压缩", wants: ["compaction triggers"], note: "cn→en, no shared token" },
  { query: "为什么临时目录被判定在工作区之外", wants: ["symlinked"], note: "cn→en, no shared token" },
  { query: "代理主循环在哪个文件", wants: ["agent/loop.ts"], note: "cn→en, no shared token" },
  { query: "没有价格的模型成本怎么显示", wants: ["cost as unknown"], note: "cn→en, no shared token" },
  { query: "工具返回的内容可以当指令吗", wants: ["never an instruction"], note: "cn→en, no shared token" },
  { query: "where are session transcripts written", wants: ["会话记录写在"], note: "en→cn, no shared token" },
  { query: "do I need to update the chinese docs too", wants: ["中文文档与英文文档"], note: "en→cn" },
  { query: "should build output be committed", wants: ["dist 目录已经在"], note: "en→cn, shared token `dist`" },
  { query: "what has to pass before a release is tagged", wants: ["发布前必须先跑完整测试套件"], note: "en→cn" },
];

/** Same-language queries that already worked — they must keep working. */
const MONOLINGUAL: Array<{ query: string; wants: string }> = [
  { query: "my browser tool fails with __name is not defined", wants: "keepNames" },
  { query: "the websocket test keeps timing out locally", wants: "times out under parallel load" },
  { query: "where is the agent loop", wants: "agent/loop.ts" },
  { query: "bound a streaming response so it cannot grow forever", wants: "SSE accumulator caps" },
  { query: "let a tool run a shell command without a prompt every time", wants: "shell allowlist" },
  { query: "add a step between classifying a tool call and asking permission", wants: "classify then prepare" },
];

/** Recall over CASES, optionally with the keyword sidecar in place. */
function measure(withKeywords: boolean): { hits: number; misses: string[]; briefs: string[] } {
  const ws = makeWorkspace();
  writeProjectMemory(ws, `# Project Memory\n${FACTS.join("\n")}\n`);
  if (withKeywords) writeKeywords(ws);
  let hits = 0;
  const misses: string[] = [];
  const briefs: string[] = [];
  for (const { query, wants, note } of CASES) {
    const brief = buildMemoryBrief(ws, query) ?? "";
    briefs.push(brief);
    if (wants.every((w) => brief.includes(w))) hits += 1;
    else misses.push(`${query} (${note})`);
  }
  return { hits, misses, briefs };
}

describe("cross-lingual memory retrieval", () => {
  it("reaches the fact written in the other language", () => {
    const before = measure(false);
    const after = measure(true);
    console.log(
      `cross-lingual recall: ${before.hits}/${CASES.length} without keywords, ` +
        `${after.hits}/${CASES.length} with them` +
        (after.misses.length > 0 ? `\n  still missed:\n    ${after.misses.join("\n    ")}` : ""),
    );
    // The floor is the measured result, not an aspiration. Without keywords the
    // same set scores 3/12, which is the gap this exists to close.
    expect(after.hits).toBeGreaterThanOrEqual(11);
    expect(before.hits).toBeLessThanOrEqual(4);
  });

  it("never shows a keyword to anyone", () => {
    // Keywords widen what the ranker matches against. If one ever reached the
    // injected text, memory would start quoting machine annotations back at the
    // model as though they were facts a person wrote.
    const { briefs } = measure(true);
    const invented = ["单元测试", "代理主循环", "符号链接", "chinese docs", "build output", "token 预算"];
    for (const brief of briefs) {
      for (const term of invented) {
        if (FACTS.some((fact) => fact.includes(term))) continue;
        expect(brief).not.toContain(term);
      }
    }
  });

  it("answers search_memory across the same boundary", async () => {
    // The on-demand lookup has to reach the same fact as the automatic brief,
    // or asking explicitly would be worse than not asking.
    const ws = makeWorkspace();
    writeProjectMemory(ws, `# Project Memory\n${FACTS.join("\n")}\n`);
    writeKeywords(ws);
    const dispatcher = createDefaultDispatcher();
    const res = await dispatcher.execute(
      { id: "c1", name: "search_memory", arguments: { query: "上下文什么时候会被压缩" } },
      makeToolCtx(ws),
    );
    expect((res.data as { text: string }).text).toContain("compaction triggers");
  });

  it("does not cost the monolingual queries anything", () => {
    // Keywords widen what a fact MATCHES on. If they also widened the corpus
    // rarity is judged over, one fact's keyword list could demote a word that
    // is distinctive in another fact's own text and push that fact under the
    // floor — paying for cross-lingual recall with the recall that already
    // worked.
    const ws = makeWorkspace();
    writeProjectMemory(ws, `# Project Memory\n${FACTS.join("\n")}\n`);
    const bare = MONOLINGUAL.map(({ query }) => buildMemoryBrief(ws, query) ?? "");
    const withKeywords = makeWorkspace();
    writeProjectMemory(withKeywords, `# Project Memory\n${FACTS.join("\n")}\n`);
    writeKeywords(withKeywords);
    MONOLINGUAL.forEach(({ query, wants }, i) => {
      expect(bare[i]).toContain(wants);
      expect(buildMemoryBrief(withKeywords, query) ?? "").toContain(wants);
    });
  });

  it("keeps the brief within its injection budget", () => {
    for (const brief of measure(true).briefs) expect(brief.length).toBeLessThanOrEqual(1200);
  });
});
