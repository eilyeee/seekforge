# MCP（Model Context Protocol）指南

> [English](mcp.md) | **简体中文**

SeekForge 同时实现了 Model Context Protocol（MCP）的两端：

- **客户端模式（Client mode）** —— 连接外部 MCP 服务器（stdio 或 Streamable HTTP），
  并将其 tools、resources 和 prompts 提供给 agent 使用。
- **服务器模式（Server mode）** —— 将 SeekForge 自身作为 MCP 服务器运行在 stdio 上，
  让其他 agent 可以使用本工作区的内置工具。

---

## 1. 客户端模式 —— 使用 MCP 服务器

agent 通过三个通道与已配置的 MCP 服务器交互：**tools**（主要通道）、
**resources**（通过 URI 寻址的可读文档）和 **prompts**（服务器定义的模板）。

### 1.1 配置

MCP 服务器在 `.seekforge/config.json`（项目级）或 `~/.seekforge/config.json`
（全局级）的 `mcpServers` 下声明。

项目条目只负责定义：仓库配置不能授予自身自动启动权限，因此项目里的
`trusted: true` 会被忽略。要信任已审查的服务器，请把完整条目复制到全局配置，
并在那里设置 `trusted: true`。显式管理操作仍可连接用户选中的未信任项目条目，
用于测试或检查工具。

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
    }
  }
}
```

**传输方式选择**（按服务器逐项判定，互斥）：

| 是否有 `url`？ | 传输方式        | 生效字段                 |
|---|---|---|
| 否         | stdio           | `command`、`args`、`env` |
| 是         | Streamable HTTP | `url`、`headers`、`oauth` |

每个服务器必须有 `command`（stdio）或 `url`（HTTP）之一；两者皆无会导致配置错误。

### 1.2 CLI 命令

#### `seekforge mcp list [--tools]`

启动每一个已配置的服务器，执行 initialize 握手，并打印各服务器的工具名。
某个服务器失败时会内联显示错误，列表继续输出。加上 `--tools` 后，
还会显示每个工具描述的第一行。

```text
$ seekforge mcp list --tools
filesystem  (npx -y ..., untrusted)  2 tool(s)
  read_file  Read the complete contents of a file from the file system
  write_file  Write text content to a file at a specified path
```

#### `seekforge mcp add <name> <command> [args...]`

向项目配置的 `mcpServers` 追加一个 **stdio** 服务器（加 `--global` 则写入
`~/.seekforge/`）。`<name>` 之后的第一个 token 是命令，其余成为 `args`。

新增的项目服务器**不受信任（untrusted）** —— CLI 会提示先审查该条目，
再复制到全局配置并设置 `"trusted": true`，以允许 Agent 自动连接。

```text
seekforge mcp add fs npx -y @modelcontextprotocol/server-filesystem .
```

#### `seekforge mcp remove <name>`

从 `mcpServers` 中删除一个服务器。同样接受 `--global` 操作全局配置。

#### `seekforge mcp login <name>`

对「配置了 `url` 但没有 `oauth` 段」的远程服务器执行交互式 OAuth 2.1
授权码流程（PKCE，`S256`）：

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
settings file  >  project .seekforge/config.json  >  global ~/.seekforge/config.json
```

每个服务器的配置按键做浅合并（shallow-merge）：后面的层覆盖前面的层。
遮蔽全局条目的仓库定义仍不受信任；信任不会跨该边界继承。完整的分层模型见
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
| `sampling` | `sampling/createMessage` | 前端有确认通道且配置了模型 | 服务器的 prompt 会原样（截断后）展示给你，你批准后用你自己的模型执行。 |
| `elicitation` | `elicitation/create` | 前端有向用户提问的通道 | 服务器的问题会抛给你，你的回答被返回。 |

**采样花的是你的 token，跑的是你没写过的 prompt**，因此**每一次**都要确认——这里没有
审批模式的旁路，只有你的前端 confirm 本身的行为（所以无头 `-y` 运行会批准它，
就像 `-y` 批准其他一切一样）。确认提示会写明是哪个服务器、用哪个模型、发送什么文本。
这次调用花了多少，会以 `[mcp:<server>] sampling used <n> tokens ($x.xxxx)` 写到 stderr；
它**不会**被计入会话自身的成本合计，因为那不是这次会话的工作。

采样用的 provider 与 agent 用的来自同一份配置，但是独立实例：服务器发起的模型调用不会
混进 agent 的重试总线与响应缓存。请求在抵达模型之前先被限界：最多 50 条消息、
200,000 字符，且只接受文本部分。

**征询**通过 `ask_user` 工具用的那个选项选择器来回答，这也界定了它能收集什么：布尔与
枚举字段可以回答；需要自由文本的字段会被**拒绝**并说明原因，而不是猜一个值填进去——
服务器会拿到什么就照做什么。请求的 schema 必须如规范要求那样是一层扁平的原始类型对象，
任何嵌套都会被拒绝。

目前接上的是：CLI（`seekforge run`、REPL）与本地 server（桌面端与 Web 工作台，
经 WebSocket 的确认/提问通道）。TUI 目前两者都不声明。

`tools/list`、`resources/list` 和 `prompts/list` 会逐页消费每个不透明的
`nextCursor`。重复出现的 cursor 会被拒绝，发现过程上限为 100 页和 10,000 条，
因此格式错误或恶意的服务器无法制造无限循环或无上限的目录内存分配。

### 1.7 信任模型

每个用户级服务器条目有一个可选的 `trusted` 布尔值（默认 `false`）。Agent 自动
发现只连接全局配置或显式 settings 中设置为 `trusted: true` 的条目；仓库信任标志
会被剥离，因为连接本身就可能启动本地进程或访问远程端点。已信任工具依次使用按原始
工具名设置的覆盖、服务器默认值、MCP 注解（`destructive`/`openWorld` 升到 `env`，
`readOnly` 映射为 `readonly`），最后回退到 `write`。显式检查未信任条目时始终使用
`env`，不能通过注解降低权限。

