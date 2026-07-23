# 配置

> [English](configuration.md) | **简体中文**

SeekForge 从全局与仓库配置层读取设置，并支持通过环境变量、CLI 标志和
`--settings` 文件覆盖。所有配置键都是可选的——只要有一个 API key，
工具开箱即用。

## 文件位置

| 位置 | 路径 | 由谁创建 |
| --- | --- | --- |
| **全局** | `~/.seekforge/config.json` | `seekforge config set <key> <value> --global` |
| **项目** | `<project>/.seekforge/config.json` | `seekforge config set <safe-key> <value>`（不带标志） |

两者都是纯 JSON。无论是否使用 `--global`，`seekforge config set` 都以 `0o600`
权限（仅用户可读）写入。项目配置与 SeekForge 在 `.seekforge/` 下管理的
会话 trace、记忆和技能放在一起。

每个配置文件必须包含一个 JSON 对象。`null`、`42`、`[]` 之类合法的 JSON
标量和数组都是无效的配置层：SeekForge 会忽略该层而不是崩溃，并且
`seekforge doctor` / TUI 的 `/doctor` 会报告其路径。`permissionRules`、
`mcpServers`、`hooks` 的容器形态不正确时同样会被忽略；畸形的权限规则条目和
hook 条目会被过滤掉，而低优先级层中的有效值仍然生效。

### 信任边界

项目文件属于仓库输入，包括 `.seekforge/config.json`、
`.seekforge/config.local.json` 以及两者声明的 profile。它们可以设置普通偏好
（`model`、`models`、`compaction`、`thinking`、`reasoningEffort`、
`planModel`、`editFormat`、UI 偏好及类似的非授权字段）、添加 `deny` 权限规则，
以及声明供显式检查的未信任 MCP 服务器。

它们不能提供凭据或凭据目的地（`apiKey`、`provider`、`baseUrl`），不能执行
启动/运行时命令（`runtimeBin`、hook、`statusLine`、`lintCommand`、
`verifyCommand`），不能自动授权操作（`commandAllowlist`、`allow` 权限规则、
MCP `trusted`），也不能削弱 sandbox、提高消费上限、自动批准记忆或改变审计保留策略。
自动记忆整理也属于用户级设置，因为它可以归档项目事实。这些设置必须来自
`~/.seekforge/config.json`、环境变量或用户显式选择的 `--settings` 文件。
项目 MCP 定义仍然可见，也可通过显式管理操作测试；但只有完整条目来自用户配置时，
`trusted: true` 才会生效。

---

## 配置键

所有键都属于 `CliConfig` 类型（`apps/cli/src/config.ts`）。

### `apiKey`

DeepSeek API key。优先使用 `DEEPSEEK_API_KEY` 环境变量，让密钥不落盘——
但为了方便，`config set` 也接受它。

```json
{ "apiKey": "sk-..." }
```

可通过 `config set` 设置？**可以，但必须带 `--global`**。
`config show` 显示时，该值会被脱敏为仅前 6 个字符。

### `model`

使用的 DeepSeek 模型。默认为 `deepseek-v4-flash`。

```json
{ "model": "deepseek-v4-pro" }
```

可通过 `config set` 设置？**可以**。
也可以在单次运行中用 `--model` / `-m` 覆盖。

### `baseUrl`

自定义 API 基础 URL，用于 DeepSeek 兼容代理或自托管端点。

```json
{ "baseUrl": "https://api.deepseek.com/v1" }
```

可通过 `config set` 设置？**可以，但必须带 `--global`**。

### `provider`

命名的 provider 预设。一次切换即同时选定 API 基础 URL **和**一套能力集。
`"deepseek"`（未设置时的默认值）指向 DeepSeek 直连，所有特性开启。
`"ark"` 指向火山引擎 Ark，一个 OpenAI 兼容端点（见下节）。显式的 `baseUrl`
总是优先于预设的 URL，因此你可以在保留某个预设能力配置的同时，
把它指向一个代理。

```json
{ "provider": "ark" }
```

不设置 `provider` 时行为与以前完全一致（完整的 DeepSeek 行为）。

可通过 `config set` 设置？**可以，但必须带 `--global`**。

### 火山引擎 Ark（OpenAI 兼容）

Ark 是一个 OpenAI 兼容端点。使用方法：

1. 在配置中设置 `provider: "ark"`（这会选定 Ark 基础 URL
   `https://ark.cn-beijing.volces.com/api/plan/v3` 和 Ark 能力配置）。
   也可以自己设置 `baseUrl` —— 当 `provider` 为 `"ark"` 时，`ark` 预设的
   能力集仍然生效，而显式的 `baseUrl` 会覆盖预设的 URL。
2. 通过 `ARK_API_KEY` 环境变量（推荐）或 `apiKey` 配置字段提供密钥。
   两者都设置时，`ARK_API_KEY` 优先于 `DEEPSEEK_API_KEY`。
3. 从 Ark 的目录中选择一个 `model`：
   - `doubao-seed-2.0-code`、`doubao-seed-2.0-pro`、`doubao-seed-2.0-lite`、
     `doubao-seed-2.0-mini`
   - `glm-5.2`
   - `kimi-k2.7-code`、`kimi-k2.6`
   - `deepseek-v4-pro`、`deepseek-v4-flash`
   - `minimax-m3`、`minimax-m2.7`

