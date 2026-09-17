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
`planModel`、`editFormat`、UI 偏好及类似的非授权字段）、添加 `deny` 与 `ask`
权限规则，以及声明供显式检查的未信任 MCP 服务器。

它们不能提供凭据或凭据目的地（`apiKey`、`provider`、`baseUrl`），不能执行
启动/运行时命令（`apiKeyHelper`、`runtimeBin`、hook、`statusLine`、`lintCommand`、
`verifyCommand`），不能自动授权操作（`commandAllowlist`、`allow` 权限规则、
MCP `trusted`），不能改变沙箱设置（`sandbox`、`sandboxNetwork`），不能授予项目
之外的访问权（`additionalDirectories`），也不能提高消费上限（包括每次请求携带多少
上下文：`modelContextWindows`、`autoCompactThreshold`）、自动批准记忆、改变审计保留
策略，或让你读取 `~/.claude/CLAUDE.md`（`claudeCompat`）。
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

存放在密码库里、会轮换或会过期的密钥，更适合用 [`apiKeyHelper`](#apikeyhelper)
提供，而不是写在这里。

### `apiKeyHelper`

一条 shell 命令，其标准输出就是 API key。SeekForge 在第一次需要密钥时运行它，
把它打印的内容（去掉首尾空白）用于每一次 provider 请求；当这个密钥的存活时间
超过 `SEEKFORGE_API_KEY_HELPER_TTL_MS`（默认 5 分钟；`0` 表示每次请求前都运行）
时会再运行一次，provider 返回 401 时也会再运行一次。CLI、TUI、`seekforge serve`
以及经由 server 的 Desktop 行为一致。

```json
{ "apiKeyHelper": "op read op://dev/deepseek/credential" }
```

- **仅限用户级配置。** 它会执行命令，因此只认 `~/.seekforge/config.json`、
  该文件里的 profile，或 `--settings` 文件；`.seekforge/config.json`、
  `.seekforge/config.local.json` 及其 profile 中的该键会被忽略。
- **优先级。** provider 自己的环境变量（`DEEPSEEK_API_KEY`、`ARK_API_KEY`、
  `ANTHROPIC_API_KEY`）仍然优先，此时不会运行 helper。在它之下，helper 给出的
  密钥会替代同一配置里的 `apiKey`。helper 失败时就没有任何密钥——不会退回到
  文件里的那个——CLI 会打印原因。
- **输出。** stdout 上的单个 token（首尾空白会被去掉；最多 16 KiB）。中间带有
  空白或控制字符的输出会被拒绝。命令写到 stderr 的内容一概不读。
- **限制。** 命令通过平台 shell 运行，没有标准输入，10 秒后会被强制结束。
  一个进程里的第一次运行会等待它完成；之后，配置重新加载时会在后台刷新已过期
  的密钥，而 provider 请求会等待新密钥。一次失败的运行在 30 秒内会被直接复用报告，
  不会在每次加载配置时重跑，因此坏掉的 helper 不会拖慢 `seekforge serve` 的每个请求。
- **绝不记录。** 密钥不会写入追踪、日志或错误信息；错误只说明命令如何失败
  （退出码、信号、超时）。`config show` 会打印命令本身，所以不要把机密写在命令行里。
- Docker 与 SSH 运行器只按变量名转发密钥；只配置了 helper 时，容器或远程主机
  拿不到密钥。

可通过 `config set` 设置？**不可以**——请直接编辑 `~/.seekforge/config.json`。

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

命名的 provider 预设。一次切换即同时选定 API 基础 URL、**线路协议**和一套能力集。
`"deepseek"`（未设置时的默认值）指向 DeepSeek 直连，所有特性开启。
`"ark"` 指向火山引擎 Ark，一个 OpenAI 兼容端点（见下节）。
`"anthropic"` 指向 Anthropic Messages API —— 它是另一套协议，而不是 OpenAI
兼容端点（见其专节）。显式的 `baseUrl` 总是优先于预设的 URL，因此你可以在保留
某个预设协议与能力配置的同时，把它指向一个代理。

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

### Anthropic（Messages API）

`anthropic` 是唯一一个**不是** OpenAI 兼容的预设。它使用 Anthropic Messages
协议（`POST {baseUrl}/messages`），用 `x-api-key` 而不是 bearer token 认证，
并把系统提示、工具调用和工具结果都表示为带类型的 content block。这套翻译由
SeekForge 完成 —— agent、工具、会话等其余部分完全不变。

1. 设置 `provider: "anthropic"`（基础 URL `https://api.anthropic.com/v1`）。
2. 通过 `ANTHROPIC_API_KEY`（推荐）或 `apiKey` 配置字段提供密钥。
   这个环境变量**只在** provider 为 `anthropic` 时被读取。
3. 选择 `model`：`claude-opus-5`（目录首项）、`claude-sonnet-5`、
   `claude-haiku-4-5`、`claude-opus-4-8`、`claude-fable-5`。其他 Claude 模型
   id 同样可用；这份目录是模型选择器展示的内容，不是白名单。

```json
{ "provider": "anthropic", "model": "claude-opus-5" }
```

```bash
export ANTHROPIC_API_KEY="…"
seekforge config set provider anthropic --global
seekforge config set model claude-opus-5
```

与 OpenAI 兼容预设的差异：

| 行为 | 在此预设下 |
| --- | --- |
| `thinking` | `true` 请求自适应思考并要求返回摘要推理（否则推理流会是空的）；`false` 关闭思考；不设置则什么都不发，采用模型默认值 —— 另见下方注意事项 |
| `reasoningEffort` | 作为 `output_config.effort` 发送（`low` / `medium` / `high` / `max`）。与 `thinking: false` 同时使用时，`max` 会被限制为 `high`——这是关闭思考时 API 允许的上限。Haiku、Sonnet 4.5 以及 Opus/Sonnet 4.0–4.1 不接受 effort，不会发送；Opus 4.5 的 `max` 会发成 `high` |
| 提示缓存 | 开启，且是这里最大的成本杠杆：该 API 只在请求标出断点的位置缓存，因此 SeekForge 会在系统提示词末尾（其中包含工具定义）和对话末尾各标一个断点。命中缓存的前缀在下一回合按输入价的十分之一计费 |
| 上下文缓存 token | 会读取。Anthropic 的输入计数只是**未命中缓存的余量**，因此 SeekForge 会把缓存读/写的计数加回去，报告完整的 prompt 规模 |
| 成本 | 使用内置的 Anthropic 价格表计价 —— 无需 `modelPricing`，`maxCostUsd` 和成本读数即可工作。表中没有公开价格的模型报告为「未知」，而不是 `0` |
| 余额 | 不查询；`/user/balance` 是 DeepSeek 自己的端点 |
| `temperature` | 从不发送 —— 当前的 Claude 模型会拒绝采样参数 |
| `maxTokens` | API 要求必填，因此未设置时会取默认值（16000），而不是省略 |

> **为什么不按回合裁剪工具目录。** 一个看起来显然的省钱办法是：只把某个任务可能
> 用得上的工具发给模型 —— SeekForge 内置 53 个工具，实测其定义共 10,858 token，
> 而它们每次请求都要发。但算一下就知道不该这么做。工具定义位于缓存前缀的**最前
> 面**，因此在一次运行中途改动它们，会让排在它们后面的一切（包括对话本身）缓存
> 全部失效。按 Opus 5 的价格，命中缓存的前缀只按输入价的十分之一计费，于是完整
> 目录每回合的等效成本是 1,086 token —— 比一个裁剪到 15 个工具的目录**未命中缓存**
> 时（2,970）还要低。使裁剪划算的对话规模临界点是负数：不存在这样的临界点。以一段
> 3 万 token 的对话实测，按回合裁剪目录的花费大约是「全发 + 保持缓存」的 8 倍。
>
> 真正划算的是**只裁剪一次**：在第一次请求之前裁好，前缀此后保持稳定且命中缓存 ——
> 这正是 `--allowedTools` 已经在做的事。另外，即便命中缓存，目录也不是免费的，因此
> `tests/agent/tool-catalog.test.ts` 会把它的规模钉住：一个大型 MCP 服务器可以带来
> 比全部内置工具加起来还多的定义 token，这应当是一件看得见的事，而不是每回合悄悄
> 交的税。

> **图像。** 在该 provider 上截图会直接进入主模型：`browser_screenshot` 会把 PNG
> 附到产生它的那条工具结果上，agent 可以直接「看」页面，而不必再借另一个模型转述。
> 协议无法携带图像的 provider 会在结果文本里说明，而不是悄悄丢掉；在那些 provider
> 上仍然用 `image_analyze` 查看图片。

### 「OpenAI 兼容」到底覆盖了什么

各家兼容端点在协议上一致，但对协议某些部分的**拼写**并不一致。SeekForge 会把这些
差异归一化，每一条都由 `packages/core/tests/provider/dialects.test.ts` 中的
fixture 锁定：

| 差异 | 处理方式 |
| --- | --- |
| 流式思维用 `reasoning` 而非 `reasoning_content` | 两种拼写都累积到同一条 reasoning 流 |
| 缓存命中放在 `prompt_tokens_details.cached_tokens` 而非 `prompt_cache_hit_tokens` | 两者都读；同时出现时以 DeepSeek 的字段为准，是否上报仍由预设的 `cacheHitTokens` 能力决定 |
| `finish_reason: "function_call"`（旧式） | 视同 `tool_calls`，工具调用照常执行 |
| 工具调用分片没有 `index`，或只在首个分片带 id | 按 index 归并为同一个调用，缺失时默认 index 0 |
| 工具调用流结束时完全没有 `finish_reason` | 只要已收到工具调用，就按 `tool_calls` 上报 |
| `choices: []` 空分片、keep-alive 注释行、空行 | 直接忽略 |

有一处不兼容是刻意为之：流若**没有** `[DONE]` 终止符就结束，会直接报错而不是把
半截内容当作完整回答——因为连接被切断与正常关闭在网络层无法区分。永不发送
`[DONE]` 的端点必须经由能正确终止流的代理才能使用。

能力差异（thinking、缓存命中 token、成本、余额）按预设显式声明，不在运行时猜测
——见 `PROVIDER_PRESETS`。

### `runtimeBin`

`seekforge-runtime` 二进制文件（Rust 执行后端）的路径。设置后，文件 I/O、
命令执行和 git 操作会委托给一个可信的 Rust 二进制，进行纵深防御式的
包含关系复查。权限决策仍留在 TypeScript 中。

```json
{ "runtimeBin": "/usr/local/bin/seekforge-runtime" }
```

也从 `SEEKFORGE_RUNTIME_BIN` 环境变量读取（优先级最高）。

可通过 `config set` 设置？**可以，但必须带 `--global`**。

并非所有工具都走它，而且例外是刻意的。`repo_map` 和 `find_definition` 仍然直接读文件系统：
它们只读、不会走进符号链接目录、以 `O_NOFOLLOW` 打开文件、并且拒绝解析到工作区之外的子树
——所以没有任何写操作需要 runtime 复检，它也提供不了额外的隔离。此前只要设置了
`runtimeBin`，这两个工具就直接拒绝运行，也就是说打开 runtime 会**悄悄拿掉**智能体在仓库里
定位方向的两种手段。

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

在可写级别（`workspace-write`、`restricted`）下，
[`additionalDirectories`](#additionaldirectories) 在沙箱内同样可写；在
`read-only` 下保持只读。如果只想放行部分网络目的地，而不是全开或全关，请加上
[`sandboxNetwork`](#sandboxnetwork)。

```json
{ "sandbox": "workspace-write" }
```

可通过 `config set` 设置？**可以，但必须带 `--global`** —— 校验取值为 `off` / `read-only` /
`workspace-write` / `restricted`。

### `sandboxNetwork`

沙箱命令的域名白名单，介于 `workspace-write`（网络全开）与 `restricted`
（网络全关）之间。

```json
{
  "sandbox": "workspace-write",
  "sandboxNetwork": {
    "allowedDomains": ["registry.npmjs.org", "*.github.com", "github.com"],
    "deniedDomains": ["gist.github.com"]
  }
}
```

- `example.com` 只放行这一个主机；`*.example.com` 放行它的子域名，但不包括
  `example.com` 本身（两者都需要时请都写上）。IP 字面量和 `localhost` 必须原样
  写出。scheme、端口、路径以及单独的 `*` 都会被拒绝。`deniedDomains`（可选，
  语法相同）优先于 allow 模式。被放行主机的任意端口都可访问。
- 代理对放行的名字只解析一次，并且只连接解析得到的地址。仅由 `*.` 模式匹配的名字
  若解析到回环、未指定或链路本地地址（例如云元数据端点），会被拒绝；如果某个名字
  本就应当访问本机，请精确列出它。私有网段不会被阻断。
- 命令运行时，`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`（及其小写形式）指向
  SeekForge 首次使用时启动的本地代理；操作系统沙箱会阻断其他所有连接，因此忽略
  这些变量的工具（或使用 HTTP/HTTPS 以外协议的工具，例如 `git@` 形式的 SSH）没有
  网络。`localhost`、`127.0.0.1` 与 `::1` 在 `NO_PROXY` 中。
- 被拒绝的请求会收到 `403 Blocked by SeekForge sandbox`；命令结果会写明被拦截的
  `host:port`，失败的命令会给出常规的一次性无沙箱重试提示。
- 白名单只会收窄。未设置 `sandbox` 时，它意味着 `workspace-write`；与
  `read-only` 或 `workspace-write` 一起使用时，它取代这两个级别原本开放的网络；
  与 `restricted` 一起使用时，网络仍然完全阻断；`sandbox: "off"` 时不生效。
- 如果 SeekForge 本身需要通过 `http://` 代理上网（`http_proxy` /
  `https_proxy` / `all_proxy`，遵守 `no_proxy`），放行的流量会经由该代理转发。
- 在 Linux 上，沙箱独立的网络命名空间通过一个小型转发器接到代理，该转发器在
  沙箱内运行宿主机的 `node`。在 macOS 上，白名单生效期间命令无法打开或访问其他
  本地端口。
- 格式错误的值会在构建 agent 时报错——绝不会被丢弃，因为丢弃它会让
  `workspace-write` 的网络保持开放。

这是用户级设置：仓库配置与仓库 profile 都不能设置它。可通过 `config set` 设置？
**不可以** —— 直接编辑你的全局配置（或 `--settings` 文件）。

### `additionalDirectories`

文件工具还可以使用的、位于项目之外的绝对目录——即 `--add-dir` / `/add-dir`
的配置文件形式。

```json
{ "additionalDirectories": ["~/code/shared-lib", "/srv/fixtures"] }
```

- `read_file`、`list_files`、`search_text`、`glob`、`write_file`、
  `apply_patch`、`notebook_read`、`notebook_edit` 与 `image_analyze` 接受位于这些
  目录中的路径（模型会被告知使用绝对路径）。写入需要与工作区内相同的批准；
  `acceptEdits` 同样适用。
- 机密文件（`.env`、密钥、`.seekforge/config.json`、`.git/config` 等）在任意深度
  都不可读，任何 `.git` 目录下都不可写。离开所有授权目录的符号链接会被拒绝。
- 每次运行都会校验这些条目：`~` 展开为你的 home 目录，相对路径相对于项目解析，
  不存在的路径、文件或位于项目内部的目录会被跳过并给出警告。每个目录都固定为
  其真实（解析符号链接后的）位置。
- 在可写的 `sandbox` 级别下，命令也可以写入这些目录。
- 回退（rewind）不会恢复这些目录中的文件，而是将其报告为已跳过。

这是用户级设置：仓库配置与仓库 profile 都不能设置它。可通过 `config set` 设置？
**不可以** —— 直接编辑你的全局配置（或 `--settings` 文件）。

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

无论采用哪种策略，压缩都按以下方式进行：

- **预算**是本次请求所用模型上下文窗口的 80%，再减去 8,192 token 的输出预留。
  窗口按模型查找（见 [`modelContextWindows`](#modelcontextwindows)），因此在另一个
  模型上进行的 plan 运行会按那个模型的窗口计算预算。
- **压缩从阈值开始** —— 即预算的 `autoCompactThreshold`（默认 90%），而不是等到
  超出预算本身。
- **微压缩**把超过 200 个字符（或附带图片）的工具输出替换为一行说明，写明需要重新
  运行什么。位于最近两个用户回合之前、**或**位于最近四轮工具调用之前的结果都算
  「旧的」，因此长时间的无头 `-p` 运行（一个用户回合、许多轮工具调用）同样会被
  清理。消息只会被改写、不会被删除，所以每个工具调用都保有自己的结果。
- **完整压缩**保留系统提示词、任务和最近的消息，把中段替换为摘要。
- 完整压缩之后会**恢复工作上下文**：当前计划，以及本次运行最近读取或编辑的至多
  5 个文件的最新副本（磁盘上的当前内容；每个至多 8,000 个字符、合计至多 24,000
  个字符，且不超过阈值下剩余空间的一半）。已删除、二进制、敏感（`.env`、密钥、
  SeekForge 自己的配置）以及工作区之外的文件会被跳过，密钥会被脱敏。这段内容标注
  为由 harness 提供的数据，不会写入会话 trace。
- **超出预算本身时**，过大的工具输出会被原地截短；仍然放不下的请求以
  `context_budget_exceeded` 失败。

### `autoCompactThreshold`

压缩开始时占上下文预算的比例，取值大于 0 且不超过 1，默认 `0.9`。值越小压缩越早
（请求更小、更便宜，但摘要更多）；`1` 保持旧行为，即只在超出预算本身时才压缩。
无效值会让 agent 无法启动，并给出指明该键的错误。

```json
{ "autoCompactThreshold": 0.8 }
```

用户级设置：仓库配置不能设置它。可通过 `config set` 设置？**不可以** —— 请直接编辑
文件。

### `modelContextWindows`

以 token 计的上下文窗口，键为 provider 配置所用的**精确**模型 id。用于 SeekForge
不认识的模型，或让大窗口模型按小于其完整窗口的大小计算预算。

```json
{ "modelContextWindows": { "qwen3-coder": 262144, "claude-opus-5": 400000 } }
```

没有对应条目时，窗口来自内置表（`packages/core/src/provider/constants.ts`），按模型
id 或模型家族匹配 —— 带日期或路由前缀的 id（如 `claude-opus-5-20260101`、
`us.anthropic.claude-opus-5-v1:0`）会找到其家族：

| 模型 | 窗口 |
| --- | --- |
| `claude-opus-4-6`、`-4-7`、`-4-8`、`claude-opus-5`、`claude-sonnet-4-6`、`claude-sonnet-5`、`claude-fable-5*`、`claude-mythos-5*` | 1,000,000 |
| `claude-haiku-4-5` 及更早的 Claude 模型 | 200,000 |
| `deepseek-v4-*`、`deepseek-flash` | 1,000,000 |
| `deepseek-chat`、`deepseek-reasoner` | 131,072 |
| 其他任何模型（包括窗口尚未核实的 OpenAI 模型） | 131,072 |

大窗口意味着大请求：1M token 的模型要到请求估算达到约 71 万 token 才会压缩，而每个
回合都会重新发送上下文中的全部内容。如果这样花费大于收益，请在这里调小窗口。取值
必须是正整数；无效条目会让 agent 无法启动，并给出指明该条目的错误。

用户级设置：仓库配置不能设置它（更大的窗口意味着更大、更贵的请求）。可通过
`config set` 设置？**不可以** —— 请直接编辑文件。

### `thinking`

控制 DeepSeek V4 思考模式（`deepseek-v4-*`，以及 V4.1 的 `deepseek-flash` /
`deepseek-pro`）。为 `true` 时，模型在一个可折叠的思考块中展示推理过程（绝不会
回传到请求中）。为 `false` 时关闭思考；缺省时采用 API 默认行为。

在 REPL 中，`/think on|off|high|max` 可在运行时切换。

```json
{ "thinking": true }
```

可通过 `config set` 设置？**可以** —— 接受 `true` / `false`。

### `reasoningEffort`

模型思考的力度：`"low"`、`"medium"`、`"high"` 或 `"max"`。缺省时不发送任何级别，
由模型采用自己的默认值。没有哪个端点恰好有这四档，所以每个 provider 收到的是它
所接受的最接近的一档；接受哪些档位未知的模型则什么也收不到：

| Provider | 发送为 | `low` | `medium` | `high` | `max` |
| --- | --- | --- | --- | --- | --- |
| `deepseek`（V4 模型：`deepseek-v4-*`、`deepseek-flash`、`deepseek-pro`） | 顶层 `reasoning_effort` | `low` | `high` | `high` | `max` |
| `anthropic` | `output_config.effort` | `low` | `medium` | `high` | `max`（见上方 Anthropic 表格） |
| `openai`，gpt-5.6 系列 | `reasoning_effort` | `low` | `medium` | `high` | `max` |
| `openai`，gpt-5.2 – gpt-5.5 | `reasoning_effort` | `low` | `medium` | `high` | `xhigh` |
| `openai`，gpt-5 / gpt-5.1 | `reasoning_effort` | `low` | `medium` | `high` | `high` |
| `openrouter` | `reasoning.effort`（由路由方按模型换算） | `low` | `medium` | `high` | `xhigh` |
| `ark`、`ollama`、其他 OpenAI 模型、`-pro` 模型 | 不发送 | | | | |

DeepSeek 自己就会把 `medium` 当作 `high` 运行；发送 `high` 只是如实说明。任何级别
都会开启 DeepSeek 的思考，因此在 `thinking: false` 时不会向它发送级别（OpenAI
兼容端点同理）。

```json
{ "reasoningEffort": "max" }
```

可通过 `config set` 设置？**可以** —— 按 [`config set` 表格](#set) 中列出的取值校验。

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

### `maxDurationSeconds`

**默认关闭。** 以秒计的单次运行墙钟预算。超过截止时间后，运行经由同一条优雅
取消路径停止（trace 会保留，因此可以 `resume`）。可被 CLI 标志
`--max-duration <seconds>` 覆盖；`sandbox-run` 与 `remote-run` 会把它转发进
容器 / 远程主机，让预算由真正在花时间的那次运行来执行。

这是唯一一个用**定时器**而不是检查来实现的上限。成本、回合、工具调用这三个
上限都是在「有事情发生」时才被求值；而值得用墙钟约束的运行，恰恰是那些什么
都没在发生的运行 —— 没有超时的命令、不再回应的 MCP 服务器、卡在重试里的
provider。它们不产生任何事件，因此基于事件的检查永远不会触发。

截止时间作用于整次调用，而不是单个回合：一次多回合的
`--input-format stream-json` 会话，依然是你启动之后就离开的那一件事。计时从运行
真正开始时起算 —— 启动阶段（读取配置、目录授权、拉起 MCP 服务器）不计入，因为
那个阶段可能正当地在等你回答一个提示。停止是
优雅的，所以进行中的工具调用会被取消而不是被杀死 —— 运行可能会略微超出，
停止信息里会报告它实际用掉的时间。

必须是数字 —— `"900"` 这样的字符串会被以清晰的错误拒绝，而不是被悄悄忽略。
未设置或非正数时关闭。

```json
{ "maxDurationSeconds": 900 }
```

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `modelPricing`（在其他 provider 上开启成本跟踪）

**默认关闭。** 成本由「谁能诚实回答，就由谁回答」，逐 provider 决定：

| 预设 | 价格从哪里来 | 预算是否开箱即用 |
| --- | --- | --- |
| `deepseek`、`anthropic`、`openai` | 各自公布的价目表，随 SeekForge 一起发布 | 是 |
| `openrouter` | 端点在每次响应的 `usage.cost` 里直接给出本次扣费 | 是 |
| `ark`、`ollama`、裸 `baseUrl` | 无处可取 —— 成本恒报 `0` | **否**，需先设 `modelPricing` |

最后一行意味着 `maxCostUsd` 和 Loop 成本预算永远不会触发，因为每次请求都报 `0`。
SeekForge 会明说这一点，而不是让你误以为有护栏：CLI、TUI、server 每个会话各警告
一次「该模型价格未知」，`seekforge run --max-cost` 会提示该预算无法生效，
`seekforge schedule add` 则在创建时就警告 —— 定时任务是无人值守的，一个形同虚设
的预算在那里最要命。

设置 `modelPricing` 提供你自己的按模型费率，即可在那些 provider 上打开成本与预算
跟踪。以这种方式定价的模型在任何地方都按你的费率计价，包括预设没有价格表的
provider。

SeekForge 刻意**不**为无价目表的 provider 塞一份猜出来的价格：一个错误的费率会
悄悄把建立在它之上的每一个预算都算错，那比什么都不报还糟。一个其实是「未知」的
`0`，不该被当成「这次调用是免费的」。

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

### `inlineImages`（让模型自己看截图）

**默认：跟随 provider 预设。** 产出图片的工具（目前是 `browser_screenshot`）
在返回路径的同时也把字节一并奉上。图片是否真的送到模型，由 provider 回答而非
工具决定：端点能收图时，截图随工具结果一起送达，模型直接看；不能收时，结果里
用文字说明这一点，图片仍可经 [`visionModel`](#visionmodel) 和 `image_analyze`
读取。

| 预设 | 内联图片 | 原因 |
| --- | --- | --- |
| `anthropic` | **开** | 现行 Claude 模型全部接受图片 |
| `openai` | **开** | 预设目录里的模型同样全部接受 |
| `openrouter` | **开** | 路由型端点：由模型 id 决定，拒绝时报错明确 |
| `ark` | 关 | 目录混合 —— doubao-seed 多模态，kimi 与 minimax 不是 |
| `ollama` | 关 | 常见的 `llama3.1`、`qwen2.5-coder` 都是纯文本模型 |
| `deepseek`（默认） | 关 | DeepSeek 没有视觉模型 |

当你的模型与预设的默认答案不符时设置它 —— 例如 Ark 上的
`doubao-seed-2.0-pro`、Ollama 上拉取的 `llava`，或某个同门模型都有眼睛而它
没有的纯文本模型：

```json
{ "provider": "ark", "model": "doubao-seed-2.0-pro", "inlineImages": true }
```

对读不了图的模型开启它会让请求**直接失败**，而不是降级 —— 所以面对混合目录，
预设宁可保守作答，也不按模型 id 猜。关掉它则永远安全：图片会变成一句指向
`image_analyze` 的说明。

属于用户所有：它描述的是你的端点与账号，因此仓库配置无法设置它（与
`modelPricing` 同理）。

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

### `claudeCompat`

**默认 `"project"`。** 除 SeekForge 自己的 `AGENTS.md` 系列文件外，还读取哪些
Claude Code 指令文件（见[项目规则](#项目规则)）：

- `"project"`（默认）：工作区的 `CLAUDE.md`、`.claude/CLAUDE.md`、
  `CLAUDE.local.md`、`.claude/rules/**/*.md`，以及子目录中与 `AGENTS.md`
  并列的 `CLAUDE.md`。
- `"all"`：以上全部，再加上用户级的 `~/.claude/CLAUDE.md`。
- `"off"`：都不读，只读 SeekForge 自己的文件。

```json
{ "claudeCompat": "all" }
```

仅限用户级配置：仓库配置层不能设置它，因此检出的代码永远无法让 SeekForge 读取你的
`~/.claude/CLAUDE.md`。请写在 `~/.seekforge/config.json`（或 `--settings` 文件）中。
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

细粒度的允许/询问/拒绝权限规则，用于增强内置的 5 级权限策略。每条规则是一个对象：

```typescript
type PermissionRule = {
  action: "allow" | "deny" | "ask";
  /** 工具名，或对工具名的 `*` 通配（"*"、"mcp__github__*"）。 */
  tool: string;
  /** 调用必须匹配的内容（见下文）。缺省 = 该工具的任何调用。 */
  match?: string;
};
```

**动作**：

- `deny` 在所有级别（包括只读工具）直接阻止该调用，不询问。
- `ask` 总是询问——哪怕是只读工具，哪怕某条 allow 规则、一次「不再询问」的回答
  或某个审批档位（包括 `auto`）本会直接执行该调用。回答只对这一次调用有效：此时
  的提示既不提供「本次会话」也不提供「始终」。ask 规则永远不会为被拒绝的调用解围。
- `allow` 让匹配的调用无需询问即可执行——包括 `env`（L3）工具，预先批准某个文档
  域名就是这样做的。allow 规则永远无法越过 ask 模式的阻止，也永远无法解救被归类为
  `"dangerous"` 的调用，并且永远不会作用于带控制语法（`&&`、`;`、`|`、重定向、
  `$(…)`、换行）的 shell 命令。

**求值顺序**：先 deny 规则，再 ask 规则，最后 allow 规则；每个 action 类别中第一条
匹配的规则生效。

**`match` 的含义**取决于工具做什么：

| 工具类型 | `match` | 示例 |
| --- | --- | --- |
| Shell 命令（`run_command`、`run_tests`、`task_kill`） | 按词边界的前缀（`pnpm test` 覆盖 `pnpm test --watch`，不覆盖 `pnpm test-all`），或带 `*` 通配符、与整条命令匹配的模式。allow 模式必须以字面的程序名开头。 | `"npm run *"`、`"git push *"` |
| URL 工具（`web_fetch`、`browser_navigate`，分类为 `GET <url>`） | 按 scheme、主机与路径比较的 URL 前缀（因此 `GET https://docs.example.com` 永远不会覆盖 `docs.example.com.evil.net`），或用 `domain:<host>` 表示某主机及其所有子域名 | `"GET https://docs.example.com/guide"`、`"domain:example.com"` |
| 文件工具 | 按目录边界的路径前缀；若包含 `*` 或 `?` 则为 glob（`**` 跨目录；`[` 与 `{` 按字面处理）。位于工作区内的路径一律按相对于工作区的形式比较，无论调用使用的是相对路径还是绝对路径。 | `"src"`、`"src/**"`、`"**/*.env"`、`"docs/*.md"` |
| 其他带命令的工具（`web_search` 的 `SEARCH <query>`、MCP 的 `mcp:<server>/<tool>`） | 纯前缀 | `"mcp:github/"` |

Deny 与 ask 规则朝安全侧失败：命令规则还会对复合命令中的每一条命令分别测试
（`cd x && git push` 会命中 `"git push *"`），并忽略开头的 `NAME=value` 赋值和
程序所在目录；路径规则还会匹配符号链接真正指向的位置；glob 还会匹配它所指的
目录本身；URL 规则还会匹配无法解析的 URL。Allow 规则只匹配它写明的内容：路径
必须在书写形式与真实解析形式下都匹配，因此允许目录中的符号链接不会扩大授权范围。

兼容性提示：已有命令规则中的 `*` 过去是字面字符，现在是通配符。权限提示在
「始终允许」时永远不会提出含 `*` 的规则。

来自不同配置层的规则是拼接而非替换。仓库层只能贡献 `deny` 与 `ask` 规则；可信的
global/settings 层可以包含全部三种 action。

```json
{
  "permissionRules": [
    { "action": "deny", "tool": "*", "match": "**/*.pem" },
    { "action": "ask", "tool": "run_command", "match": "npm publish*" },
    { "action": "allow", "tool": "run_command", "match": "pnpm build" },
    { "action": "allow", "tool": "web_fetch", "match": "domain:docs.example.com" },
    { "action": "allow", "tool": "mcp__github__*" }
  ]
}
```

可通过 `config set` 设置？**不可以** —— 直接编辑文件、使用桌面端
**设置 → 权限规则**，或者让权限提示替你写入（见下文）。

桌面端编辑器按求值顺序列出项目配置与 `~/.seekforge/config.json` 中保存的规则，
并通过服务端（`/api/permission-rules`）逐条新增、编辑或删除。项目作用域只提供
`deny` 与 `ask`，已存在其中的 `allow` 规则会显示为“已忽略”；每次编辑都会指明
它要替换的条目，期间在别处发生的修改会让本次编辑被拒绝，而不是被覆盖。

#### 拒绝时附带理由

如果前端允许你在拒绝时输入一段说明，这段说明（去除首尾空白，最多 2,000 个字符）
会以 "The user said: …" 的形式附加到模型读到的拒绝信息里，让它下一次尝试可以照做，
而不必去猜。

#### 从权限提示保存规则

每一个权限提示都提供三种回答，而不是两种：

| TUI 按键 | Desktop / VS Code | 效果 |
| --- | --- | --- |
| `y` | Allow once | 只允许这一次 |
| `a` | Allow for session | 本次运行内允许该调用及同类调用（不落盘） |
| `A` | Always allow | 把规则写入 `~/.seekforge/config.json` |

「同类调用」的范围刻意很窄。对 shell 命令，它指同一条命令（可以多带参数）。
对文件工具，它指同一个工具作用于同一目录下（按符号链接解析后）的文件：批准
`src/a.ts` 覆盖 `src/b.ts`，但不覆盖 `src/sub/c.ts`、上级目录或另一个工具。对
`env`（L3）工具，以及命中 `ask` 规则的任何调用，根本不提供会话选项。

只有当提示同时把将要写入的那条规则原文展示出来时，第三个选项才会出现；展示的
规则就是落盘的规则。是否提出这条规则由 core 决定；没拿到规则的前端不会提供这个
选项，否则它就得自己编造要持久化的内容。
对于 core 不会记住的调用（`env` 级工具），`a` 和 `A` 都不会出现。在 TUI 中，
`N` 或 Tab 可附带输入的理由拒绝，core 会把理由附加到模型读到的拒绝信息里；
`/permissions` 会列出每条规则及其来源文件，并可向用户或项目配置添加规则
（项目配置只接受 `deny` 与 `ask`）或删除规则。

`seekforge serve`（因而也包括 Desktop）会把规则写入**运行服务端的那个账号**的
配置。这是同一个信任域：服务端只监听 127.0.0.1 且要求 bearer token，所以能回答
这个提示的人，本来就是启动它的那个账号。它比你手写时能写的范围更窄，这是刻意的：

- **只针对 shell 命令**（`run_command`、`run_tests`、`task_kill`）。命令是一年后
  你仍然认得的身份，而且 allow 规则按 token 边界匹配它，所以 `pnpm test` 永远不会
  覆盖 `pnpm test-all`。其他规则主体的锚点更弱：URL 前缀规则有意覆盖其所指位置下
  的所有子路径，而对一条由模型恰好请求的某个 URL 生成的规则来说，这就太宽了。
  路径被排除是出于相邻的理由：路径是一个内容会变化的位置，授权却比它的内容活得
  更久，而要放开编辑，`acceptEdits` 才是那个显式的方式。
- **绝不针对复合命令。** `pnpm test && curl … | sh` 不会被提供，因为 allow
  规则永远不会匹配含 shell 控制语法的命令：这条规则会保存下来、看起来像一次
  授权、却永远不会生效。
- **绝不针对含 `*` 的命令。** 它会被读回为通配符，授权范围超出你批准的那条命令。
- **绝不针对 `dangerous`。** 这类调用在任何提示之前就已被拒绝。

规则始终写入你自己的 `~/.seekforge/config.json`，而不是项目的 —— 仓库层只能
贡献 `deny` 与 `ask` 规则，写在那里的 allow 规则会保存成功、然后在每次加载时被剥离。
确认提示会写出文件路径，因为一条比本次运行活得更久的授权，必须是你能找到并
删除的。如果写入失败（配置无法解析、home 只读），批准会降级为会话级、运行
继续，并且失败会被报告而不是被吞掉。

### `mcpServers`

MCP（Model Context Protocol）服务器——与 Claude Code 兼容。每个条目把一个
服务器名映射到其配置。支持三种传输：stdio、Streamable HTTP 以及旧版 HTTP+SSE：

```typescript
type McpServerConfig = {
  /** Transport as Claude Code spells it; absent → "http" when url is set, else "stdio". */
  type?: "stdio" | "http" | "sse";
  /** Executable for stdio transport (e.g. "npx"). */
  command?: string;
  args?: string[];
  /** Extra env vars merged over the inherited environment (stdio only). */
  env?: Record<string, string>;
  /** Streamable HTTP (or, with type "sse", legacy SSE) URL; command/args/env ignored. */
  url?: string;
  /** Extra HTTP headers sent on every request (HTTP/SSE only). */
  headers?: Record<string, string>;
  /** Optional OAuth refresh-token flow. */
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

每个服务器恰好使用一种传输：写了 `type` 就用它；否则存在 `url` 时使用
Streamable HTTP，再否则由 `command` 定义一个 stdio 子进程。`command`、`args`、
`env` 的值、`url`、`headers` 与 `oauth` 的值都可以使用 `${VAR}` / `${VAR:-default}`；
只有来自用户级配置层的服务器、以及你已批准的项目服务器才会展开这些引用（见
[MCP](mcp.zh-CN.md#11-配置)）。

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
**settings > local > project > `.mcp.json` > global**。工作区根目录下的 `.mcp.json`
是 Claude Code 的项目服务器文件，只读取其中的服务器字段。项目、local 与 `.mcp.json`
条目的 `trusted` 始终会被移除，且永远不能占用用户级配置层已定义的名字。它们只有在你为
该工作区批准了这份确切的定义（`seekforge mcp approve`）之后才会自动连接；以这种方式批准的
stdio 服务器启动时会去掉看似密钥的环境变量，除非它自己的 `env` 点名了它们。全局配置或
显式 settings 中的条目带有 `trusted: true` 时自动连接。

可通过 `config set` 设置？**不可以** —— 使用 `seekforge mcp add/add-json/import/remove`
或直接编辑文件。

### `mcpToolSearchThreshold`

已连接 MCP 服务器的工具定义在被延迟加载之前，最多可占请求上下文预算的百分比
（0–100，默认 `10`）：超过后，MCP 工具只以名称和一行摘要的形式列在 `tool_search`
工具的描述中，由它为后续轮次加载完整 schema。`0` 总是延迟 MCP 工具，`100` 从不延迟。
内置工具永不延迟。超出 0–100 的值会在加载 MCP 服务器时被拒绝。见
[MCP → 工具搜索](mcp.zh-CN.md#110-工具搜索延迟加载的-mcp-工具)。

```json
{ "mcpToolSearchThreshold": 20 }
```

仅限用户级配置：仓库配置无法设置它。可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `hooks`

用户级 hook，在 agent 运行的固定时点执行——每次工具调用前后、权限提示时、会话开始/结束时、压缩前后，以及智能体即将结束时。**完整参考见 [Hook](hooks.zh-CN.md)**；这里只是摘要。

```typescript
type HooksConfig = Partial<Record<HookStage, HookEntry[]>>;

type HookStage =
  | "preToolUse"          // before every tool call, before any permission prompt — can refuse, allow, ask, rewrite
  | "permissionRequest"   // a call is about to prompt — can answer allow / deny for you
  | "postToolUse"         // after every tool call — receives the redacted result; can add model context
  | "postToolUseFailure"  // after a tool call that failed
  | "sessionStart"        // a top-level run starts — JSON additionalContext joins the task
  | "userPromptSubmit"    // for the task — can refuse the run; stdout joins the task as context
  | "preCompact"          // before compaction — can cancel a manual one
  | "postCompact"         // after compaction
  | "stop"                // the agent is about to finish — decision "block" keeps it working
  | "subagentStart"       // a dispatched subagent starts — JSON additionalContext joins its task
  | "subagentStop"        // a dispatched subagent finished
  | "notification"        // a permission prompt / ask_user question is shown
  | "sessionEnd";         // the top-level session ended

type HookEntry = {
  type?: "command" | "http" | "prompt"; // default "command"
  match?: string;     // tool / agent names: "*", "write_file|apply_patch", or an anchored regex
  pattern?: string;   // prefix of the raw command or path
  timeout?: number;   // seconds, 0 < timeout ≤ 600 (default 10; prompt 30)
  command?: string;   // command: run via /bin/sh -c, event JSON on stdin
  url?: string;       // http: POST target (http/https, redirects not followed)
  headers?: Record<string, string>; // http: ${VAR} expands only names in allowedEnvVars
  allowedEnvVars?: string[];
  prompt?: string;    // prompt: condition a model checks; $ARGUMENTS marks the event
  model?: string;
};
```

**阻断型阶段**：`preToolUse` 和 `userPromptSubmit` —— 失败的 hook（非零退出、非 `2xx` 响应、超时、没有判定）会拒绝该调用或本次运行。其余阶段只记录失败并继续。

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
        "command": "echo \"session ended in $SEEKFORGE_PROJECT_DIR\" >> /tmp/seekforge.log"
      }
    ]
  }
}
```

hook 条目会在可信配置层间对**所有**阶段按阶段拼接：**global → settings**。
仓库 hook 不生效；不合法的条目在加载配置时被丢弃。桌面端 Hook 编辑器写入 `~/.seekforge/config.json`：它直接编辑
`command`、`match` 与 `pattern`，其余条目字段（以及更新版本新增的阶段）原样保留，
并以可编辑的 JSON 值展示。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

#### Hook 输出协议

成功的 hook 可以输出（或响应）一个 JSON 对象；全部字段见 [Hook → 输出协议](hooks.zh-CN.md#输出协议)。简要如下：

| 字段 | 效果 |
| --- | --- |
| `permissionDecision` / `decision`（`preToolUse`） | `deny` 不经提示直接拒绝；`allow` 代为回答策略本会显示的提示（`ask` 规则要求的提示、复合 shell 命令除外）；`ask` 强制为本次调用弹出提示。所有 `preToolUse` hook 都会执行——后面的 `deny` 优先于前面的 `allow`。 |
| `updatedInput`（`preToolUse`） | 替换参数：重新按工具 schema 校验、重新分类并重新做权限检查。不合法的替换会让调用以 `invalid_hook_args` 失败。 |
| `hookSpecificOutput.decision.behavior`（`permissionRequest`） | 代你回答 `allow` / `deny`。 |
| `decision: "block"` + `reason` | `userPromptSubmit`：拒绝本次运行。`stop`：让智能体继续工作（`stopHookActive` 标记重复触发；每次运行最多 5 次）。`postToolUse(Failure)`：原因附在工具结果旁交给模型。`preCompact`：取消手动压缩。 |
| `additionalContext` | 给模型的上下文：追加到任务（`sessionStart`、`userPromptSubmit`）、子智能体任务（`subagentStart`）或工具结果旁（`postToolUse(Failure)`），包在经过转义的 `<hook-context>` 块中。 |
| `continue: false` + `stopReason` | 在工具阶段之后结束运行、拒绝提示 / 运行、取消手动压缩；`stopReason` 会显示给你。 |
| `systemMessage` | 作为提示显示给你。 |
| `suppressOutput` | 不把该 hook 的输出放进对话记录。 |

### `visionModel`

**默认关闭。** `image_analyze` 工具把图片发往的端点。主编码模型通常看不了图片
（DeepSeek 根本没有视觉模型），所以这里一般是另一个 provider、另一把 key ——
OpenAI 兼容格式，base URL 不带结尾的 `/chat/completions`。

```json
{ "visionModel": { "model": "qwen-vl-plus", "baseUrl": "https://…/v1", "apiKey": "sk-…" } }
```

本地无鉴权端点可以省略 `apiKey`。未设置时，`image_analyze` 会以
`vision_unconfigured` 失败，而不是假装自己看过那张图。

用户所有：它指定了一个凭据去向，因此仓库配置不能设置它。对所有前端生效 ——
CLI、TUI 和服务端一视同仁；在服务端它是**按工作区隔离**的，因为那个进程会同时
跑好几个工作区的 agent，共用一个端点会把某个项目的图片发到另一个项目的 provider。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `browserProfile`

**默认关闭。** 持久化浏览器会话 profile 的名字。设置后，浏览器工具会从
`~/.seekforge/browser-profiles/<name>.json` 载入，并在一次运行正常结束时写回，
于是登录过一次的站点就保持登录。未设置时，每次运行都从未登录状态开始，并在结束
时忘掉一切。

```json
{ "browserProfile": "work" }
```

它是名字而不是路径，而它指向的那个文件装着有效的会话 cookie —— 这个区别为什么
重要、如何用 `playwright codegen` 而不是让 agent 来生成这个文件、以及运行被取消
时会发生什么，见[浏览器 / 视觉验证](browser.zh-CN.md)。

所有前端都支持，包括 `seekforge serve` 与 Desktop。为此把浏览器会话本身改成了按
工作区隔离：Chromium 进程仍然只有一个，但每个工作区有自己的 context —— 这正是
Playwright 用来做隔离的原语，各自独立的 cookie 和页面。在此之前，同时跑多个工作区的
服务端会让它们共用同一个页面，profile 也就无从谈起「属于谁」。

可通过 `config set` 设置？**不可以** —— 直接编辑文件。

### `webSearch`

**默认关闭。** `web_search` 把查询发到哪里。按「谁更权威先问谁」的顺序尝试，你配置了哪一个，
它就排在没配置的前面：

| 后端 | 配置项 | 说明 |
| --- | --- | --- |
| Brave Search API | `braveApiKey` | 真正的搜索 API：JSON、一个 key、有免费额度。排第一 —— 会去配 key 的人，就是想让它来回答 |
| SearXNG | `searxngUrl` | JSON、无需 key、可自托管 |
| DuckDuckGo | 无 | 永远存在、永远垫底。抓取 HTML 页面 |

```json
{ "webSearch": { "braveApiKey": "BSA…", "searxngUrl": "http://localhost:8888" } }
```

在这些出现之前 `web_search` 只有一个提供方——抓取 DuckDuckGo 的 HTML 页面——而且没有任何
绕开的办法。一旦 DuckDuckGo 改版或返回拦截页，所有工作区的所有搜索都会返回空，没有任何
配置能补救。另外两条腿就是出路：一条你可以自托管，一条你可以花钱买。

**只有「没跑成」的后端才会交棒。** 搜索跑通了但没匹配到结果，这本身就是一个答案；再叫第二
个提供方来「唱反调」，只会把「确实没有」洗成噪音。工具现在会通过 `searched` 字段和返回的
note 说明到底是哪种情况，而不是用一句话把两种情况混在一起——「没有结果」应当相信，「被
提供方拦截」则意味着搜索根本没发生。

**这个键只从你自己的配置读取。** 它不在仓库 `.seekforge/config.json` 可以贡献的键里面
（见[配置层级](#配置层级)），因为一个能设置它的克隆仓库，就等于能决定模型从搜索里读回
什么。它同时是按工作区隔离的，所以同时服务多个项目的 server 不会把一个项目的搜索路由到
另一个项目的实例上。

可用 `config set` 设置吗？**否** — 请直接编辑文件。

### `lspServers`

**默认未设置。** `lsp_*` 工具使用的语言服务器，以名称为键（字母、数字、`.`、`_`、`-`）。
每个条目需要 `command`，以及 `extensionToLanguage`（`{ ".tf": "terraform" }`）或 `extensions`
加 `languageId` 二者之一；`args`、`env` 与 `initializationOptions` 可选。条目会替换它列出的
每个扩展名对应的内置服务器，并优先于插件为同一扩展名提供的服务器。无效条目会被跳过并给出警告。

```json
{ "lspServers": { "terraform": { "command": "terraform-ls", "args": ["serve"], "extensionToLanguage": { ".tf": "terraform" } } } }
```

**仅限用户配置** —— 仓库配置不能指定一个让 SeekForge 启动的命令。CLI、TUI 或服务器每次组装
agent 时都会按工作区应用。见 [LSP](lsp.zh-CN.md#配置语言服务器)。

可用 `config set` 设置吗？**否** — 请直接编辑文件。

### `claudeUserSkills`

**默认 `false`。** 设为 `true` 时，`~/.claude/skills/<name>/SKILL.md`（Claude Code 的用户技能
目录；设置了 `SEEKFORGE_HOME` 时在其下解析）中的技能会作为用户层技能加载，优先级低于
`~/.seekforge/skills`。项目中的 `.claude/skills` 无论如何都会读取。用户层技能在激活期间可以用
`allowed-tools` 预先批准工具，所以这是一个显式开关，且**仅限用户配置**。见
[技能](skills.zh-CN.md#claude-code-技能)。

```json
{ "claudeUserSkills": true }
```

可用 `config set` 设置吗？**否** — 请直接编辑文件。

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

`seekforge-tui` 同样接受 `--profile <name>`、`SEEKFORGE_PROFILE` 和
`--settings <file>`，信任规则相同；它没有 `config.local.json` 这一层，
因此 profile 只来自全局与项目配置文件。

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
时，项目配置中设置的 `model` 会被忽略。`apiKeyHelper` 只从用户级配置层读取，
它打印出的密钥排在 provider 密钥环境变量之后。

### 深合并字段

有三个字段跨层合并而非替换：

| 字段 | 合并策略 |
| --- | --- |
| `mcpServers` | 按服务器键合并，且**区分来源**。仓库层（`.seekforge/config.json`、`config.local.json`，以及两者中的 profile）可以新增服务器名，但绝不能覆盖用户级层已定义的名字；它们的条目一律失去 `trusted`，以及任何比 `write` 更宽松的 `permission`/`toolPermissions`。只有完整的用户级条目才能启用自动连接。这一点在每个界面上都成立——CLI、TUI、`seekforge serve`，以及经由服务器的 Desktop——因为四者走的是同一套分层代数，而层的来源是其类型的一部分。目前只有 CLI 会把这类收窄打印出来，其余界面只执行、不提示。 |
| `permissionRules` | 按高优先级在前拼接，但仓库层只能贡献有效的 `deny` 与 `ask` 规则。 |
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
| `provider` | string | `deepseek` / `ark` / `anthropic` / 预设名 |
| `runtimeBin` | string | 字符串 |
| `commandAllowlist` | string[] | 逗号分隔字符串（`"pnpm test, cargo build"`） |
| `sandbox` | enum | `off` / `read-only` / `workspace-write` / `restricted` |
| `compaction` | enum | `mechanical` / `llm` |
| `thinking` | boolean | `true` / `false` |
| `reasoningEffort` | enum | `low` / `medium` / `high` / `max`（空值表示清除） |

其余的键 —— `planModel`、`escalateOnFailure`、`maxCostUsd`、
`modelPricing`、`modelContextWindows`、`autoCompactThreshold`、`inlineImages`、
`verifyCommand`、`autoVerify`、`lintCommand`、`autoLint`、
`editFormat`、`claudeCompat`、`finalizeReview`、`guardNoProgress`、
`memoryAutoApproveConfidence`、`memoryMaintenance`、`permissionRules`、
`sandboxNetwork`、`additionalDirectories`、`mcpServers`、`hooks` —— **不可**通过
`config set` 设置。必须直接编辑 JSON
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
| `SEEKFORGE_API_KEY_HELPER_TTL_MS` | [`apiKeyHelper`](#apikeyhelper) 的密钥用多久后重新运行命令 | 毫秒，默认 `300000`；`0` 表示每次请求前都运行 helper |

`ARK_API_KEY`、`DEEPSEEK_API_KEY` 和 `SEEKFORGE_RUNTIME_BIN` 在
`loadConfig()` 的末尾应用，因此总是胜过任何文件或标志。`SEEKFORGE_PROFILE`
只决定叠加哪个 `profiles` 条目（显式的 `--profile` 标志优先于它）。

下面这些不映射到配置键——它们改变状态的存放位置，或改变某个界面的启动方式：

| 变量 | 作用 |
| --- | --- |
| `SEEKFORGE_HOME` | 用户级 SeekForge 状态的根目录，默认 `~/.seekforge`：记忆库、会话追踪、最近项目、文件夹授权记录都随它一起移动。给机器账号或测试运行分配独立状态时设置它。 |
| `SEEKFORGE_NO_BROWSER` | 任何非空值都会让 `seekforge mcp login` 不再拉起系统浏览器。授权 URL 始终会打印出来，因此这是 SSH 会话与无头机器上的走法。 |
| `SEEKFORGE_STATIC_DIR` | 显式指定 `seekforge serve` 要托管的、已构建的 Web UI 目录。Tauri 外壳会设置它，因为编译后二进制的虚拟文件系统会让「相对于 server 模块查找」的默认方式失效。 |
| `SEEKFORGE_DESKTOP_BOOTSTRAP_WORKSPACE` | Desktop 在用户尚未选定项目就启动 `serve` 时，所托管的占位工作区路径。 |
| `SEEKFORGE_SERVE_CMD` | Desktop 外壳要启动的完整命令行（按空白切分），用来替代在 `PATH` 上解析 `seekforge serve`。它优先于 `PATH` 查找，因此是调试本地构建服务端时的覆盖开关。 |
| `SEEKFORGE_WORKSPACE` | Desktop 打开的工作区目录，优先于进程的工作目录。 |
| `SEEKFORGE_ENABLE_TELEMETRY` | 设为 `1`（或 `true`）时开启 OpenTelemetry 导出使用指标与事件。默认关闭；配置它的 `OTEL_*` 变量见 [遥测](telemetry.zh-CN.md)。 |

### 代理与自定义证书颁发机构

provider 请求、HTTP 方式的 MCP 服务器、`web_search`、`image_analyze` 以及遥测导出
都使用 Node 的 `fetch`。只有当 Node 以 `--use-env-proxy` 或 `NODE_USE_ENV_PROXY=1`
启动时，它才会遵循 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`（大小写均可）——
启动之后再设置都不起作用。因此 `seekforge` 与 `seekforge-tui` 启动器会替你完成：
只要设置了上述代理变量之一，它们就会原地重启进程（PID、终端、参数都不变），加上
`--use-env-proxy`，并屏蔽 Node 为此打印的「experimental」警告。

- **Node 版本。** 需要同时具备 `--use-env-proxy`（22.21+ 或 24.5+）和
  `process.execve`（22.15+ 或 23.11+；Windows 上没有）的 Node。在 Windows 上，
  或从源码运行（`pnpm --filter seekforge dev`）时，请自行设置
  `NODE_USE_ENV_PROXY=1`。在更旧的 Node 上代理变量会被忽略、请求直连；
  `seekforge doctor` 会说明属于哪种情况。
- **以你的选择为准。** 只要 `NODE_USE_ENV_PROXY` 被设置为任何值（`0` 表示保持直连），
  或 `NODE_OPTIONS` 里已经有 `--use-env-proxy` / `--no-use-env-proxy`，启动器就什么也不做。
- **回环地址。** 除非 `NO_PROXY` 另有说明，Node 也会代理 `localhost`，这会把本地的
  Ollama、MCP 服务器或 OTLP 采集器的请求发给代理。当 `NO_PROXY` 与 `no_proxy`
  都未设置时，启动器会设置 `NO_PROXY=localhost,127.0.0.1,[::1]`（IPv6 地址必须加方括号）。
  agent 运行的命令会继承这个 `NO_PROXY`，但不会继承代理标志。
- **不支持：** `ALL_PROXY` 与 SOCKS 代理；Node 两者都不读取。
- **`web_fetch` 始终直连。** 它连接的是自己解析并对照私有网段检查过的地址；如果
  经由代理，代理会重新解析一次域名。在只能经代理出网的环境里，`web_fetch` 会像
  以前一样失败；`web_search` 可以正常工作。
- **Desktop 的 sidecar** 是 Bun 二进制，Bun 的 `fetch` 本身就遵循代理变量（同样包括
  回环地址，除非 `NO_PROXY` 列出了它们）。

对于企业内部或自签名的证书颁发机构，可将 `NODE_EXTRA_CA_CERTS` 指向一个 PEM 证书包，
或在 `NODE_OPTIONS` 中加入 `--use-system-ca` 以同时信任操作系统的证书库。Node 只在
启动时读取这两者，启动器的重启会保留它们。当 `NODE_EXTRA_CA_CERTS` 指向不存在的文件时，
`seekforge doctor` 会给出警告。

### 导出给 hook 子进程的变量

Hook 不是通过配置拿到这些值的；hook 运行器会把它们设置在子进程环境上，
因此 hook 脚本可以直接从自己的环境里读：

| 变量 | 取值 |
| --- | --- |
| `SEEKFORGE_HOOK_STAGE` | 触发本次 hook 的生命周期阶段。 |
| `SEEKFORGE_TOOL` | 触发工具的名称；阶段与工具无关时为空字符串。 |
| `SEEKFORGE_PROJECT_DIR` | 会话所在的工作区目录（也是 hook 的工作目录）。 |

这些变量只提供给 `command` hook；`http` 与 `prompt` hook 从 JSON 事件中获得同样的信息。

statusline 命令会收到另一组变量——见[状态栏](#状态栏)。

---

## 项目规则

指令文件会合并成系统提示词中的"项目规则"块。以下文件总是加载，顺序如下
（越靠后越贴近具体工作，冲突时以后者为准）：

| 顺序 | 文件 | 说明 |
| --- | --- | --- |
| 1 | `~/.seekforge/AGENTS.md` | 你对所有项目生效的规则。 |
| 2 | `~/.claude/CLAUDE.md` | 仅当 [`claudeCompat`](#claudecompat) 为 `"all"`。 |
| 3 | `AGENTS.md` | 项目规则，随仓库提交。 |
| 4 | `CLAUDE.md`、`.claude/CLAUDE.md` | Claude Code 兼容（默认开启）。 |
| 5 | `AGENTS.local.md` | 个人覆盖——请加入 gitignore。 |
| 6 | `CLAUDE.local.md` | Claude Code 兼容。 |
| 7 | `.seekforge/rules/**/*.md`，其后 `.claude/rules/**/*.md` | **不带** `paths:` 的规则文件，按路径排序。 |

工作推进到相关位置时才加载，每次运行各加载一次：

- **子目录的 `AGENTS.md`**（兼容模式下还有 `CLAUDE.md`）：任务文本提到该目录下的
  路径时进入系统提示词；否则在 agent 第一次读取或编辑该目录下的文件时
  （`read_file`、`write_file`、`apply_patch`、`notebook_read`、`notebook_edit`）
  加入对话。外层目录先于内层目录。依赖、构建产物、点目录以及被 `.gitignore`
  忽略的目录中的文件永远不会加载。
- **带 `paths:` 的规则文件**：agent 第一次读取或编辑匹配的文件时加入对话。
  `paths` 接受相对工作区的 glob（`**` 跨目录，`{a,b}` 表示多选；不含 `/` 的模式
  匹配任意深度的文件名），可写成 YAML 列表、方括号列表或逗号分隔字符串：

  ```markdown
  ---
  paths:
    - "src/api/**/*.ts"
    - "*.sql"
  ---
  API handler 在访问数据库前先用 zod 校验输入。
  ```

运行中加载的规则会在下一轮模型调用前以 `[harness]` 提示加入，事件流中显示为
`rules: <files>` 步骤。上下文压缩后，被丢弃的规则提示会重新加入。恢复会话后，
这些规则会在再次触及相关文件时重新加载。

**导入。** 内容恰好为 `@path` 的一行会被替换为该文件的内容，路径相对于所在文件
（最多 5 层；循环引用和已包含的文件会被跳过）。代码围栏内的行以及无法解析的导入
保持原样。项目文件只能导入工作区内的文件——不能用 `@~/…`、绝对路径或指向外部的
符号链接——任何规则文件都不能导入敏感文件（`.env`、密钥、`.seekforge/config.json`
等）。用户级文件（`~/.seekforge/AGENTS.md`、`~/.claude/CLAUDE.md`）可以导入主目录
中的文件，包括 `@~/path`。

**上限。** 内容（含导入）超过 256 KiB 的文件整体跳过，绝不部分注入。系统提示词中的
规则块上限为 384 KiB；运行中加载的规则每次运行另有 64 KiB 额度，放不下的规则文件
会以警告通知报告。相同内容只包含一次，因此内容与 `AGENTS.md` 相同（或导入它）的
`CLAUDE.md` 不会额外占用空间。

派发的子 agent 使用自己的提示词，不会收到这些文件。

---

## 文件工具

- **`list_files`、`search_text`、`glob`** 会跳过依赖和构建目录（`node_modules`、
  `.git`、`dist`、`build`、`target`、`vendor` 等），以及 `.gitignore`（根目录和
  子目录）或 `.git/info/exclude` 忽略的内容。取反（`!`）、仅目录（`/` 结尾）、
  锚定和 `**` 遵循 git 的规则；在仓库子目录打开的工作区同样遵循仓库的忽略文件。
  传入 `includeIgnored: true` 可包含被忽略的路径，或把被忽略的目录作为 `path`
  传入以查看其内部。固定目录列表在你指定的路径之下始终生效。
- **`read_file`** 读取文本的行为不变。图片（`.png`、`.jpg`、`.jpeg`、`.gif`、
  `.webp`，最大 3 MB，按字节内容判断类型）会附加到结果中，供支持图片的模型查看
  （见 [`inlineImages`](#inlineimages让模型自己看截图)）。PDF 通过 poppler 的
  `pdftotext` 按页返回文本（`pages: "1-5"`，每次最多 20 页；默认前 20 页）。
  `PATH` 上没有 `pdftotext` 时读取失败并给出安装提示；工作区内的 `pdftotext`
  永远不会被使用。
- **先读后改。** 在 agent 运行中，`apply_patch` 和带 `overwrite: true` 的
  `write_file` 会拒绝修改本会话中 agent 尚未读取过的已有文件（`file_not_read`），
  或自上次读取/写入后在磁盘上发生变化的文件（`file_changed`，按内容比较，单纯
  `touch` 不算变化）。agent 自己写入的文件无需重读，新建文件不受影响。同一会话的
  后续消息会记住已读取的文件。你只批准补丁的部分 hunk 后，agent 必须先重读该文件
  才能再次编辑。直接驱动工具调度器的 SDK 调用方和 `seekforge mcp-serve` 不受此限制。
- **`apply_patch` 的 `replaceAll`。** 带 `replaceAll: true` 的编辑会替换
  `oldString` 的每一处精确出现（至少一处），而不要求唯一匹配；它从不使用
  容忍空白的回退匹配。逐 hunk 审批提示会把这类编辑标注为"(every occurrence)"。

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

### 其它仅 TUI 生效的键

这些键只被 `seekforge-tui` 读取。它们早在本节存在之前就已生效；漂移门禁现在会同时
读取 `TuiConfig` 与 `ServerConfig`，因此只在某一个面生效的键不会再无文档地交付。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `accent` | 主题默认 | 强调色，可用任意 Ink 颜色名。`SEEKFORGE_TUI_ACCENT` 优先。 |
| `bell` | `true` | 权限提示与运行结束时响终端提示音。 |
| `notify` | `true` | 同样事件下发系统通知（macOS 用 `osascript`，Linux 用 `notify-send`）。把 `notify` 设为 false、`bell` 保持 true，就只保留提示音。 |
| `vim` | `false` | 启动时进入 vim 模式；运行中用 `/vim` 切换。 |
| `mouse` | `false` | 捕获鼠标以支持滚轮滚动。默认关闭，因为捕获鼠标会让终端无法选中文本。 |
| `costBudgetUsd` | 未设置 | 观测到的累计成本达到该值时停止该标签页的运行。 |
| `llmCache` | `false` | 把内容相同的非流式 provider 调用缓存到 `~/.seekforge/llm-cache`。面向评估与大量子代理的场景，不适合日常会话。 |
| `routing` | 未设置 | 兼容用的对象，内含 `routing.planModel`，是 `planModel` 的旧写法；两者同时存在时以扁平的 `planModel` 为准。 |

### 服务端运行保留策略

仅 `seekforge serve` 读取，作用于持久化运行台账。`docs/cli-reference.zh-CN.md`
中 `--loop-auto-prune` 的描述用的就是这两个数字。

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `runRetentionMaxCount` | `500` | 台账中保留的终态运行条数。非终态运行始终保留。 |
| `runRetentionMaxAgeDays` | 未设置 | 终态运行的可选年龄上限。省略则只按数量保留。 |
