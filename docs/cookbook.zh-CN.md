# 实用手册（Cookbook）

> [English](cookbook.md) | **简体中文**

面向具体任务的操作配方。每一节都是 **目标 → 步骤 → 提示** 的结构，只使用真实存在的命令和 flag。完整 flag 列表见 [CLI 参考](cli-reference.zh-CN.md)；配置键见 [Configuration](configuration.zh-CN.md)。

所有 CLI 命令都应在项目目录内执行。先运行一次 `seekforge init` 生成 `.seekforge/` 和 `AGENTS.md`，并确保已设置 API key（`DEEPSEEK_API_KEY` 环境变量，或 `seekforge config set apiKey sk-... --global`）。

---

## 修复一个失败的测试

**目标：** 把失败的测试交给 agent，让它一路推进到通过。

```bash
# One-shot: describe the task, auto-approve edits.
seekforge run "the test in src/parser.test.ts is failing — find the cause and fix it" -y

# Let the agent verify its own fix before finishing (self-run on the finish turn):
seekforge config set verifyCommand "pnpm test"   # see note below — not settable, edit file instead
```

`verifyCommand` **不能**通过 `config set` 设置——请直接写入用户级
`~/.seekforge/config.json`：

```json
{ "verifyCommand": "pnpm test" }
```