```json
{ "provider": "ark", "model": "glm-5.2" }
```

```bash
export ARK_API_KEY="…"
seekforge config set provider ark --global
seekforge config set model glm-5.2
```

由于 Ark 是 OpenAI 兼容端点，此预设下 DeepSeek 专有的行为会被禁用：
不发送 DeepSeek 的 `thinking` 请求参数，不读取上下文缓存命中 token，
并关闭成本/余额核算（成本报告为 `0`，也不查询 `/user/balance` 端点）。

### `runtimeBin`

`seekforge-runtime` 二进制文件（Rust 执行后端）的路径。设置后，文件 I/O、
命令执行和 git 操作会委托给一个可信的 Rust 二进制，进行纵深防御式的
包含关系复查。权限决策仍留在 TypeScript 中。

```json
{ "runtimeBin": "/usr/local/bin/seekforge-runtime" }
```

也从 `SEEKFORGE_RUNTIME_BIN` 环境变量读取（优先级最高）。

可通过 `config set` 设置？**可以，但必须带 `--global`**。

### `commandAllowlist`

允许免确认自动运行的命令前缀数组（在内置安全命令之外）。常见用法是
放行 `pnpm test` 或 `cargo build`，让 agent 运行它们时不再询问。

前缀只作用于单次 shell 调用。未加引号的 shell 控制语法（`;`、`&&`、`||`、
管道、重定向、换行、反引号或 `$()`）会让整条命令失去自动批准资格，
即便其第一个命令匹配此列表。此时 SeekForge 走正常的确认流程，
并显示原始命令。

```json
{ "commandAllowlist": ["pnpm test", "cargo build", "npm run"] }
```

通过 `seekforge config set` 设置时，传入逗号分隔的字符串：

```bash
seekforge config set commandAllowlist "pnpm test, cargo build" --global
```

可通过 `config set` 设置？**可以，但必须带 `--global`**（以逗号分隔字符串形式）。

### `models`

桌面端/服务器端模型选择器（以及 TUI `/model` 参数补全）提供的可选模型列表。
一个普通的模型 ID 数组；第一项被视为默认建议。CLI 本身通过 `--model` /
`/model` 接受任意模型字符串，所以这个键主要影响选择器 UI —— 但它是共享配置，
设置一次即处处生效。

```json
{ "models": ["deepseek-v4-flash", "deepseek-v4-pro"] }
```

未设置时，服务器回退到内置的默认模型列表。

可通过 CLI `config set` 设置？**不可以**。可通过 Server/Desktop 设置界面配置。

### `sandbox`

操作系统级命令沙箱（sandbox）。未设置时，沙箱关闭。

| 值 | 行为 |
| --- | --- |
| `"off"`（或缺省） | 无沙箱；命令以当前用户身份运行。 |
| `"read-only"` | 命令在工作区只读的沙箱中运行（临时目录仍可写）。可访问网络。使用 `seatbelt`（macOS）或 `bwrap`（Linux）。 |
| `"workspace-write"` | 命令在允许写工作区目录的沙箱中运行。可访问网络。使用 `seatbelt`（macOS）或 `bwrap`（Linux）。 |
| `"restricted"` | 与 `workspace-write` 相同，但网络访问被阻断。 |

如果所请求的沙箱机制在运行时不可用，会话会直接失败——绝不会悄悄回退到
无沙箱执行。看起来像权限拒绝的沙箱失败会先询问一次，再以无沙箱方式重试。

```json
{ "sandbox": "workspace-write" }
```

可通过 `config set` 设置？**可以，但必须带 `--global`** —— 校验取值为 `off` / `read-only` /
`workspace-write` / `restricted`。

### `compaction`

上下文压缩（compaction）策略，让长会话保持在模型窗口之内。
微压缩（micro-compaction）先清理旧的工具输出；然后把对话中段折叠成摘要。

| 值 | 行为 |
| --- | --- |
| `"mechanical"`（默认） | 用固定提示词生成摘要——快速且确定。 |
| `"llm"` | 由模型自己做摘要（失败时回退到 mechanical）。更准确，但要花一次模型调用。 |

提示词前缀保持稳定，以命中 DeepSeek 的上下文缓存（缓存命中的输入
约便宜 10 倍）。

```json
{ "compaction": "llm" }
```

可通过 `config set` 设置？**可以** —— 校验取值为 `mechanical` / `llm`。

### `thinking`

控制 DeepSeek V4 思考模式。为 `true` 时，模型在一个可折叠的思考块中展示
推理过程（绝不会回传到请求中）。为 `false` 或缺省时，采用 API 默认行为。

在 REPL 中，`/think on|off|high|max` 可在运行时切换。

```json
{ "thinking": true }
```

可通过 `config set` 设置？**可以** —— 接受 `true` / `false`。

### `reasoningEffort`

V4 推理强度级别。仅在启用思考模式时有意义。

| 值 | 行为 |
| --- | --- |
| `"high"` | 标准推理深度。 |
| `"max"` | 最大推理深度——更彻底，但更慢也更贵。 |

```json
{ "reasoningEffort": "max" }
```

可通过 `config set` 设置？**可以** —— 校验取值为 `high` / `max`。

