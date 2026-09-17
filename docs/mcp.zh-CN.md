# MCP（Model Context Protocol）指南

> [English](mcp.md) | **简体中文**

SeekForge 同时实现了 Model Context Protocol（MCP）的两端：

- **客户端模式（Client mode）** —— 连接外部 MCP 服务器（stdio、Streamable HTTP
  或旧版 HTTP+SSE 传输），并将其 tools、resources 和 prompts 提供给 agent 使用。
- **服务器模式（Server mode）** —— 将 SeekForge 自身作为 MCP 服务器运行在 stdio 上，
  让其他 agent 可以使用本工作区的内置工具。

---

## 1. 客户端模式 —— 使用 MCP 服务器

agent 通过三个通道与已配置的 MCP 服务器交互：**tools**（主要通道）、
**resources**（通过 URI 寻址的可读文档）和 **prompts**（服务器定义的模板）。

### 1.1 配置

MCP 服务器在 `~/.seekforge/config.json`（用户级）、`.seekforge/config.json`
（项目级）或 `.seekforge/config.local.json`（仅本检出目录）的 `mcpServers` 下声明。
Claude Code 的项目文件——工作区根目录下的 `.mcp.json`——同样会被读取。

随检出目录一起分发的一切——两个项目文件以及 `.mcp.json`——都**只是定义，而非授权**：
仓库配置不能授予自身自动启动权限，因此项目里的 `trusted: true` 会被忽略。项目服务器
只有在**你为该工作区批准它**之后才会自动连接（`seekforge mcp approve <name>`，见 §1.7）。
用户配置中的服务器带有 `trusted: true` 时自动连接。

