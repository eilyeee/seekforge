# SeekForge

> [English](README.md) | **简体中文**

**由 DeepSeek 驱动的本地优先编码 agent。**

SeekForge 是面向真实项目的编码 agent：它阅读你的代码库、理解任务、规划改动、
编辑文件、运行验证、失败后继续修复，最终给出一份可审阅的 diff，附带摘要与
token/费用统计。

```bash
cd your-project
seekforge run "修复登录按钮点击无响应的问题"
```

```txt
session 20260610T110258-c1pbi7
· skills: bugfix
→ search_text {"pattern":"login.*button"}
✓ search_text
→ read_file {"path":"src/components/LoginButton.vue"}
✓ read_file
→ apply_patch {"path":"src/components/LoginButton.vue", ...}
✓ apply_patch
● changed src/components/LoginButton.vue
→ run_command {"command":"pnpm test"}
✓ run_command
...
Tokens: 38.7K prompt (33.2K cache hit) / 6.1K completion   Cost: $0.0124
```

## 当前状态

✅ **第一步 — CLI**（现已可用）：带上下文压缩的 agent 循环、沙箱化工具、
五级权限策略、会话恢复、流式输出、技能（skills）、可审阅的项目记忆、
可选的 Rust 执行后端。

✅ **第二步 — 多形态**（0.7.0）：`seekforge-tui` 是对齐 Claude Code 的完整
终端 UI；`seekforge serve` 提供本地 Web 工作台（React）及 Tauri 桌面壳；
子代理（subagents）、自我进化与评测系统均已就绪。当前重点：真实场景打磨
（dogfooding、评测扩容）。下一阶段的缺口与优先级见
[docs/roadmap.zh-CN.md](docs/roadmap.zh-CN.md)。

## 安装与配置