### `planModel`

用于规划运行（`/plan` / `--plan`）和失败升级的更强模型，与 `model`
在同一个 key/端点上解析（例如规划/升级用 `pro` 模型，编辑用 `flash` 模型）。

```json
{ "model": "deepseek-v4-flash", "planModel": "deepseek-v4-pro" }
```

`planModel` **必须支持工具/函数调用（tool/function calling）** —— 不要把它设为
`deepseek-reasoner`（不支持函数调用）。此时 agent 会回退到默认模型，
而不会破坏工具循环。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `escalateOnFailure`

**默认关闭。** 一旦模型在同一个失败的工具调用上原地打转，就把运行的剩余部分
交给 `planModel`（需要已设置 `planModel`）—— 只有在默认模型明显卡住时，
更强的模型才会接手，因此对正常进行的运行零开销。

```json
{ "planModel": "deepseek-v4-pro", "escalateOnFailure": true }
```

一个相关的**始终生效**的保护措施无需任何配置：如果一次工具调用以完全相同的
参数再次失败，harness 会注入一次性的反思提醒，告诉模型停止循环、重新阅读。

> 注：另外两个实验性开关（`autoReview`、`planFirst`）曾被原型验证并已
> **移除** —— 一次 eval A/B（`control` vs 它们）表明它们在每次编辑上都
> 降低质量、抬高成本，且没有把任何失败转化为通过。见 CHANGELOG 第 36 轮。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `maxCostUsd`

**默认关闭。** 以美元计的单次运行成本预算。累计成本达到该值后，运行经由
优雅取消路径停止（trace 会保留，因此可以 `resume`）。可被 CLI 标志
`--max-cost <usd>` 覆盖（该标志与 `-p` 也能配合使用）。未设置或非正数时关闭。
必须是数字——`"0.5"` 这样的字符串会被以清晰的错误拒绝，而不是在运行中途崩溃。

```json
{ "maxCostUsd": 0.5 }
```

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `modelPricing`（在其他 provider 上开启成本跟踪）

**默认关闭。** DeepSeek provider 自带内置价格表，所以成本和 `maxCostUsd`
预算开箱即用。其他 provider（`ark`、`openai`、`ollama`、`openrouter`……）
**没有**价格表，因此在这些 provider 上报告的成本恒为 `0`，`maxCostUsd`
也永远不会触发。设置 `modelPricing` 提供你自己的按模型费率，
即可为这些 provider 打开成本/预算跟踪。

它是一个**模型 id → 每 100 万 token 价格**的映射，单位美元：

```json
{
  "modelPricing": {
    "doubao-seed-2.0-pro": {
      "inputCacheMissPer1M": 0.00,
      "inputCacheHitPer1M": 0.00,
      "outputPer1M": 0.00
    }
  }
}
```

> 上面的数字是**占位符** —— 请从你的 provider 定价页面填入真实的每百万
> token 价格。`inputCacheMissPer1M` 是普通输入价格；`inputCacheHitPer1M`
> 只在会报告缓存命中输入 token 的 provider（DeepSeek）上有意义；
> `outputPer1M` 是输出（completion）价格。

列在这里的模型**始终**按你的费率计价——即便所在 provider 的预设禁用了
成本核算——因此其成本和预算跟踪都能工作。而这类 provider 上你没有列出的
模型仍保持 `0`。DeepSeek 的默认行为（不设 `modelPricing`）不变。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `verifyCommand`

**默认关闭。** 一条 shell 命令（如 `"npm test"`），**当运行编辑过文件、且自最后
一次编辑以来没有再运行过它**时，必须先通过它运行才能结束。默认情况下
（`autoVerify`，见下文），循环会**在收尾回合自动运行它**并把真实结果反馈回去：
通过则接受本次运行，失败则带着捕获的输出继续运行，让 agent 修复真正的原因。
该检查每次运行至多触发一次。

只有以退出码 `0` 结束的前台调用才能满足此门槛。后台命令，或退出码非零的
已完成命令，都不算通过验证。

```json
{ "verifyCommand": "pnpm test" }
```

> 坦诚说明：在早期的 eval A/B 中，*仅提醒*的形式在本来就会提示 agent 做验证
> 的任务集上**没有通过率收益，成本约 +10%**。改为自动运行（而不是指望模型
> 自己去跑）消除了「采纳缺口」，但它在真实任务上的净价值仍有待实际使用检验
> —— 因此是可选项，而非默认。对那些你*不会*叮嘱 agent 跑测试的工作流最有用。
> 直接编辑文件；不可通过 `config set` 设置。

### `autoVerify`

**默认开启**（仅在设置了 `verifyCommand` 时才有意义）。循环在收尾回合自己运行
`verifyCommand` 并把结果反馈回去。设为 `false` 则退化为一次性的**提醒**，
让模型自己去运行它——例如命令必须走模型的权限流程，或者在循环本身绝不应
直接执行 shell 的环境中。直接编辑文件；不可通过 `config set` 设置。

> 实测（见 [`evals/round-52-measurements.md`](../evals/round-52-measurements.md)）：
> 自动运行在一个测试套件失败的 fixture 上比仅提醒路径少用回合、便宜约 30%
> —— 这是它默认开启的原因。

### `lintCommand`