设置了 `verifyCommand` 后，循环会在收尾轮自动执行它，并把真实结果反馈给 agent（`autoVerify`，默认开启）。参见 [Configuration → verifyCommand](configuration.zh-CN.md#verifycommand)。

**提示：**
- 对于必须通过的硬性标准，优先使用自主循环（见下文），而不是单次 `run`。
- `@path` 标记可以把文件内容内联进任务描述，例如
  `seekforge run "explain @src/parser.ts and fix @src/parser.test.ts"`。

---

## 运行自主验证循环（run → verify → continue）

**目标：** 持续迭代，直到某个 shell 命令以退出码 0 结束。

CLI：

```bash
seekforge loop "make the failing suite pass" --verify "pnpm test"
seekforge loop "port the module to TS" --verify "pnpm build" --max-iters 12 --budget 1.50
seekforge loop "fix it in isolation" --verify "pnpm test" --worktree
```

`--verify <cmd>` 是**必填项**（其退出码 0 即成功标准）。`--max-iters` 默认为 8，上限 100。`--budget <usd>` 会在观测到的累计用量达到预算时停止后续工作；已经在途的 provider 请求可能使最终账单略高于预算。循环本身即是自主运行的（工作在 `acceptEdits` 模式）；`-y` 只是省去自动批准的提示信息。

验证命令通过共享的 shell 执行器运行，套用已配置的操作系统级沙箱，并在按下 `Ctrl-C` 或触发 TUI 的 Stop 操作时协作式停止。

TUI（`seekforge` 交互模式）：`/loop` 是多行命令——第一行是验证命令，后续各行是任务描述。

```
/loop pnpm test
make the failing suite pass without weakening any assertions
```

可选的 TUI 控制参数写在验证命令之前：

```text
/loop --max-iterations 12 --budget 1.50 pnpm test
make the failing suite pass without weakening any assertions
```

**提示：**
- 一旦某次 agent 迭代创建了会话，循环在停止或耗尽额度时会保留其追踪记录（trace）。编排状态始终会被持久化；用 `seekforge loop-resume <loop-id>` 可以带着之前的会话、花费和剩余迭代次数继续。`--worktree` 检出目录会被保留，恢复时必须在该目录内执行。参见 [Loop engineering](loop-engineering.zh-CN.md)。
- 用 `loop-resume --add-iters 4 --add-budget 0.50 <loop-id>` 可以在不重置历史的情况下追加额度。用 `loop-list`、`loop-show`、`loop-delete` 管理记录。
- 用 `loop-cleanup <name>` 删除保留下来的 Loop worktree。有未提交改动（dirty）的 worktree 需要加 `--force`。

---

## 跨文件重构

**目标：** 一次多文件改动，用更强的模型，并先出计划。

```bash
# Plan read-only, confirm, then execute in the same session:
seekforge run "extract the retry logic into a shared module and update all callers" --plan -y

# Use a stronger model just for this run:
seekforge run "rename the User type to Account everywhere" -m deepseek-v4-pro -y
```

**提示：**
- 对既有文件的编辑都经过 `apply_patch`（逐字的 search/replace）；补丁失败时 agent 会重新读取文件。
- 在配置中设置 `planModel`，可让 `/plan` 和 `--plan` 在同一 endpoint 上升级到更强的模型。参见 [Configuration → planModel](configuration.zh-CN.md#planmodel)。
- 在 TUI 中用 `/plan <task>` 可获得同样的“计划-确认-执行”流程。

---

## 审查一份 diff

**目标：** 对未提交的改动做一次只读审查。

TUI：

```
/diff       # show the working-tree diff
/review     # read-only review of the uncommitted changes
```

CLI：

```bash
seekforge diff                       # raw git diff
seekforge ask "review my uncommitted changes for bugs and edge cases"
```

`ask` 是只读问答——不写文件，不执行命令。

**提示：**
- `finalizeReview`（配置项，默认关闭）会让编辑型运行在结束前审查自己的 diff，并在可用时调度内置的 `reviewer` 子 agent。参见 [Configuration → finalizeReview](configuration.zh-CN.md#finalizereview)。

---

## 导出会话审计

**目标：** 生成一份可供审阅的报告，记录 agent 做了什么（提示词、工具调用、改动的文件、成本）。过程完全确定性——只读取存储的追踪记录，不调用模型。

```bash
seekforge sessions                       # find the session id
seekforge audit <session-id>             # markdown report to stdout
seekforge audit <session-id> -o audit.md # write to a file
seekforge audit <session-id> --json      # raw SessionAudit JSON
```

TUI：`/audit [sessionId]` 会为当前（或指定）会话写出审计报告。

**提示：**
- `seekforge replay <session-id>` 会把整个会话重新渲染到终端；`seekforge rewind <session-id>` 撤销某个会话的文件改动（建议先 `--dry-run`）。

---

## 在隔离的 worktree 中工作

**目标：** 让 agent 在一个可随时丢弃的 git 检出中工作，不碰你当前的工作树。

TUI：

```
/worktree list
/worktree new [name]        # git worktree add under .seekforge/worktrees/<slug>, branch seekforge/<slug>
/worktree remove <slug>
```

每个 worktree 都是货真价实的 `git worktree`，位于 `.seekforge/worktrees/` 下、使用独立的 `seekforge/<slug>` 分支，并通过仓库的 `info/exclude` 忽略。

**提示：**
- 用 worktree 并行做多个实验；完成后合并或删除分支。`/tab new` 可在同一工作树内打开并行会话。

---

## 配置一个 MCP 服务器

**目标：** 通过 Model Context Protocol 向 agent 暴露额外工具。

```bash
# Add a stdio server (everything after the name is the literal spawn command):
seekforge mcp add filesystem npx -y @modelcontextprotocol/server-filesystem .
seekforge mcp add -g fs npx -y @scope/server .    # -g = user config, all projects

seekforge mcp list --tools    # list servers and the tools they expose
seekforge mcp remove filesystem
```

HTTP（Streamable）服务器可在任一层声明，但受信任服务器必须加入
`~/.seekforge/config.json` 的 `mcpServers`——参见 [Configuration → mcpServers](configuration.zh-CN.md#mcpservers) 和 [MCP 指南](mcp.zh-CN.md)。在 TUI 中，`/mcp` 列出服务器，`/prompts` 列出 MCP prompt（以 `/mcp:<server>:<prompt>` 形式调用）。

**提示：**
- SeekForge 自己也可以*作为* MCP 服务器运行：`seekforge mcp-serve`（默认只暴露只读工具；对受信任的调用方可加 `--allow-write`）。

---

## 创建一个 skill

**目标：** 把可复用的操作流程打包，让 agent 按需加载。

```bash
seekforge skill create my-procedure     # scaffolds .seekforge/skills/my-procedure/
seekforge skill list                    # project > global > builtin
seekforge skill show my-procedure
seekforge skill import ./path/to/SKILL.md    # import Claude-style skill (-g global, -f force)
seekforge skill enable|disable|remove <id>
```

Skill 在 `SKILL.md` 中携带 YAML frontmatter；循环会按任务自动挑选相关的 skill。TUI：`/skills` 列出已安装的 skill。

**提示：** skill 的格式与选择逻辑见 `packages/core/src/skills/`。

---

## 维护项目记忆

**目标：** 保存持久的项目事实，且由人工把关。

TUI：

```
/remember <fact>        # save a fact to project memory (# <fact> also works)
/memory                 # list project memory facts
/memory candidates      # review pending auto-extracted candidates
```

CLI：

```bash
seekforge memory list                    # project.md + pending candidates
seekforge memory add "build with: pnpm -w build" --type command
seekforge memory approve <candidate-id>  # mc-... id; --user for user memory
seekforge memory reject <candidate-id>
seekforge memory stats                   # extraction-quality stats
seekforge memory compact --dry-run       # collapse duplicates deterministically
```

自动提取的事实会一直处于**待定（pending）**状态，直到你批准——除非设置了 `memoryAutoApproveConfidence`。参见 [Configuration → memoryAutoApproveConfidence](configuration.zh-CN.md#memoryautoapproveconfidence)。

**提示：** `--type` 取值为 `command | path | convention | tech | task_pattern` 之一。

---

## 配置非 DeepSeek 提供方（Ark）并保留成本追踪

**目标：** 把 SeekForge 指向火山引擎 Ark（OpenAI 兼容），同时保留成本追踪。

```bash
export ARK_API_KEY="…"
seekforge config set provider ark --global
seekforge config set model glm-5.2
```

Ark 会禁用 DeepSeek 独有的行为（thinking body、cache-hit token、内置定价、余额查询）。除非提供 `modelPricing`，否则上报的成本始终为 `0`。请直接写入
`~/.seekforge/config.json`（不能通过 `config set` 设置）：

```json
{
  "provider": "ark",
  "model": "glm-5.2",
  "modelPricing": {
    "glm-5.2": {
      "inputCacheMissPer1M": 0.00,
      "inputCacheHitPer1M": 0.00,
      "outputPer1M": 0.00
    }
  }
}
```

填入提供方给出的真实每百万 token 价格。列在 `modelPricing` 中的模型总是会被计价，从而重新启用 `maxCostUsd` 预算追踪。参见 [Configuration → Ark](configuration.zh-CN.md#火山引擎-arkopenai-兼容) 和 [modelPricing](configuration.zh-CN.md#modelpricing在其他-provider-上开启成本跟踪)。

**提示：** `seekforge models` 列出 DeepSeek 模型及定价；`seekforge doctor` 检查你的 key 和环境。