```bash
# 从 npm 安装（CLI）
npm install -g seekforge

# 或从源码
git clone https://github.com/eilyeee/seekforge && cd seekforge
pnpm install && pnpm typecheck && pnpm test

# 配置 DeepSeek API key（任选其一）：
seekforge config set apiKey sk-... --global     # ~/.seekforge/config.json (0600)
export DEEPSEEK_API_KEY=sk-...
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `seekforge` | **交互会话**（REPL）：多轮对话，`/help` 查看斜杠命令（`/new` `/sessions` `/resume` `/model` `/usage`） |
| `seekforge completion bash\|zsh` | 输出静态 shell 补全脚本，source 进你的 rc 文件 |
| `seekforge-tui` | **终端 UI**（Ink）：对齐 Claude Code 的日常主力——命令面板 + 参数选择器、vim 模式、转向队列、运行后台化（Ctrl+B）、逐轮回退带文件恢复、思维显示、可选 OS 沙箱、HTTP MCP、自定义命令与技能斜杠化；完整列表见 [apps/tui/README.md](apps/tui/README.md) |
| `seekforge serve [paths...] [--port 7373]` | 本地 Web UI + agent API；可传多个工作区路径一起托管（仅 127.0.0.1，token 保护） |
| `seekforge run "<task>"` | 执行一个开发任务；`-y` 自动批准安全的写入/命令，`-m` 覆盖模型，`--json` 输出 JSONL 事件供 CI 使用，`--plan` 先只读规划、确认后执行。更多 flag：[`--permission-mode`、`--output-style`、`--fallback-model`、`--settings`、`--system-prompt`、`--append-system-prompt`、`--allowedTools`、`--disallowedTools`、`--add-dir`、`--verbose`](docs/cli-reference.zh-CN.md) |
| `seekforge ask "<question>"` | 只读问答（禁用写入与命令）；支持 `--add-dir`、`--settings`、`--verbose` 及[大部分 run flag](docs/cli-reference.zh-CN.md) |
| `seekforge models` | 列出可用的 DeepSeek 模型、定价（缓存未命中/命中、每 1M token 输出）、默认模型（`deepseek-v4-flash`）与已弃用条目 |
| `seekforge resume <session-id> [task]` | 携带完整历史继续一个会话（保持其 ask/edit 模式） |
| `seekforge sessions` | 列出会话及其状态与费用（子代理运行不显示） |
| `seekforge sessions prune [--older-than <days>] [--keep-last <n>] [--dry-run]` | 删除旧会话 trace，控制 `.seekforge/sessions/` 体积 |
| `seekforge rewind [session-id] [--dry-run]` | 撤销某会话的全部文件改动（写前检查点） |
| `seekforge memory add "<fact>" [--type] [--pending]` / `remove <n\|id\|text>` | 直接告诉 agent 一条事实（REPL：`/remember <fact>`） |
| `seekforge status` | 项目 / 配置 / 最近会话概览 |
| `seekforge update` | 检查 npm 上的新版本并打印安装命令 |
| `seekforge diff` | 显示当前 git diff |
| `seekforge doctor` | 环境诊断（api key、node、git、runtime、mcp、编辑器、剪贴板） |
| `seekforge resolve <issue> --max-cost <usd>` | 在隔离 worktree 中修复一个 GitHub issue 并开草稿 PR；支持 `--wait-ci` 与 `--dry-run`——见 [GitHub 工作流](docs/github.zh-CN.md) |
| `seekforge resolve-review <pr> --max-cost <usd>` | 处理 PR 评审中可执行的反馈，验证、提交并推送修复 |
| `seekforge schedule add\|list\|run\|next\|history\|install\|uninstall\|status` | 管理定时任务、历史、重试与 crontab tick——见[定时任务](docs/scheduling.zh-CN.md) |
| `seekforge sandbox-run "<task>"` | 通过 Docker runner 契约执行任务——见[远程执行](docs/remote.zh-CN.md) |
| `seekforge evolve analyze\|list\|show\|accept\|reject\|apply` | 会话打分与自我进化提案审阅（人工把关） |

VS Code 用户可以使用 [`apps/vscode`](apps/vscode/README.md) 中的轻量本地扩展。
它复用 `seekforge serve`，支持任务、会话续接、权限提示、问题回答、diff 查看与
当前文件上下文。
| `seekforge security scan\|list\|show\|status\|fix\|verify\|threat-model\|export` | 深度仓库安全审查、Finding 队列/生命周期、经验证的修复、威胁建模、JSON/Markdown/SARIF 证据导出——见[安全扫描](docs/security-scanning.zh-CN.md) |
| `seekforge init` | 脚手架生成 `.seekforge/` 与 `AGENTS.md` 模板 |
| `seekforge mcp add\|list\|remove <name>` | 管理配置中的 MCP server（列出、添加 stdio server、移除）——见 [docs/mcp.zh-CN.md](docs/mcp.zh-CN.md) |
| `seekforge mcp-serve [--allow-write]` | 把 SeekForge 作为 MCP server 跑在 stdio 上（默认只读工具集）；`--allow-write` 暴露写工具（仅限受信调用方） |
| `seekforge skill list\|show\|create\|enable\|disable <id>` | 流程技能（项目 > 全局 > 内置）；enable/disable 开关技能 |
| `seekforge skill import <path> [-g] [-f]` | 导入 Claude 风格的 SKILL.md（YAML frontmatter）为项目或全局技能 |
| `seekforge agent list\|show <id>\|import <path>` | 管理子代理；主 agent 通过 `dispatch_agent` 委派有边界的子任务 |
| `seekforge memory list\|approve <id>\|reject <id>` | 审阅提取的事实进入长期项目记忆 |
| `seekforge memory compact [--dry-run] [--prune-unused <days>]` | 合并 project.md 中的重复/近重复事实（确定性）；`--prune-unused` 需要非负整数，把超过 `<days>` 天未使用的事实归档到 `project-archive.md` |
| `seekforge memory stats` | 打印记忆提取质量统计——已批准/待定/已拒绝数量、使用率、拒绝率（只读）；调整 `memoryAutoApproveConfidence` 前先看这个 |
| `seekforge config show\|set <key> <value> [-g]` | `set` 接受标量/数组键：`apiKey`、`model`、`baseUrl`、`provider`、`runtimeBin`、`commandAllowlist`、`models`、`sandbox`、`thinking` / `reasoningEffort`、`compaction`。结构化键（`permissionRules`、`hooks`、`mcpServers`、`planModel`）**直接编辑 `.seekforge/config.json`**——不经 `config set`。配置层级：环境变量 > CLI flag > [`--settings <file>`](docs/cli-reference.zh-CN.md#settings-layering) > 个人 `.seekforge/config.local.json` > 项目 `.seekforge/config.json` > 全局 `~/.seekforge/config.json`。完整参考：[docs/configuration.zh-CN.md](docs/configuration.zh-CN.md) |

无头单次运行 `seekforge -p "<prompt>"` 接受与 `seekforge run` 相同的 flag，
外加 `--ask`、`--input-format`（text | stream-json），
[完整列表见此](docs/cli-reference.zh-CN.md)。

`Ctrl+C` 协作式取消运行中的会话（trace 保留，`seekforge resume` 可接续）；
再按一次 `Ctrl+C` 强制退出。任务中的 `@path` 标记会内联该文件内容
（敏感文件除外）。agent 还可以：发布实时计划清单（`update_plan`）、提交
自己的工作（`git_commit`——push 不可能发生）、抓取公开文档页面
（`web_fetch`——每个 URL 都需显式确认；私有地址一律拒绝）。

## 桌面工作台

`seekforge serve` 打开一个本地、token 保护的 Web 工作台（React）——仅监听
`127.0.0.1`——Tauri 壳把它包装为原生 macOS 应用。它驱动与 CLI **完全相同**的
agent/API，采用浅色 Codex 风格 UI（深色可选；语言跟随 en / zh-CN），所有
界面集中在一个窗口：

- **聊天** — 多标签会话，带主页（快捷操作 + 最近会话/技能/子代理）、流式
  工具运行与子代理卡片（可定向引导/取消）、逐 hunk diff 批准、计划执行，
  以及支持 `@` 文件引用、`/` 命令、图片粘贴/附加和思考开关的输入框。
- **会话 · 改动 · 技能 · 子代理 · 记忆 · 进化 · 设置** — 恢复会话、审阅
  工作树 diff、开关技能、查看子代理、批准记忆候选、把关自我进化提案、
  编辑配置（模型列表、沙箱、主题、语言……）。
- **待办** — 基于 `.seekforge/todos.md` 的侧边面板。

```bash
seekforge serve                                     # 在浏览器打开打印出的 URL
pnpm --filter @seekforge/desktop build && pnpm tauri dev   # 或原生应用（开发）
```

打包出的 DMG 是自包含的——server 作为 sidecar 内嵌，只安装 DMG 的用户
**不需要**系统里装 `seekforge`。`tauri dev`（无打包）下回退到 PATH 上的
`seekforge` 或仓库的 tsx runner。见
[apps/desktop/src-tauri/README.md](apps/desktop/src-tauri/README.md)。

## 持续 Agent 评测

评测系统支持带版本的 smoke/nightly/release 套件、有界多采样运行、确定性
任务检查、任务级回归对比、质量/费用/token/可靠性门槛、运行元数据，以及
Markdown/JSON/JUnit 报告。每周的 workflow 用 nightly 套件对照已提交的基线
运行；见[评测与回归门槛](docs/EVALS.zh-CN.md)。

## 工作原理

- **大仓库的代码导航**：`repo_map` 给出紧凑的结构概览（大仓库自动注入），
  `find_definition` 跳转到符号定义处。符号提取是混合式的——tree-sitter
  （精确，支持 JS/TS、Python、Java、Rust、Go、C/C++、C#）加上无依赖的
  正则兜底；tree-sitter 是**可选**依赖。
- **任务相关检索**：会话开始时循环还会注入一份按「路径/导出与*本次*任务
  匹配程度」排序的文件清单（支持 CJK）——作为通用概览和 `search_text`
  之外的起点。
- **完成时验证与评审（可选）**：设置了 `verifyCommand` 后，循环在完成时
  自动运行它并把失败喂回去修复；开启 `finalizeReview` 后，会对 diff 派出
  一个只读**评审**子代理。
- **编辑是 search/replace 补丁**（`oldString` 必须唯一匹配），原子应用——
  对 LLM 而言远比 unified diff 可靠。当 `apply_patch` 包含**多个编辑**时，
  权限提示支持逐 hunk 选择（CLI 中逐个批准/拒绝，TUI 复选框，桌面弹窗）。
  单编辑调用保持整体通过/拒绝。
- **上下文管理器**让长会话保持在模型窗口内：微压缩先清理旧工具输出，然后
  把对话中段折叠成摘要——机械式，或配 `"compaction": "llm"` 用模型总结
  （失败时回退机械式）。prompt 前缀保持稳定以命中 DeepSeek 上下文缓存
  （缓存命中的输入约便宜 10 倍；CLI 会显示命中率）。
- **DeepSeek V4 思考**：`deepseek-v4-flash` / `deepseek-v4-pro` 把推理与
  工具调用结合——用 `/think on|off|high|max` 或 `thinking` /
  `reasoningEffort` 配置键控制；流式推理渲染为可折叠的思维块，且永不回传
  进请求。
- **OS 沙箱（可选）**：`"sandbox": "read-only" | "workspace-write" | "restricted"`
  用 seatbelt（macOS）/ bwrap（Linux）包裹命令；`read-only` 保护工作区，
  `restricted` 再切断网络。请求了但不可用时硬失败——绝不静默降级为无沙箱。
  疑似沙箱拒绝的失败会询问一次后再无沙箱重试。
- **Hook** 在 9 个阶段触发（preToolUse、postToolUse、sessionStart、
  userPromptSubmit、preCompact、stop、subagentStop、notification、
  sessionEnd）；userPromptSubmit 的 stdout 注入任务作为上下文，preToolUse
  可带理由拦截工具或直接放行。
- **MCP 客户端**支持 stdio 与 streamable HTTP（`url` + 可选 bearer
  `headers`）；server 资源可列出，`@mcp:<server>:<uri>` 把资源内联进消息。
  SeekForge 也能*作为* MCP server 运行（`seekforge mcp-serve`）。完整指南：
  [docs/mcp.zh-CN.md](docs/mcp.zh-CN.md)。
- **`ask_user`**：agent 可以在运行中途问你一个选择题（子代理和后台运行
  永远不可用，因此不会阻塞）。
- **技能（skills）**是流程简报（绝非权限），按规则匹配为每个任务选择；
  在 `.seekforge/skills/<id>/` 放置你自己的技能。
- **子代理**（内置 `explorer`/`reviewer`，加上 `.seekforge/agents/<id>/`
  中的 `AGENT.md` 或导入的 Claude/Meta_Kim 风格定义）让主 agent 通过
  `dispatch_agent` 委派有边界的子任务——同一轮内可并行、可后台
  （`agent_result` 轮询）、事后可续（`agent_send`）。每个子代理有自己的
  prompt、工具白名单、可选模型和轮次预算；治理/评审类 agent 只读。只读
  （`ask`/`--plan`）会话不能派出 edit agent。
- **权限规则**：配置里的 `permissionRules` 按工具添加 allow/deny 条目，
  支持命令/路径前缀；deny 永远优先。规则文件按
  `~/.seekforge/AGENTS.md` → `AGENTS.md` → `AGENTS.local.md` 合并。
- **记忆**：每个 edit 会话结束后用一次额外模型调用蒸馏持久事实作为
  *候选*；在你 `seekforge memory approve` 之前，任何内容都不会进入长期
  记忆（`.seekforge/memory/project.md`）。相关记忆以简报形式注入后续
  会话，agent 也可用只读的 `search_memory` 工具按需检索。用
  `seekforge memory stats` 检查提取质量；设置
  `memoryAutoApproveConfidence` 自动批准高置信度事实。
- **会话**是 `.seekforge/sessions/<id>/` 下的 JSONL trace——消息、工具
  调用和事件全部可审计。

## 安全模型

- 5 级权限：只读自动运行；写入询问（除非 `-y`）；非放行清单命令询问；
  依赖安装始终询问；危险命令（`rm -rf`、`sudo`、`git push`、管道到
  shell、`bash -c`……）始终拒绝。
- 权限提示展示**原始命令/路径**，绝不用模型的转述。多编辑的 `apply_patch`
  展示逐 hunk 预览，可逐个批准/拒绝（CLI：`Pick hunks (e.g. 0,2)`；
  TUI/桌面：逐 hunk 复选框）。单编辑调用保持整体通过/拒绝。
- 工作区沙箱（realpath 包含检查、符号链接逃逸检查）；`.env`/`*.pem`/SSH
  密钥不可读；输出中的机密会被脱敏。
- 工具结果被当作数据而非指令（提示注入防御），记忆候选经过滤和人工审阅
  才会持久化。

默认情况下这是**你已信任的项目内的误用防护**——任何项目命令（如
`npm test`）都会运行该项目的代码。需要 OS 级隔离时，启用沙箱
（`"sandbox": "read-only" | "workspace-write" | "restricted"`，
seatbelt/bwrap；见上文）。

## Rust 执行后端（可选）

TypeScript 调度器可把文件/命令/git 执行委托给一个小型受信 Rust 二进制，
后者会复查包含性与命令拒绝清单（纵深防御）。权限决策始终留在 TypeScript。

```bash
cargo build --release
seekforge config set runtimeBin target/release/seekforge-runtime
```

协议：[`crates/runtime/PROTOCOL.md`](crates/runtime/PROTOCOL.md)。

## 已知限制

- `deepseek-reasoner` 不能作为 agent 模型（无函数调用；provider 里有文本
  回退协议但未接入循环）。请使用 DeepSeek V4 模型——它们把思考与工具
  调用结合。
- 仅支持 macOS / Linux。

## Monorepo 结构

```txt
apps/cli              seekforge CLI（发布到 npm）
apps/tui              seekforge-tui — Ink 终端 UI（随 npm 包发布）
apps/server           seekforge serve — 本地 agent server + Web 工作台
apps/desktop          Tauri 桌面壳
apps/vscode           基于 seekforge serve 的轻量 VS Code 客户端
packages/core         agent 循环、provider、工具、记忆、技能、runtime 客户端
packages/shared       跨端纯类型
packages/eval-harness 评测运行器（pnpm eval）
crates/runtime        seekforge-runtime（Rust 执行后端）
evals/                评测任务、fixture、基线
examples/             端到端验证用的 fixture 项目
```

开发：`pnpm install`、`pnpm typecheck`、`pnpm test`（TS），
`cargo test`（Rust）。约定见 [AGENTS.md](AGENTS.md)。

## 免责声明

SeekForge 是独立项目，**与 DeepSeek 无隶属、背书或赞助关系**。提及
"DeepSeek" 仅为说明本工具使用的底层模型 API。

## 许可证

[MIT](./LICENSE)