**默认关闭。** 一条 shell 命令（如 `"pnpm lint"`），作为**与 `verifyCommand`
并行的门槛**运行：**当运行编辑过文件、且自最后一次编辑以来没有再运行过它**时，
必须先通过它运行才能结束。默认情况下（`autoLint`，见下文），循环会**在收尾
回合自动运行它**并把真实结果反馈回去——通过则接受本次运行，失败则带着捕获的
lint 输出继续运行，让 agent 修复报告的问题。每次运行至多触发一次，只有在
出现*新的*编辑后才会再次触发（与 verify 的门控逻辑相同）。

与验证一样，只有以 `0` 退出的前台命令才能满足 lint 门槛。

```json
{ "lintCommand": "pnpm lint" }
```

直接编辑文件；不可通过 `config set` 设置。

### `autoLint`

**默认开启**（仅在设置了 `lintCommand` 时才有意义）。循环在收尾回合自己运行
`lintCommand` 并把结果反馈回去。设为 `false` 则退化为一次性的**提醒**，
让模型自己去运行它（与 `autoVerify` 对应）。直接编辑文件；不可通过
`config set` 设置。

### `editFormat`

**默认 `"patch"`。** 选择系统提示词中的编辑格式引导（仅是引导——无论选哪种，
`apply_patch` 和 `write_file` 都保持可用）：

- `"patch"`（默认）：引导 agent 使用 `apply_patch` 的搜索/替换编辑。
- `"whole"`：引导 agent 优先使用 `write_file`（重写**整个文件**）而非
  `apply_patch`。适用于**小模型/本地模型**（如小型 Ollama 模型）——它们常常
  写坏精确的搜索/替换块，整文件重写可以避免脆弱的精确匹配失败。

```json
{ "editFormat": "whole" }
```

直接编辑文件；不可通过 `config set` 设置。

### `finalizeReview`

**默认关闭。** 当 agent 在编辑过文件后收尾时，先对 diff 做一次最终评审再完成。
如果有 **reviewer** 专家代理可用（它是内置的；只要加载了子代理就存在），
循环会**派发它** —— 一双上下文全新、只读的「第二双眼睛」——并把它的发现反馈
给 agent 处理。没有接入 reviewer 时，退化为一次性的自我评审提醒。触发时
多花一个回合（或一次 reviewer 子运行）。直接编辑文件；不可通过 `config set`
设置。

> 实测（见 [`evals/round-52-measurements.md`](../evals/round-52-measurements.md)）：
> 在两个任务族上——包括一个特意构造的、朴素修复能过测试但留下隐藏边界情况
> 的 fixture ——评审在默认模型上增加了成本，却**没有**带来任何成功率或质量
> 提升（它本来就会不经提示写出健壮的代码）。因此是可选项。若换成确实会犯
> 朴素错误的较弱模型，值得重新评估。

### `guardNoProgress`

**默认关闭。** 过早收尾守卫：如果一次**编辑模式**运行在什么都没改、几乎没做
任何工具调用的情况下就宣布完成（没有真正调查就撂挑子），就提醒它一次，
让它真正去做任务。只在明显的「不作为」时触发，且在恢复（resume）的运行上
跳过（前一次运行的工作不计入本次运行）。直接编辑文件；不可通过 `config set`
设置。

### `memoryAutoApproveConfidence`

**默认关闭。** 设为 `0..1` 之间的数字后，模型置信度 `>=` 该阈值的自动抽取记忆
事实会以已批准的状态直接写入 `project.md`（而不是排入待审核的候选队列）；
低于阈值的事实仍然等待 `seekforge memory approve`。请先用
`seekforge memory stats` 检查抽取质量。直接编辑文件；不可通过 `config set` 设置。

### `memoryMaintenance`

**默认关闭。** 对项目长期记忆执行确定性自动整理。长生命周期的 Server/Desktop、
TUI 和交互式 REPL 会利用空闲时间调度：启动 30 秒后首次检查，此后每 5 分钟检查一次。
任何进程中存在运行中的 Agent/Loop 或记忆写入者时，本轮直接跳过。一次性 CLI 命令
没有空闲生命周期，因此仍在写入后检查。整理与手动压缩共用同一把跨进程记忆租约，
不调用模型；即使整理失败，也不会让前台操作失败。

```json
{
  "memoryMaintenance": {
    "enabled": true,
    "minFacts": 100,
    "minBytes": 65536,
    "minIntervalHours": 24,
    "pruneUnusedDays": 180
  }
}
```

当事实数量达到 `minFacts` **或** UTF-8 字节数达到 `minBytes`，且最小时间间隔
已经过去时，自动整理才会运行。默认阈值为 100 条事实、65,536 字节和 24 小时。
重复与近重复事实会以确定性方式合并。`minFacts` 必须是最大 1,000,000 的正整数，
`minBytes` 必须是最大 4 MiB 的正整数，`minIntervalHours` 的范围是 `0..8760`，
可选的 `pruneUnusedDays` 范围是 `0..36500`。未知子键与非有限数值会被拒绝，
而不是静默忽略。每 5 分钟一次的空闲检查频率不同于 `minIntervalHours`：前者决定
何时查看，后者限制成功整理不能过于频繁。Server 每次都会重新读取用户配置和当前
工作区列表。退出时会取消计时器；没有运行中的 SeekForge 长生命周期进程时，不会
留下后台守护进程。`pruneUnusedDays` 可选且默认关闭；启用后，
只会把从未使用且达到指定天数的事实移动到 `project-archive.md`，不会删除。
最后一次成功结果写入 `.seekforge/memory/maintenance.json`，并显示在桌面端记忆页。