| `trusted` | 自动连接 | 工具权限 | 使用 `-y` 时 | 未使用 `-y` 时 |
|---|---|---|---|---|
| `false` | 禁用 | 不适用 | 不适用 | 不适用 |
| `true` | 启用 | 覆盖/默认/注解，否则 `"write"` | 取决于策略 | 取决于策略 |

`seekforge mcp list`、Desktop 的服务器测试/工具查看等显式管理操作仍可连接用户
主动选择的未信任条目，因为用户已经发起了这一次准确的连接。只有审查过命令或
URL 及其配置后，才应把服务器标记为已信任。

工具结果把文本保留在 `content` 中，同时保留有界且脱敏的 `structuredContent`；
图片、音频和资源只以附件描述信息暴露，不会把 base64 载荷塞进模型上下文。

### 1.8 Resources

已配置 MCP 服务器的资源可以列出和读取。每个资源都会标注其所属服务器名。
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

只读模式下暴露 **5 个工具**，全部分类为 `L0 readonly`：

| 工具            | 权限分类 |
|---|---|
| `read_file`     | readonly         |
| `list_files`    | readonly         |
| `search_text`   | readonly         |
| `git_status`    | readonly         |
| `git_diff`      | readonly         |

`ToolContext` 运行在 `"ask"` 审批模式下，且 `confirm` 回调**始终拒绝** ——
三个相互独立的层共同阻止写入。

尝试调用任何其他工具（例如 `write_file`）会返回 JSON-RPC 错误：

```json
{ "code": -32602, "message": "Tool not available in read-only mode: write_file" }
```

#### 完整模式（`--allow-write`）

传入 `--allow-write` 后，除 `ask_user` 外的所有内置工具都会被暴露。
排除 `ask_user` 是因为 MCP 没有可交互的人类通道。

`confirm` 回调按权限级别**自动放行**：

- `L1 (write)` —— 自动允许
- `L2 (execute)` —— 自动允许
- `L3 (env)` —— 始终拒绝（网络抓取、依赖安装等操作始终需要真人确认）

> **安全提示：** 完整模式相当于把工作区里的一个 shell 交给 MCP 客户端。
> 只连接你信任其执行任意命令的调用方。

---

## 3. 错误处理

### 客户端错误

| 错误码             | 含义                                          |
|---|---|
| `mcp_config`       | 配置缺失或无效              |
| `mcp_crashed`      | 服务器进程意外退出            |
| `mcp_timeout`      | 超时未响应（请求 30s，握手 120s） |
| `mcp_error`        | 服务器返回了 JSON-RPC 错误              |
| `mcp_tool_error`   | 工具调用返回了 `isError: true`            |
| `mcp_http_error`   | HTTP 传输：不可达或非 200        |
| `mcp_parse_error`  | 响应体无法解析                      |
| `mcp_write_failed` | 无法写入 stdin（stdio）              |
| `disposed`         | 请求完成前客户端已被销毁      |
| `unknown_server`   | 服务器名不在已连接集合中          |

### 服务器错误

| 错误码 | 含义                              |
|---|---|
| -32601 | 方法未找到（例如 prompts/list） |
| -32602 | 参数无效（工具名错误、工具未暴露） |

---

## 4. 架构

实现跨越两个包：

| 模块              | 文件                                      | 职责 |
|---|---|---|
| `McpServerConfig`   | `packages/core/src/mcp/types.ts`          | 每个 MCP 服务器条目的配置 schema |
| `McpClient`         | `packages/core/src/mcp/client.ts`         | 客户端传输：stdio 或 HTTP |
| `McpHttpTransport`  | `packages/core/src/mcp/http.ts`           | Streamable HTTP：POST + SSE |
| `McpToolSpecs`      | `packages/core/src/mcp/tools.ts`          | 转换 tools/resources/prompts |
| `McpServer`         | `packages/core/src/mcp/server.ts`         | 服务器模式：stdio 上的 JSON-RPC |
| CLI 客户端命令 | `apps/cli/src/commands/mcp.ts`            | `mcp list`、`mcp add`、`rm` |
| CLI 配置辅助  | `apps/cli/src/mcp-config.ts`              | 读写配置中的 `mcpServers` |
| CLI 服务器命令  | `apps/cli/src/commands/mcp-serve.ts`      | `mcp-serve` 入口 |
| Agent factory       | `apps/cli/src/agent-factory.ts`           | `prepareMcp()` 启动各服务器 |

### 客户端连接生命周期

1. `loadMcpToolSpecs(servers, workspaceRoots?)` 为每个条目创建一个客户端。
2. 对每个服务器：`createMcpClient({ name, config })` 选择传输方式
   （存在 `config.url` 则为 HTTP，否则为 stdio）。
3. 第一个请求触发 `initialize` 握手（stdio 的握手超时为 120s，
   以容纳 npx 安装耗时）。
4. 握手完成后发送 `notifications/initialized`。
5. `tools/list`、`resources/list`、`prompts/list` 各调用一次，
   结果缓存为 `ToolSpec` 对象。
6. `loadMcpToolSpecs` 返回 `{ specs, entries, dispose }`。
7. `specs` 与内置工具一起传给 `createDefaultDispatcher(mcpToolSpecs)`。
8. 会话结束时，`dispose()` 杀掉所有子进程并取消在途的 HTTP 请求。

### 超时

| 阶段                             | 超时 |
|---|---|
| 握手（stdio，涵盖 npx 安装）     | 120s    |
| 常规请求（所有传输方式） | 30s     |