配置格式与 Claude Code 兼容：

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      // Optional: extra environment variables merged over process.env (stdio only)
      "env": { "MY_VAR": "value" },
      // SeekForge-specific: controls permission level (default false)
      "trusted": false,
      // 可选的保守服务器默认值，以及按原始工具名设置的覆盖
      "permission": "write",
      "toolPermissions": { "read_file": "readonly", "delete_file": "dangerous" }
    },
    "web-search": {
      // Streamable HTTP transport — selected by the presence of "url"
      // (or explicitly with "type": "http")
      "url": "https://example.com/mcp",
      // Optional: extra HTTP headers sent on every request
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      },
      // Optional refresh-token flow. Secrets should use environment refs;
      // refreshed access tokens stay in memory and are never persisted.
      "oauth": {
        "tokenEndpoint": "https://example.com/oauth/token",
        "clientId": "${MCP_CLIENT_ID}",
        "clientSecret": "${MCP_CLIENT_SECRET}",
        "refreshToken": "${MCP_REFRESH_TOKEN}"
      }
    },
    "linear": {
      // Legacy HTTP+SSE transport (MCP 2024-11-05) — only an explicit type selects it
      "type": "sse",
      "url": "https://mcp.linear.app/sse"
    }
  }
}
```

**传输方式选择**（按服务器逐项判定，互斥）：

| `type` | 未写 `type` 时 | 传输方式 | 生效字段 |
|---|---|---|---|
| `"stdio"` | 没有 `url` | stdio | `command`、`args`、`env` |
| `"http"` | 有 `url` | Streamable HTTP | `url`、`headers`、`oauth` |
| `"sse"` | —— | 旧版 HTTP+SSE | `url`、`headers`、`oauth` |

服务器需要 `command`（stdio）或 `url`（HTTP/SSE）；两者皆无、或写了其他 `type` 的定义
会被报告为无效，永不连接。旧版 SSE 传输打开一条 `GET <url>` 事件流，等待服务器的
`endpoint` 事件，再把每条消息 POST 到那里；公布的 endpoint 必须与 `url` 同源，因为这些
POST 带着同样的 header 和 bearer token。

**`.mcp.json`** —— `{ "mcpServers": { name: { "command", "args", "env" } |
{ "type": "http" | "sse", "url", "headers" } } }` —— 作为位于 `.seekforge/config.json`
之下的仓库层读取：只保留这些字段（Claude Code 自己的 `oauth` 段描述的是另一套流程，
会被丢弃）；SeekForge 自己的项目文件也定义了的名字以后者为准；你的用户配置已定义的
名字则被整体忽略。

**`${VAR}` 引用。** `command`、`args`、`env` 的值、`url`、`headers` 与 `oauth` 的值
可以用 `${VAR}` 或 `${VAR:-default}` 引用进程环境变量（变量未设置或为空时取默认值）。
只有来自你的用户配置的服务器、或你已批准的项目服务器，其引用才会展开；未批准的项目
定义按字面使用——这样检出目录就无法在你没看过模板的情况下，把某个环境变量拷进 URL 或
header。`seekforge mcp get` 和批准提示始终展示未展开的定义。

**stdio 服务器的环境。** 来自用户配置的服务器继承完整环境，与 Claude Code 一致。
已批准的项目服务器继承的环境会去掉看起来像密钥的变量（`*_API_KEY`、`*_TOKEN`、
`*_SECRET`、`*PASSWORD*` 等——与 `run_command` 使用的是同一张表），但它自己 `env`
段里点名的变量除外——批准时你已经看到了它们：

```jsonc
{ "mcpServers": { "gh": { "command": "gh-mcp", "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } } } }
```

### 1.2 CLI 命令

#### `seekforge mcp list [--tools] [-y]`

启动已配置的服务器，执行 initialize 握手，并打印各服务器的工具名。
某个服务器失败时会内联显示错误，列表继续输出。加上 `--tools` 后，
还会显示每个工具描述的第一行。每一行还会标明该条目是「来自本仓库」还是
「来自你的配置」。

**「列出」不是只读操作：每一个被列出的服务器都会被启动。** 因此检出目录定义的服务器
只有在你为本工作区批准了这份确切的定义之后才会被启动；待批准和已拒绝的服务器只打印
其命令或 URL，**不会启动**，即使加了 `-y` 也一样。即将启动已批准的仓库服务器时，
`mcp list` 还会要求与 `seekforge run` 相同的文件夹访问授权；`-y` 可以预先授权，这正是
CI 需要的。来自你自己的全局配置或 `--settings` 的服务器则不会触发提示。

```text
$ seekforge mcp list --tools
filesystem  (npx -y ..., untrusted, from your config)  2 tool(s)
  read_file  Read the complete contents of a file from the file system
  write_file  Write text content to a file at a specified path
docs  （http https://docs.example/mcp，待批准，来自本仓库）  未启动 —— 先用 `seekforge mcp get docs` 审查，再运行 `seekforge mcp approve docs`
```

#### `seekforge mcp get <name>`

打印单个服务器的来源、状态（受信任/不受信任；项目服务器则为已批准/待批准/已拒绝）、
传输方式，以及原样的定义——`${VAR}` 引用不展开。不启动任何东西。

#### `seekforge mcp add [选项] <name> <命令或 URL...>`

添加一个服务器。选项写在 `<name>` **之前**；名字之后的一切都是服务器自己的命令行
（因此 `-y` 属于 `npx`，而不是 SeekForge）。

| 选项 | 含义 |
|---|---|
| `-t, --transport stdio\|http\|sse` | 默认 `stdio`：`<name>` 之后的第一个 token 是命令，其余是参数。`http`/`sse`：恰好一个 URL。 |
| `-s, --scope user\|project\|local` | 写到哪里：`~/.seekforge/config.json`、`.seekforge/config.json`（默认）或 `.seekforge/config.local.json`。 |
| `-g, --global` | 等同 `--scope user`。 |
| `-e, --env KEY=VALUE` | stdio 服务器的环境变量，可重复。 |
| `-H, --header "Name: value"` | http/sse 服务器的 HTTP 头，可重复。 |
| `--trust` | 让它自动连接：用户作用域写入 `"trusted": true`；项目作用域则为本工作区批准刚写入的这份定义。 |

不加 `--trust` 时，用户作用域的服务器不受信任，项目作用域的服务器处于待批准状态；
CLI 会说明是哪一种。

```text
seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .
seekforge mcp add --transport http -H "Authorization: Bearer \${DOCS_TOKEN}" -g --trust docs https://docs.example/mcp
seekforge mcp add --transport sse --scope local linear https://mcp.linear.app/sse
```

#### `seekforge mcp add-json [--scope …] [-g] [--trust] <name> '<json>'`

以 Claude Code 格式的 JSON 添加一个定义（`{"type":"http","url":"…","headers":{…}}`、
`{"command":"…","args":[…]}`）。未知字段会被拒绝。项目/本地作用域的条目不能带
`trusted`；请改用 `--trust` 批准它。

#### `seekforge mcp import [--from claude-desktop|claude-code] [-y] [--no-trust]`

把 Claude Desktop（macOS 上为
`~/Library/Application Support/Claude/claude_desktop_config.json`，Windows 上为
`%APPDATA%\Claude\…`，其他平台为 `~/.config/Claude/…`）以及 Claude Code 的
`~/.claude.json`——其用户作用域的 `mcpServers`，加上它为**当前**项目保存的条目——中的
服务器定义复制到你的用户配置。不写 `--from` 时两处都读；同名出现两次时保留先找到的定义。

命令会在请求确认之前打印它将写入的每个服务器（以及跳过某个的原因：你的配置里已有、
定义无效或重名）；`-y` 跳过的是提问，而不是列表。SeekForge 没有对应位置的字段会被丢弃
并点名，包括 Claude Code 的 `oauth` 段（这类服务器请用 `seekforge mcp login`）。

**导入的服务器会标记为 `"trusted": true`。** 它们来自你自己的配置文件，在那里本就在运行，
而且你刚看过每一份定义；`--no-trust` 则以不受信任的方式导入。任何仓库的 `.mcp.json`
都不会被导入——请按工作区逐个批准。

#### `seekforge mcp approve <name> [-y]` · `mcp reject <name>` · `mcp reset-project-choices`

为本工作区决定检出目录定义的服务器。`approve` 打印原样的定义并在记录前询问
（`-y` 跳过提问）；`reject` 记录它不得连接，从而不再显示为待批准；
`reset-project-choices` 清除本工作区的所有决定。你自己配置中定义的名字会被拒绝——
请在那里信任它。见 §1.7。

#### `seekforge mcp remove <name> [--scope …] [-g]`

从所选作用域（默认项目）删除一个服务器。

#### `seekforge mcp login <name> [-y]`

对「配置了 `url` 但没有 `oauth` 段」的远程服务器执行交互式 OAuth 2.1
授权码流程（PKCE，`S256`）。

名字是你选的，而那个条目指向哪个 `url` 是配置它的人选的。仓库层永远无法改指你
已经拥有的服务器名，但**只有检出目录定义的名字**，其 origin 仍然由它提供——而本
命令会去那个 origin 做发现、注册客户端、并把你的浏览器打开到它指定的授权页。因此
当条目来自仓库时，`mcp login` 会先打印它将把你带到哪里，并要求与 `seekforge run`、
`mcp list` 相同的文件夹访问授权；`-y` 可预先授权。来自你自己的全局配置或
`--settings` 的条目不会触发提示。条目 `url` 中的 `${VAR}` 只对你自己的条目和已批准的
项目条目展开（§1.1），存储的凭据以实际访问的 URL 为键。

流程本身：

1. 先从 `/.well-known/oauth-protected-resource` 解析授权服务器（缺失时回退到
   MCP 服务器自身 origin），再读取其
   `/.well-known/oauth-authorization-server` 元数据。
2. 在 `127.0.0.1` 上绑定一次性回调监听端口，并针对该确切 redirect URI 动态
   注册客户端（RFC 7591）；服务器不支持动态注册时用 `--client-id` /
   `--client-secret` 指定预注册客户端。
3. 打开浏览器，接受唯一一次回调，并用 PKCE verifier 兑换授权码。
   `--scope` 可覆盖服务器公布的 scope。

得到的刷新令牌写入 `~/.seekforge/mcp-oauth.json`（权限 `0600`，仅属主可读），
按「服务器名 + URL」双键存储——**不会**写进会被提交与共享的
`.seekforge/config.json`。因此把同一个服务器名指向新 URL 后必须重新登录。

每一跳都会在使用前重新校验：端点必须是 `https`（loopback 允许 `http`）、
元数据的 `issuer` 必须与发现来源同源、回调 `state` 采用常量时间比较、
公布 PKCE 但不支持 `S256` 的服务器直接拒绝。

```text
$ seekforge mcp login docs
授权服务器：https://auth.example.com/
正在打开浏览器完成授权（若未自动打开，请手动粘贴以下地址）：
  https://auth.example.com/authorize?response_type=code&...
已将「docs」的凭据保存到 ~/.seekforge/mcp-oauth.json
```

#### `seekforge mcp logout <name>`

删除该服务器已存储的凭据。配置中声明的 `oauth` 段不受影响。

### 1.3 配置分层

配置合并顺序（后者优先）为：

```text
settings file  >  .seekforge/config.local.json  >  project .seekforge/config.json  >  .mcp.json  >  global ~/.seekforge/config.json
```

合并以**服务器名**为单位，而不是以服务器条目内部的字段为单位：高优先级层若定义了
`myserver`，就会**整条替换**该条目，而不会逐字段合并。逐字段合并是**刻意不做**的：
那会把仓库层的 `args`、`env`、`url` 或 `oauth` 拼进一条仍然带着你 `trusted: true`
的条目里。只有在你打算完整替换该条目时，才在高优先级层重新定义一个服务器。

由于仓库层在优先级上位于全局配置**之上**，有两条规则约束它们：

- **仓库层可以新增服务器名，但绝不能改指你已拥有的名字。** 如果
  `.seekforge/config.json`（或 `config.local.json`、`.mcp.json`）定义了一个
  `~/.seekforge/config.json` 或你的 `--settings` 文件已经定义的名字，仓库中的定义
  会被忽略，并且 SeekForge 会明确告知。克隆下来的仓库无法改指你已配置服务器的
  `command`、`url`、`headers` 或 `oauth`。
- **仓库层只能让自己的条目更严格。** `trusted` 会被剥掉，比 `write` 更宽松的
  `permission` / `toolPermissions`（即 `readonly`）会被丢弃——因此仓库无法预置一条
  「永不询问」的条目，再借你复制到全局配置的动作把它一起带过去。

这一点在每个界面上都成立——CLI、TUI、`seekforge serve`，以及经由服务器的 Desktop
——因为四者走的是同一套分层代数，而层的来源是其类型的一部分。目前只有 CLI 会把这类
收窄**打印**出来，其余界面只执行、不提示。

仓库定义根本无法遮蔽全局条目——上面那条规则会忽略它——而单独存在的仓库条目在你批准之前
始终不会连接；信任不会跨该边界继承。完整的分层模型见
[cli-reference.zh-CN.md](cli-reference.zh-CN.md#设置分层)。

### 1.4 工具命名

每个 MCP 服务器的工具都以带命名空间的名称注册到 agent 的工具分发器中：

```text
mcp__<server>__<tool>
```

示例：

| 配置键        | 服务器工具   | 注册名称                       |
|---|---|---|
| `filesystem`  | `read_file`  | `mcp__filesystem__read_file`  |
| `filesystem`  | `write_file` | `mcp__filesystem__write_file` |
| `web-search`  | `search`     | `mcp__web-search__search`     |

只有当这种简单形式既无歧义又是合法工具名时才会采用：长度不超过 64 个字符、匹配
`^[A-Za-z0-9_-]+$`，且服务器名与工具名都不含 `__`（否则三段式拆分会产生歧义）。
其余情况——名字过长、含空格/点号/斜杠，或服务器名形如 `a__b`——都会回退到经过
净化且抗碰撞的形式：每一段只保留 `[A-Za-z0-9_-]`，分别截断（服务器名 15 个字符、
工具名 25 个字符），并追加 `sha256(server, tool)` 的前 10 位十六进制摘要：

```text
mcp__<safe-server>__<safe-tool>__<10 位十六进制摘要>
```

摘要由原始名称计算得出，因此映射在多次运行之间保持稳定，两个净化后文本相同的工具
也仍会得到不同的名字。

服务器 `tools/list` 响应中的 `inputSchema` 会作为 `parametersOverride`
原样透传给模型，因此模型看到的是真实的参数 schema。本地校验使用
`z.object({}).passthrough()` —— 实际校验委托给 MCP 服务器执行。

### 1.5 协议版本

客户端声明的协议版本为 `2025-06-18`（当前稳定的 MCP 修订版）。只支持旧版本的
服务器可以在响应中返回自己的 `protocolVersion` 来协商降级 —— 客户端会接受该值，
不强制版本完全一致（版本回退，version-fallback）。版本回退路径已针对一个
`2024-11-05` 服务器进行了测试。

`initialize` 中发送的客户端信息：

```json
{ "name": "seekforge", "version": "1.0.0" }
```

### 1.6 能力（Capabilities）

两种传输都在其 initialize capabilities 中声明 `roots.listChanged: true`。
工作区路径（启动时传入的绝对目录）通过 roots 能力告知每个服务器，并在服务器
发起的 `roots/list` 请求时作出应答——stdio 直接应答；HTTP 则在初始化后、
服务器支持时保持的那条独立 GET SSE 流上应答。初始化之后，HTTP 请求会带上协商得到的
`MCP-Protocol-Version` 头。Streamable HTTP 的响应必须是 JSON-RPC 对象，
且其 id 与待处理请求匹配；标量、数组、null 以及 id 不匹配的响应都会被拒绝。
配置了 `oauth` 时，HTTP 401 会触发一次符合标准的 `refresh_token` 交换，
并将原请求重试一次。配置中声明的凭据永不回写，刷新到的 access token 只留在
内存中。若没有 `oauth` 段，则改用 `seekforge mcp login` 存储的凭据，并就地续期：
轮换后的 refresh token 会被持久化；若响应未返回新的 refresh token，则保留原有
的而不是丢弃。因此无人值守的进程需要先完成一次 `mcp login`，或在启动前准备好
refresh token 或静态 header。

#### 采样（sampling）与征询（elicitation）

还有两种请求由服务器发往客户端，而且**只有当前端确实接上了应答通道时才会被声明**。
什么都没接的客户端会把该能力报告为不存在，符合规范的服务器就不会发问；万一它仍然发了，
拿到的是 JSON-RPC `-32601`，而不是一直挂着。

| 能力 | 方法 | 何时接上 | 会发生什么 |
| --- | --- | --- | --- |
| `sampling` | `sampling/createMessage` | 前端有确认通道 | 服务器的 prompt 会原样（截断后）展示给你，你批准后用你自己的模型执行。 |
| `elicitation` | `elicitation/create` | 前端有向用户提问的通道 | 服务器的问题会抛给你，你的回答被返回。 |

「是否配置了模型」是另一个问题，它在请求真正到达时才回答，而不是在声明能力时。
CLI 与 TUI 用本次运行自己的配置构建采样 provider，没有 API key 时干脆不声明该能力；
`seekforge serve` 则惰性解析 provider（MCP 客户端先于持有 provider 的 agent deps 建立），
因此它始终声明 sampling，若最终没有配置模型则以 `mcp_sampling_unavailable` 应答。

**采样花的是你的 token，跑的是你没写过的 prompt**，因此**每一次**都要确认——这里没有
审批模式的旁路，只有你的前端 confirm 本身的行为（所以无头 `-y` 运行会批准它，
就像 `-y` 批准其他一切一样）。确认提示会写明是哪个服务器、用哪个模型、发送什么文本。
这次调用花了多少会计入会话自身的合计：它会出现在 `usage.updated`、会话记录以及前端
展示的成本里——和你付费的其他每一个 token 在同一个地方。已发布的每个前端都是这样做的。
若嵌入方没有提供用量接收端，则退回到兜底行为：每次调用向 stderr 打印一行：

```text
[mcp:<server>] sampling used <n> tokens ($x.xxxx)
```

两者是二选一而非同时发生：负责记账的前端不会再打印这一行。

采样用的 provider 与 agent 用的来自同一份配置，但是独立实例：服务器发起的模型调用不会
混进 agent 的重试总线与响应缓存。请求在抵达模型之前先被限界：最多 50 条消息、
200,000 字符，且只接受文本部分。同一个服务器最多只能同时挂起 4 个 sampling/elicitation 请求——每一个在结束前都占着一个人或一次付费模型调用——超出的会被告知稍后重试。

**征询**通过 `ask_user` 工具用的同一个通道来回答：布尔与枚举字段变成选项，其余字段
让你直接输入。只要有任何一个字段被拒绝，整个请求就按拒绝处理——服务器会拿到什么就
照做什么，填一半的表比不填更糟。请求的 schema 必须如规范要求那样是一层扁平的原始
类型对象，任何嵌套都会被拒绝。

所有有用户可问的形态都接上了：CLI（`seekforge run`、REPL）、本地 server（桌面端与
Web 工作台，经 WebSocket 的确认/提问通道），以及 TUI。TUI 在应用渲染之前就启动了 MCP
服务器，因此它的 handler 会路由到当前占据屏幕的那次运行；如果请求到达时没有任何运行
在进行，它会被拒绝，而不是被错投到别处。

#### 列表变更

服务器可以宣告某个列表变了。收到 `notifications/tools/list_changed` 时，客户端会重新
列出该服务器的工具；正在运行的 agent 从**下一个 provider 轮次**起就能看到新的工具集。
一次改变了自身服务器列表的工具调用（服务器在应答前发出了通知）会最多等待两秒让刷新完成，
因此紧接着的下一轮就已包含新工具。工具名只由服务器名与工具名决定，所以刷新永远不会给
模型已知的工具改名；列表原样返回时请求也完全不变。`prompts/list_changed` 与
`resources/list_changed` 会转交给前端（registry 的 `subscribe`），由前端重新读取它展示的列表。

`tools/list`、`resources/list` 和 `prompts/list` 会逐页消费每个不透明的
`nextCursor`。重复出现的 cursor 会被拒绝，发现过程上限为 100 页和 10,000 条，
因此格式错误或恶意的服务器无法制造无限循环或无上限的目录内存分配。

### 1.7 信任模型

连接服务器会启动本地进程或访问某个端点，因此自动连接需要有人为这份定义作保：

| 服务器定义在哪里 | 何时自动连接 | `${VAR}` 引用 | stdio 环境 |
|---|---|---|---|
| 你的用户配置 / `--settings` | 带有 `"trusted": true` | 展开 | 完整继承 |
| 检出目录（`.seekforge/config.json`、`config.local.json`、`.mcp.json`） | 你为**本工作区**批准了**这份确切的定义** | 展开 | 去掉看似密钥的变量，其 `env` 点名的除外 |
| 检出目录，未批准（待批准或已拒绝） | 永不 | 按字面保留 | —— |

**批准记录**保存在 `~/.seekforge/mcp-project-approvals.json`（仅属主可读写），任何检出
目录都无法写入它；以工作区的真实路径和定义原样（引用不展开、忽略 `trusted`、其余字段
全部计入）的 SHA-256 摘要为键。修改定义——多一个参数、换一个 URL、加一个 header——
服务器就会重新变成待批准，直到你批准新的定义。CLI 用 `seekforge mcp approve` / `reject` /
`reset-project-choices` 管理它们；前端调用同一组 core 函数（`approveProjectMcpServer`、
`rejectProjectMcpServer`、`resetProjectMcpChoices`、`listProjectMcpServers`），并通过
registry 的 `reconnect(name)` 让决定在运行中的会话里生效。
`seekforge mcp add --trust` 会批准它写入的内容，`mcp import` 会把导入的服务器标为受信任（§1.2）。

连接后，受信任或已批准服务器的工具依次使用按原始工具名设置的覆盖、服务器默认值、
MCP 注解（`destructive`/`openWorld` 升到 `env`，`readOnly` 映射为 `readonly`），最后回退
到 `write`。仓库条目的 `permission` / `toolPermissions` 只能比这更严格（§1.3）。为显式管理
操作而连接、却不具备上述任一身份的条目始终使用 `env`，不能通过注解降低权限。

Desktop 的服务器测试/工具查看等显式管理操作仍可连接用户主动选择的未信任条目，因为
用户已经发起了这一次准确的连接；这样的连接不展开任何引用，并使用去除密钥后的环境。
`seekforge mcp list` 只启动具备身份的条目（见 §1.2）。

工具结果把文本保留在 `content` 中，保留有界且脱敏的 `structuredContent`，并在
`attachments` 中描述二进制内容。**图片**部分（PNG、JPEG、GIF、WebP；每个结果最多 8 张、
每张不超过 1 MiB）会作为附着在该工具结果上的图片交给模型——是否真正发送由 provider
决定，与浏览器截图相同——其描述信息会标明 `attached: true`。音频、其他二进制类型以及
超出上述限制的图片仍只保留描述信息；模型读到的文本里不会出现任何 base64 载荷。

### 1.8 Resources

已配置 MCP 服务器的资源可以列出和读取。每个资源都会标注其所属服务器名。

只要有服务器已连接，agent 就有两个相应的工具：

| 工具 | 参数 | 结果 |
|---|---|---|
| `list_mcp_resources` | `server?` | `{ resources: [{ server, uri, name?, description?, mimeType? }] }`，最多 200 条；失败的服务器记录在 `errors` 中 |
| `read_mcp_resource` | `server`、`uri` | `{ server, uri, note, contents: [{ uri?, mimeType?, text }] }`；文本上限 50,000 字符，图片 blob 作为图片附上，其他 blob 仅描述 |

对受信任和已批准的服务器，两者都以 `readonly` 运行（不提示）——读取资源与读取文件
同等对待；其他情况为 `env`。资源内容是来自服务器的数据：结果中会明确说明，密钥会被
脱敏，其中的指令不会被执行。

编程接口如下：

- **`listMcpResources(entries)`** —— 返回所有已连接服务器上每个资源的
  `{ server, uri, name }`。失败的服务器会记录一条警告并贡献零条记录。
- **`readMcpResource(server, uri, entries)`** —— 从指定服务器按 URI 读取
  一个资源。响应会被展平为文本（二进制/blob 部分变为
  `[binary content: image/png]`）。文本软上限为 50,000 字符
  （`RESOURCE_READ_MAX_CHARS`）；超长响应会被截断并附加 `…[truncated]` 后缀。

TUI 和 Server/Desktop 运行会在任务到达模型之前，为每条消息展开最多五个
`@mcp:<server>:<uri>` 引用。读取失败会以有界的「资源不可用」块的形式包含在内，
而不会中止整个运行。资源正文会被序列化到显式的不可信数据（untrusted-data）
封套中；其中内嵌的指令不会成为用户指令，也不会改变权限策略。

### 1.9 Prompts

已配置 MCP 服务器的 prompts 可以列出和调用。每个 prompt 都会标注其所属服务器名：

- **`listMcpPrompts(entries)`** —— 返回所有已连接服务器上每个 prompt 的
  `{ server, name, description, arguments? }`。
- **`getMcpPrompt(server, name, args?, entries)`** —— 获取一个 prompt 的消息，
  展平为单个字符串（每条消息一行 `role: content`），上限 50,000 字符。

TUI 提供 prompt 命令。桌面端设置页会列出 prompt 模板，收集其声明的参数，
通过工作区作用域的 server API 完成解析，并将渲染后的 prompt 插入到聊天输入框中。

### 1.10 工具搜索（延迟加载的 MCP 工具）

每个请求都携带全部工具定义，而少数几个 MCP 服务器带来的定义 token 就可能比对话本身还多。
当已连接服务器的工具定义超过请求上下文预算的 **`mcpToolSearchThreshold`**%（默认 10）时，
它们会被**延迟加载**：

- 每个 MCP 工具只以 `名称: 一行摘要` 的形式列在 `tool_search` 工具的描述里；
- `tool_search` 接受 `query`——关键词，或用 `select:name1,name2` 指定确切名称——以及
  `max_results`（默认 5，最多 20）；它返回匹配工具的完整 schema 并将其**加载**，
  从下一个 provider 轮次起这些工具会以完整定义出现；
- 调用一个尚未加载的延迟工具会以 `tool_not_advertised` 失败，消息会告诉模型先用
  `select:<该名称>` 调用 `tool_search`。

内置工具和两个资源工具始终完整公布。`mcpToolSearchThreshold: 0` 总是延迟 MCP 工具；
`100` 则从不延迟。已加载的工具在会话剩余时间内保持加载。索引只在某个服务器的工具列表
变化时才会改变，但每次加载都会改变公布的工具集，从而开启新的提示缓存前缀——这是不必
每轮都为每份 schema 付费的代价。带有精确 `allowedTools` 列表的运行永不延迟。

`tool_search` 本身以 `readonly` 运行：它只读取 SeekForge 已持有的目录，不访问任何服务器。

---

## 2. 服务器模式 —— 将 SeekForge 作为 MCP 服务器运行

### 2.1 CLI

```text
seekforge mcp-serve [--allow-write]
```

将 SeekForge 作为 MCP 服务器运行在 **stdio** 上（按换行分隔的 JSON-RPC 2.0），
使用与客户端传输相同的分帧方式。协议流量走 stdout；所有诊断信息走 stderr。
服务器会保持存活，直到客户端关闭 stdin。

启动时会向 stderr 写入一条消息：

```text
seekforge mcp-serve: read-only on /path/to/workspace
```

或在使用 `--allow-write` 时：

```text
seekforge mcp-serve: FULL ACCESS (trusted callers only) on /path/to/workspace
```

#### 配置

`mcp-serve` 会像其他每个命令一样读取 `.seekforge/config.json`，并把它应用到
MCP 客户端发起的工具调用上：

| 配置键 | 对 `mcp-serve` 的作用 |
|---|---|
| `permissionRules` | 生效。deny 规则在任何权限级别上都会拦截（包括只读调用），且从不提示。完整模式下 allow 规则会预先授权某个工具，`env` 类工具也不例外。 |
| `hooks` | 生效。`preToolUse` 在每次工具调用前运行，非零退出即拦截该调用；`updatedInput` 改写会照常重新校验并重新做权限检查。在完整模式下，hook 的 `allow` 会代为回答本传输原本会拒绝的提示，与 allow 规则一致。这里无法评估 `prompt` hook（没有模型），因此它们会失败——在 `preToolUse` 上即拦截。见 [Hook](hooks.zh-CN.md)。 |
| `sandbox` | 在完整模式下对 `run_command` / `run_tests` 生效。沙箱机制不可用时命令直接失败，而不会退化为无沙箱执行。 |
| `commandAllowlist` | 生效，但在这里不产生任何差别：完整模式本就自动放行 `execute`，只读模式则一律禁止。 |
| `visionModel`、`webSearch`、`browserProfile` | 会被配置，但默认没有任何调用能触达它们：`image_analyze`、`web_search`、`web_fetch` 与 `browser_navigate` 都分类为 `env`，一律被拒绝。只有当你的 `permissionRules` 明确允许了对应工具时它们才会生效。 |
| `mcpServers`、`runtimeBin`、模型/provider 相关键 | **不**生效。该进程不运行 agent：它既不调用模型，也不连接其他 MCP 服务器，因此无处可用。 |

只有仓库无法写入的层会到达这条传输：项目层与本地层贡献 deny 规则（以及此处用不到的
不受信任 `mcpServers` 定义），而 `hooks`、`sandbox`、`commandAllowlist` 只来自你的
用户级配置。插件 hooks 被有意排除——这里的默认形态是只读工具集，而仓库提供的 hook
命令会把它重新变成任意命令执行。

### 2.2 协议

服务器使用协议版本 `2025-06-18`。服务器信息：

```json
{ "name": "seekforge", "version": "1.0.0" }
```

**支持的方法：**

| 方法                        | 是否支持 | 说明                       |
|---|---|---|
| `initialize`                | ✅        | 返回 tool、resource 和 prompt 能力 |
| `notifications/initialized` | ✅        | 通知；无响应  |
| `ping`                      | ✅        | 返回 `{}`               |
| `tools/list`                | ✅        | 列出暴露的工具        |
| `tools/call`                | ✅        | 执行一个工具；错误通过结果中的 `isError: true` 返回，而非 JSON-RPC 错误 |
| `resources/list`            | ✅        | 工作区概览与 Git 状态资源 |
| `resources/read`            | ✅        | 读取一个已公布的工作区资源 |
| `prompts/list`              | ✅        | 列出 review 和 security-review prompts |
| `prompts/get`               | ✅        | 渲染一个内置 prompt |

工具调用结果始终包含：

```json
{
  "content": [{ "type": "text", "text": "<JSON>" }],
  "isError": false
}
```

成功时 `isError` 为 `false`，`text` 为 `JSON.stringify(result.data)`；
失败时 `isError` 为 `true`，`text` 为 `"<code>: <message>"`。

### 2.3 工具集

#### 只读模式（默认）

只读模式下暴露 **8 个工具**，全部分类为 `L0 readonly`：

| 工具            | 权限分类 |
|---|---|
| `read_file`     | readonly         |
| `list_files`    | readonly         |
| `search_text`   | readonly         |
| `git_status`    | readonly         |
| `git_diff`      | readonly         |
| `git_log`       | readonly         |
| `git_blame`     | readonly         |
| `git_show`      | readonly         |

`ToolContext` 运行在 `mode: "ask"`（直接禁止一切高于 L0 的操作）与
`approvalMode: "confirm"` 之下，其 `confirm` 回调**始终拒绝** ——
三个相互独立的层共同阻止写入。

尝试调用任何其他工具（例如 `write_file`）会返回 JSON-RPC 错误：

```json
{ "code": -32602, "message": "Tool not available in read-only mode: write_file" }
```

#### 完整模式（`--allow-write`）

传入 `--allow-write` 后，除 `ask_user` 外的所有内置工具都会被暴露。
排除 `ask_user` 是因为 MCP 没有可交互的人类通道。

`ToolContext` 运行在 `mode: "edit"` 与 `approvalMode: "auto"` 之下：

- `L1 (write)` —— 自动允许
- `L2 (execute)` —— 自动允许
- `L3 (env)` —— 始终拒绝（网络抓取、依赖安装等操作始终需要真人确认），
  除非你自己的 `permissionRules` 明确允许了那个工具
- `L4 (dangerous)` —— 两种模式下都既不执行、也无从询问

`confirm` 回调在两种模式下都**始终拒绝**。自动放行由 `approvalMode` 承担，作用范围
限定在上述级别；`confirm` 因此只会被那些真正需要人来回答的问题触达，而这里没有人。
其中最关键的一个，是命令在 OS 沙箱内失败时得到的那次重试提议：一个会自动放行的
`confirm` 会对任何「失败输出看起来像被沙箱拒绝」的命令回答「好，去掉沙箱再跑一次」，
那样配置的 `sandbox` 就只剩装饰意义。在这里该提议会被拒绝，沙箱下的失败结果原样保留。

> **安全提示：** 完整模式相当于把工作区里的一个 shell 交给 MCP 客户端。
> 只连接你信任其执行任意命令的调用方。

---

## 3. 错误处理

### 客户端错误

| 错误码             | 含义                                          |
|---|---|
| `mcp_config`       | 配置缺失或无效              |
| `mcp_crashed`      | 服务器进程意外退出            |
| `mcp_timeout`      | 超过空闲超时（30s）未响应，或超过 10 分钟总时长 |
| `mcp_cancelled`    | 请求完成前调用方的 AbortSignal 已触发 |
| `mcp_error`        | 服务器返回了 JSON-RPC 错误              |
| `mcp_tool_error`   | 工具调用返回了 `isError: true`            |
| `mcp_http_error`   | HTTP/SSE 传输：不可达、非 2xx、SSE 流已关闭或公布了其他 origin 的 endpoint |
| `mcp_parse_error`  | 响应体无法解析                      |
| `mcp_auth_error`   | OAuth：元数据/端点无效、不支持 PKCE S256、issuer 或 state 不匹配、令牌响应缺少 access token |
| `mcp_pagination_limit` | 分页列表超过 100 页或 10,000 条 |
| `mcp_pagination_loop`  | 分页列表返回了此前已出现过的 cursor |
| `mcp_sampling_denied`      | 用户拒绝了服务器的 `sampling/createMessage` 请求 |
| `mcp_sampling_unavailable` | 服务器请求采样，但本会话没有配置模型 |
| `mcp_write_failed` | 无法写入 stdin（stdio）              |
| `disposed`         | 请求完成前客户端已被销毁      |
| `unknown_server`   | 服务器名不在已连接集合中          |

### 服务器错误

| 错误码 | 含义                              |
|---|---|
| -32600 | 请求无效（重复发送 `initialize`） |
| -32601 | 方法未找到 —— 不在 §2.2 表格内的方法 |
| -32602 | 参数无效（工具名错误、工具未暴露、资源或 prompt 未知） |
| -32603 | 内部错误 —— handler 抛出异常，而非以 `isError` 报告的普通工具失败 |
| -32700 | 解析错误 —— 单帧超过 1 MiB 消息上限 |
| -32002 | 请求在 `initialize` / `notifications/initialized` 完成之前到达 |

---

## 4. 架构

实现跨越两个包：

| 模块              | 文件                                      | 职责 |
|---|---|---|
| `McpServerConfig`   | `packages/core/src/mcp/types.ts`          | 每个 MCP 服务器条目的配置 schema |
| `McpClient`         | `packages/core/src/mcp/client.ts`         | 客户端传输：stdio、HTTP 或 SSE |
| `McpHttpTransport`  | `packages/core/src/mcp/http.ts`           | Streamable HTTP：POST + SSE |
| `McpSseTransport`   | `packages/core/src/mcp/sse.ts`            | 旧版 HTTP+SSE（2024-11-05） |
| 启动策略            | `packages/core/src/mcp/launch.ts`         | `${VAR}` 展开、stdio 环境 |
| 批准记录            | `packages/core/src/mcp/approvals.ts`      | 按工作区的项目服务器决定 |
| `McpRegistry`       | `packages/core/src/mcp/registry.ts`       | 在线连接、列表刷新、延迟加载分发器 |
| 面向模型的工具      | `packages/core/src/mcp/meta-tools.ts`     | `list_mcp_resources`、`read_mcp_resource`、`tool_search` |
| `McpToolSpecs`      | `packages/core/src/mcp/tools.ts`          | 转换 tools/resources/prompts |
| `McpServer`         | `packages/core/src/mcp/server.ts`         | 服务器模式：stdio 上的 JSON-RPC |
| CLI 客户端命令 | `apps/cli/src/commands/mcp.ts`            | `mcp list/get/add/add-json/import/approve/reject/remove` |
| CLI 配置辅助  | `apps/cli/src/mcp-config.ts`              | 读写配置中的 `mcpServers` |
| CLI 服务器命令  | `apps/cli/src/commands/mcp-serve.ts`      | `mcp-serve` 入口 |
| Agent factory       | `apps/cli/src/agent-factory.ts`           | `prepareMcp()` 启动各服务器 |

### 客户端连接生命周期

1. `loadMcpToolSpecs(servers, workspaceRoots?, signal?, handlers?, options?)` 逐条决定
   能否连接（`mcpConnectionDecision`：受信任的用户条目，或已为 `options.workspace` /
   `workspaceRoots[0]` 批准的项目条目；`options.origins` 为配置合并报告中的
   `mcpServerOrigins`）。
2. 对每个要连接的服务器：`createMcpClient({ name, config, trust })` 按信任级别展开引用，
   并选择传输方式（`type`；否则存在 `config.url` 为 HTTP，否则为 stdio）。
3. 第一个请求触发 `initialize` 握手（stdio 的握手超时为 120s，
   以容纳 npx 安装耗时）。
4. 握手完成后发送 `notifications/initialized`。
5. 调用 `tools/list` 并转换为 `ToolSpec` 对象；服务器每次发送
   `notifications/tools/list_changed` 时都会再次调用。
6. `loadMcpToolSpecs` 返回 `{ specs, entries, dispose, registry }`。
7. 要么把 `specs`（快照，含资源工具）传给 `createDefaultDispatcher(specs)`；要么为了列表
   刷新与工具搜索，用 `createMcpAwareDispatcher(registry)` 取代该分发器——registry 的
   revision 一变，agent 循环就会重新读取其工具目录。
8. 会话结束时，`dispose()` 杀掉所有子进程并取消在途的 HTTP 请求。

### 超时

| 阶段                             | 超时 |
|---|---|
| 握手（stdio，涵盖 npx 安装）     | 120s    |
| 常规请求（所有传输方式） | 30s 空闲 |
| 单个请求总时长（含进度） | 10 分钟 |

这 30s 是**空闲**超时，不是截止时间。每个请求都会带上 `_meta.progressToken`，只要收到
指明该 token 的 `notifications/progress`，计时就会重新开始：一个每隔几秒说一声「还在干」
的构建、迁移或部署是活着的，因为它慢就掐掉它是错误的答案。不理会这个 token 的服务端，
行为与以前完全一致。

能延长截止时间的心跳必须有自己的上限，否则服务端想把调用挂多久就挂多久 —— 所以还有一个
总时长，任何数量的进度通知都无法把它推过去。

两者都是 `createMcpClient` 的选项（`requestTimeoutMs`、`maxRequestTotalMs`）——那是给
**嵌入方**的接缝，而不是配置项。它们不是 `McpServerConfig` 的字段，`loadMcpToolSpecs`
也不会转发它们，因此 `.seekforge/config.json` 里的服务器条目无法改变自身的超时，
所有已配置的服务器都使用上表中的默认值。