这是用户级设置：仓库配置和仓库 profile 不能启用或调整它。可在桌面端设置中配置，
或直接编辑可信的全局/用户 settings。CLI `config set` 有意不接受该键。

### `permissionRules`

细粒度的允许/拒绝权限规则，用于增强内置的 5 级权限策略。每条规则是一个对象：

```typescript
type PermissionRule = {
  action: "allow" | "deny";
  /** Tool name or "*" for any tool. */
  tool: string;
  /**
   * Prefix matched against the classified command (run_command family)
   * or path (fs tools). Absent = matches any call of that tool.
   */
  match?: string;
};
```

**求值顺序**：每个 action 类别中第一条匹配的规则生效。deny 规则先于 allow
规则扫描，因此匹配到的 deny 总是阻止（哪怕是只读工具）。allow 规则永远无法
越过 ask 模式的阻止，也永远无法解救被归类为 `"dangerous"` 的调用。

来自不同配置层的规则是拼接而非替换。仓库层只能贡献 `deny` 规则；可信的
global/settings 层可以包含两种 action。

```json
{
  "permissionRules": [
    { "action": "deny", "tool": "run_command", "match": "rm -rf /" },
    { "action": "allow", "tool": "run_command", "match": "pnpm build" }
  ]
}
```

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `mcpServers`

MCP（Model Context Protocol）服务器——与 Claude Code 兼容。每个条目把一个
服务器名映射到其配置。支持两种传输模式：

```typescript
type McpServerConfig = {
  /** Executable for stdio transport (e.g. "npx"). */
  command?: string;
  args?: string[];
  /** Extra env vars merged over process.env (stdio only). */
  env?: Record<string, string>;
  /** Streamable HTTP URL. Presence selects HTTP; command/args/env ignored. */
  url?: string;
  /** Extra HTTP headers sent on every request (HTTP only). */
  headers?: Record<string, string>;
  /** Optional OAuth refresh-token flow; every string supports ${ENV_VAR}. */
  oauth?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  };
  /** Authorizes automatic connection; trusted tools run at "write" level (default false). */
  trusted?: boolean;
};
```

每个服务器恰好使用一种传输：如果存在 `url`，就使用 HTTP 传输；否则由
`command` 定义一个 stdio 子进程。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "playwright": {
      "url": "https://mcp.example.com/playwright",
      "headers": { "Authorization": "Bearer <token>" },
      "trusted": true
    }
  }
}
```

对于 Streamable HTTP server，SeekForge 会在初始化后保持可选的会话 GET 事件流。
通知会被消费且不阻塞普通请求；`roots/list` 会依据已配置的工作区根目录回答；
未知的 server 请求会收到 JSON-RPC method-not-found；释放客户端时会中止该流。
HTTP 404/405 会干净地回退到请求作用域响应。refresh-token OAuth 已支持；获取
首次授权仍由前端或运维人员完成。普通请求和对服务器发起请求的响应都会应用
OAuth 刷新、超时和非 2xx 检查。

服务器在各配置层之间按名称合并（后者覆盖前者）：
**settings > project > global**。
项目/local 条目的 `trusted` 始终会被移除；要启用自动连接，请把完整且已审查的
条目放入全局配置或显式 settings。

可通过 `config set` 设置？**不可以** —— 使用 `seekforge mcp add/list/remove`
或直接编辑文件。

### `hooks`

用户级 shell hook，在 agent 生命周期的各个阶段触发。hook 通过 stdin
接收一个包含阶段名和相关上下文（`sessionId`、`workspace`、`toolName`、
`args`、`command`、`path` 等）的 JSON 负载。

```typescript
type HookConfig = {
  /** Fires before every tool call. Non-zero exit *blocks* the tool with a reason. */
  preToolUse?: HookEntry[];
  /** Fires after every tool call (receives `{ ok, errorCode }` — never raw output). */
  postToolUse?: HookEntry[];
  /** Fires when a session starts. */
  sessionStart?: HookEntry[];
  /** Fires when the user submits a prompt. stdout is injected into the task as context. */
  userPromptSubmit?: HookEntry[];
  /** Fires before context compaction. */
  preCompact?: HookEntry[];
  /** Fires when the agent receives a stop signal (Ctrl+C). */
  stop?: HookEntry[];
  /** Fires when a subagent stops. */
  subagentStop?: HookEntry[];
  /** Fires for non-blocking notifications. */
  notification?: HookEntry[];
  /** Fires when the session ends. Receives final session status. */
  sessionEnd?: HookEntry[];
};

type HookEntry = {
  /** Tool name this hook applies to, or "*" for any (default "*"). */
  match?: string;
  /** Prefix matched against the classified command or path. Absent = any. */
  pattern?: string;
  /** Shell command, run via `/bin/sh -c` with cwd = workspace. */
  command: string;
};
```

**阻断型阶段**：`preToolUse` 和 `userPromptSubmit` —— 非零退出会阻止工具调用
或运行继续。其余阶段均为顾问性质（日志、通知、遥测）。

```json
{
  "hooks": {
    "preToolUse": [
      {
        "match": "run_command",
        "pattern": "npm publish",
        "command": "echo 'blocking npm publish' && exit 1"
      }
    ],
    "sessionEnd": [
      {
        "command": "echo 'session $SESSION_ID ended' >> /tmp/seekforge.log"
      }
    ]
  }
}
```

hook 条目会在可信配置层间对**所有**阶段按阶段拼接：**global → settings**。
仓库 hook 不生效；桌面端 Hook 编辑器写入 `~/.seekforge/config.json`。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

#### preToolUse JSON stdout 协议

以 0 退出的 `preToolUse` hook 可以在 stdout 上打印一个 JSON 对象来控制本次
调用（任何不是 JSON 对象的输出都会被忽略，回到普通的退出码行为）。
旧版形态和 Claude Code 形态都被接受：

| 字段 | 位置 | 效果 |
| --- | --- | --- |
| `decision` | 顶层（`"allow"` / `"deny"`） | `deny` 阻止本次调用（`reason` 作为阻止原因）。`allow` 显式放行，并**跳过剩余的 `preToolUse` hook**。 |
| `hookSpecificOutput.permissionDecision` | 嵌套（`"allow"` / `"deny"` / `"ask"`） | 与 `decision` 相同，外加 `"ask"` —— 显式交回正常权限流程，并继续运行后续 hook。顶层的 `permissionDecision` 也会被读取。 |
| `permissionDecisionReason` / `reason` | 嵌套 / 顶层 | 拒绝时向用户展示的可读原因。 |
| `updatedInput` | 顶层或 `hookSpecificOutput` 之下 | 替换工具参数。分发器在工具运行前应用它们，并**对新参数重新做工具 schema 校验和权限检查**。无效替换会让调用以 `invalid_hook_args` 失败，绝不会退回执行原始输入。仅限 `preToolUse`。 |
| `continue` | 顶层（布尔值） | `false` 阻止本次调用（等同于 deny），以 `systemMessage` 作为原因。所有阶段都会解析，但只在 `preToolUse` 和 `userPromptSubmit` 上起阻断作用。 |
| `systemMessage` | 顶层（字符串） | 作为提示展示给用户；`continue: false` 阻断时也作为阻止原因。所有阶段都会解析。 |
| `additionalContext` / `hookSpecificOutput.additionalContext` | 顶层 / 嵌套（字符串） | 作为上下文注入提示词——由 `userPromptSubmit` 和 `sessionStart` 使用。缺省时，这些阶段回退为使用 hook 的原始 stdout。 |

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "permissionDecisionReason": "vetted command"
  }
}
```

```json
{ "hookSpecificOutput": { "updatedInput": { "path": "safe.txt" } } }
```

`userPromptSubmit`（或 `sessionStart`）hook 通过 `additionalContext`
——缺省时用其去除首尾空白的 stdout ——贡献上下文，这些内容以
`<hook-context>…</hook-context>` 块的形式追加到任务上（上限 8000 字符）。

### `locale`

CLI 和 TUI 界面（进度行、摘要、错误消息）的 UI 语言。`--help` /
选项文本保持英文。

| 值 | 行为 |
| --- | --- |
| `"en"` | 英文（默认）。 |
| `"zh-CN"` | 简体中文。 |

启动时解析一次：`config.locale` > `SEEKFORGE_LANG` 环境变量 >
`LC_ALL`/`LANG` > `en`。

```json
{ "locale": "zh-CN" }
```

可通过 `config set` 设置？**不可以** —— 直接编辑文件（或设置
`SEEKFORGE_LANG`）。

### `statusLine`（TUI）

一条 shell 命令，其 stdout 成为 TUI 中的自定义状态栏行，紧贴内置状态栏下方
独立一行渲染。该命令通过 `/bin/sh -c` 运行，cwd 为工作区，从 stdin 接收
JSON 格式的状态负载，同时以 `SEEKFORGE_*` 环境变量提供相同字段：

| 环境变量 | 含义 |
| --- | --- |
| `SEEKFORGE_MODEL` | 当前模型 |
| `SEEKFORGE_CWD` | 工作区目录（同时是命令的 cwd） |
| `SEEKFORGE_SESSION_ID` | 当前会话 id（存在时） |
| `SEEKFORGE_APPROVAL` | 审批模式（`confirm` / `acceptEdits` / `auto` / `plan`） |
| `SEEKFORGE_COST_USD` | 会话累计成本（美元） |
| `SEEKFORGE_CONTEXT_PERCENT` | 上下文窗口使用百分比（存在时） |
| `SEEKFORGE_TOTAL_TOKENS` | 累计 prompt+completion token 数（存在时） |

只使用 stdout 的第一行，上限 80 个字符（允许 ANSI 转义序列通过）。
非零退出、超时（默认 1.5 秒）或输出为空时不产生任何内容，TUI 回退到
内置状态栏行。命令会异步求值，因此慢命令不会冻结渲染；输出上限为 4 KiB，
超时或超限时会终止该命令的整个进程组。

```json
{ "statusLine": "echo \"$SEEKFORGE_MODEL | $SEEKFORGE_CONTEXT_PERCENT% ctx\"" }
```

此键仅由 TUI 读取。可通过 `config set` 设置？**不可以** —— 直接编辑全局
`~/.seekforge/config.json`。项目级 `statusLine` 会被忽略，因为打开仓库不应执行由仓库
控制的 shell 代码。命令只继承最小进程环境和文档列出的 `SEEKFORGE_*` 字段，不会继承
provider 密钥或其它无关宿主环境变量。

### `profiles`

命名的配置叠加层（overlay），运行时通过 `--profile <name>`（或
`SEEKFORGE_PROFILE` 环境变量）选择。每个 profile 是一个部分 `CliConfig`，
被选中时其字段覆盖合并后的基础配置。

```json
{
  "model": "deepseek-v4-flash",
  "profiles": {
    "review": { "model": "deepseek-v4-pro", "thinking": true },
    "ci": { "sandbox": "restricted", "commandAllowlist": ["pnpm test"] }
  }
}
```

选择一个 profile：

```bash
seekforge run "..." --profile review
SEEKFORGE_PROFILE=ci seekforge run "..."
```

profile 会在**所有**配置层中查找。名称冲突时，项目 profile 胜过全局 profile，
本地 profile（`config.local.json`）胜过两者——与普通配置层的优先级相同。
profile 内部的深合并字段（`mcpServers`、`permissionRules`、`hooks`）
跨这些层的组合方式与基础配置一致。

在优先级栈中，选中的 profile 叠加层位于 **`--settings` 之下、
`config.local.json` 之上** —— 见下文「优先级」一节。`profiles` 映射本身
只是一个选择机制，会从 `loadConfig` 返回的配置中**剔除**（因此 `config show`
永远不会回显它）。可用的 profile 名称可通过 `availableProfiles()` 发现。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### 自定义输出风格

在四种内置输出风格（`default`、`concise`、`explanatory`、`learning`）之外，
你可以通过在以下位置放置 Markdown 文件来定义自己的风格：

- `<project>/.seekforge/output-styles/<name>.md`（项目——优先），然后是
- `~/.seekforge/output-styles/<name>.md`（用户主目录）

文件正文原样成为系统提示词附加内容；开头可选的 YAML frontmatter 块会先被
剥除。通过 `--output-style <name>`（与内置风格相同的标志）按文件名
（不含 `.md`）选择自定义风格。内置名称始终解析为其预设，因此与内置同名的
文件不会覆盖内置风格。未知的风格（既不是内置也没有匹配文件）会报错。

```markdown
---
description: House style
---
## Output style: House

- Lead with the change, then a one-line rationale.
- Reference files as absolute paths.
```

---

## 优先级（分层）

配置由 `loadConfig()`（`apps/cli/src/config.ts`）加载，优先级从高到低：

| 层 | 机制 |
| --- | --- |
| **环境变量** | `DEEPSEEK_API_KEY`、`SEEKFORGE_RUNTIME_BIN` |
| **CLI 标志** | `--model`、`-y`、`--settings <file>`…… |
| **`--settings <file>`** | 运行时加载的 JSON 文件 |
| **选中的 `--profile` 叠加层** | 通过 `--profile <name>` / `SEEKFORGE_PROFILE` 选择的 profile |
| **本地配置** | `<project>/.seekforge/config.local.json`（受仓库信任限制） |
| **项目配置** | `<project>/.seekforge/config.json`（受仓库信任限制） |
| **全局配置** | `~/.seekforge/config.json` |

标量键（字符串、布尔值）直接被覆盖——最高层生效。例如，CLI 传了 `--model`
时，项目配置中设置的 `model` 会被忽略。

### 深合并字段

有三个字段跨层合并而非替换：

| 字段 | 合并策略 |
| --- | --- |
| `mcpServers` | 按服务器键合并。仓库条目会遮蔽同名全局条目，但始终不受信任；只有完整的用户级条目才能启用自动连接。 |
| `permissionRules` | 按高优先级在前拼接，但仓库层只能贡献有效的 `deny` 规则。 |
| `hooks` | 在可信层间按阶段拼接：global → settings。仓库 hook 会被忽略。 |

如果更高的层为这些字段提供了错误的运行时形态，该值会被忽略，
而不是替换掉低层的有效值。

---

## `seekforge config show|set`

### Show

```bash
seekforge config show
```

打印**合并后**（所有层组合）的配置，格式化为 JSON。`apiKey` 的值被脱敏为
仅前 6 个字符（例如 `"sk-ab1****"`）。不接受 `--global` 标志——
它总是显示合并结果。

### Set

```bash
seekforge config set <safe-key> <value>    # 写入安全的项目偏好
seekforge config set <key> <value> --global # writes to ~/.seekforge/config.json
```

**可设置的键**（定义在 `apps/cli/src/commands/config.ts` 的 `ALLOWED_KEYS`）：

| 键 | 配置中的类型 | CLI 值 |
| --- | --- | --- |
| `apiKey` | string | 字符串 |
| `model` | string | 字符串 |
| `baseUrl` | string | 字符串 |
| `provider` | string | `deepseek` / `ark` / 预设名 |
| `runtimeBin` | string | 字符串 |
| `commandAllowlist` | string[] | 逗号分隔字符串（`"pnpm test, cargo build"`） |
| `sandbox` | enum | `off` / `read-only` / `workspace-write` / `restricted` |
| `compaction` | enum | `mechanical` / `llm` |
| `thinking` | boolean | `true` / `false` |
| `reasoningEffort` | enum | `high` / `max` |

其余的键 —— `planModel`、`escalateOnFailure`、`maxCostUsd`、
`modelPricing`、`verifyCommand`、`autoVerify`、`lintCommand`、`autoLint`、
`editFormat`、`finalizeReview`、`guardNoProgress`、
`memoryAutoApproveConfidence`、`memoryMaintenance`、`permissionRules`、
`mcpServers`、`hooks` —— **不可**通过 `config set` 设置。必须直接编辑 JSON
配置文件、在 Desktop/Server 支持时通过其界面配置，或通过专用子命令管理
（MCP 服务器用 `seekforge mcp add|list|remove`）。

对未列出的键执行 `config set` 会打印错误并列出允许的键。

不带 `--global` 时，此命令的键列表中只有 `model`、`compaction`、`thinking`
和 `reasoningEffort` 可写入项目层。凭据路由、runtime、放行清单和 sandbox
属于用户级设置，必须使用 `--global`。

---

## 环境变量

| 变量 | 映射到 | 优先级 |
| --- | --- | --- |
| `ARK_API_KEY` | `apiKey` | 覆盖所有文件/标志层；两者都设置时胜过 `DEEPSEEK_API_KEY` |
| `DEEPSEEK_API_KEY` | `apiKey` | 覆盖所有文件/标志层 |
| `SEEKFORGE_RUNTIME_BIN` | `runtimeBin` | 覆盖所有文件/标志层 |
| `SEEKFORGE_PROFILE` | 选择一个 `profiles` 条目 | 在 `--profile` 缺席时使用；选中的叠加层位于 `--settings` 之下 |

`ARK_API_KEY`、`DEEPSEEK_API_KEY` 和 `SEEKFORGE_RUNTIME_BIN` 在
`loadConfig()` 的末尾应用，因此总是胜过任何文件或标志。`SEEKFORGE_PROFILE`
只决定叠加哪个 `profiles` 条目（显式的 `--profile` 标志优先于它）。

---

## 代码导航（`repo_map` / `find_definition`）与 tree-sitter

两个内置的只读工具帮助 agent 在大型代码库中定向：

- **`repo_map`** —— 紧凑的结构概览（目录汇总 + 每个文件一行的符号大纲）。
  对超过约 150 个代码文件的仓库，会话开始时还会向系统提示词自动注入一份
  顶层概览，让 agent 一开始就有方向感。用 `path` 可以深入某个子树。
- **`find_definition`** —— 定位符号被*定义/导出*的位置（函数、类、常量、方法、
  组件），而不是每一处提及。

### 任务相关文件短名单（自动注入）

在通用概览之外，循环还会在会话开始时（仅顶层运行）注入一份**面向任务**的
短名单：按文件的**路径与符号大纲**同任务的词汇重合度排序的代码文件，
每个附一行大纲——「针对*这个*任务，该看这里」。它复用了记忆摘要的分词器，
因此中文/日文/韩文任务同样适用。它是一个**廉价的定向提示，不是搜索引擎**：
只存在于文件*内容*中（而非文件名或导出）的相关性不会浮现——那是
`search_text` 的职责，提示词里也是这么说的。对小型代码树、泛化的任务，
或没有任何文件达到相关性下限时，什么都不注入（沉默胜过噪音）。

> 实测（见 [`evals/round-52-measurements.md`](../evals/round-52-measurements.md)）：
> 在术语本身就能 grep 到的 bug 修复任务上，短名单没有收益；但在一个
> `search_text` 返回 41 条噪音命中、只有目标文件的路径/导出匹配的 ask 模式
> 任务上，检索**3/3 次**取胜（约少 1 个回合、约便宜 10%）。它的价值集中在
> 高难度导航上；它从不帮倒忙，所以保持开启。注意：短名单只在 ≥40 个代码
> 文件的仓库上触发（仓库概览需要 ≥150）——多数小仓库两者都不会触发。

### 混合抽取（可选 tree-sitter，regex 兜底）

符号抽取使用**双后端解析器**：

1. **tree-sitter（AST）** —— 准确且能识别注释/字符串，支持
   JavaScript/JSX、TypeScript/TSX、Python、Java、Rust、Go、C、C++、C#。
2. **regex** —— 零依赖的**兜底**：用于其余所有语言（Vue、Svelte、Ruby、
   PHP……），以及 tree-sitter 不可用或文件解析失败的情形。

tree-sitter 以**可选依赖**的形式发布（`web-tree-sitter` +
`tree-sitter-wasms`）：默认安装，让 AST 路径开箱即用，但也可以跳过
（`pnpm install --no-optional`）——此时抽取优雅降级到 regex 兜底，
正确性无损，只损失精度。

> 坦诚说明：在一个约 1100 文件的真实仓库上实际使用表明，`repo_map` 的定向
> 功能被稳定使用，但模型对 `find_definition` 的采纳很弱（它往往更偏好
> `search_text`，后者同样能用）。这些工具是**可用而非强制**的；
> 尚未确立可测量的效率收益。
