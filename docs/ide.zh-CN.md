# VS Code 扩展与 IDE 桥

> [English](ide.md) | **简体中文**

VS Code 扩展（`apps/vscode`）是本地 `seekforge serve` 的客户端。它在代码旁提供聊天，
在 VS Code 原生 diff 编辑器中审阅每一个权限请求，并运行一个小型的回环 **IDE 桥**，
供终端 UI 读取你当前打开的内容。编排、权限、trace 与工作区协调都留在服务器里；
扩展本身从不运行智能体。

## 安装与连接

安装每个 GitHub release 附带的 `seekforge-vscode-<version>.vsix`
（`code --install-extension <file>`），或用 `pnpm --filter seekforge-vscode package`
自行构建。扩展没有运行时依赖。

扩展默认连接 `http://127.0.0.1:7373`，也就是 `seekforge serve` 的监听地址。
有两种连接方式：

- **让 VS Code 启动服务器。** 运行 **SeekForge: Start Server for This Workspace**。
  它会在名为 **SeekForge Server** 的终端里运行
  `seekforge serve <工作区文件夹> --port <端口>`，从服务器打印的那一行读取 token，
  保存到 VS Code SecretStorage，并在终端中遮蔽它。关闭该终端（或在其中按 Ctrl+C，
  或运行 **Stop the Server Started by VS Code**）会停止服务器。可执行文件取自
  `seekforge.serveCommand`（默认 `seekforge`，因此请先用 `npm install -g seekforge`
  安装 CLI）。VS Code 只会为受信任的工作区启动服务器。
- **使用你自己启动的服务器。** 运行 `seekforge serve /path/to/project`，然后执行
  **SeekForge: Set Server Token**，粘贴打印出的 URL 中的 token。如果服务器监听在
  其他地址，请设置 `seekforge.serverUrl`。

当请求发现没有服务器在监听时，扩展会提议启动服务器、设置 token 或打开该设置项。
当服务器拒绝已保存的 token 时，它会提议设置新的 token。

默认情况下 `seekforge serve` 只打印一次 token，不会写入文件；这就是扩展要么自己启动
服务器、要么请你粘贴 token 的原因。`seekforge serve --token-file <path>` 会在服务器运行期间
另把端口和 token 写入该文件（权限 0600），并在停止时删除——这让并非由它启动服务的客户端也能
找到服务器。扩展目前还不会读取这个文件；请用 **Set Server Token** 粘贴其中的 token。

## 聊天

打开活动栏中的 **SeekForge** 视图，或按 **Cmd+Esc**（macOS）/ **Ctrl+Esc**
（Windows、Linux）。**⧉** 按钮（或 **SeekForge: Open Chat in Editor Tab**）会在编辑器
标签页中打开另一个会话；每个标签页和侧边栏各自持有独立的会话。

- **会话可延续。** 第一条消息开启一个 session，之后的每条消息都延续它，直到用
  **+**（New Chat）开启新会话。**⟲**（Resume Session）列出工作区中已保存的 session，
  并连同历史与成本重新载入其中一个。同一个 session 不能同时在两个聊天中继续。
- **流式输出。** 助手文本以渲染后的 markdown 流式显示。推理内容流入可折叠的
  *Thinking* 块，答案开始后自动收起。工具调用以行的形式显示工具名及其主要参数；
  展开可查看完整参数和实时命令输出。变更的文件、子智能体进度、计划清单
  （`update_plan`）和最终报告都内联显示；点击文件名即可打开文件。
- **底栏。** 显示本 session 的成本、prompt token（含上下文缓存命中）与 completion
  token，以及上下文窗口占用。聊天隐藏后，状态栏仍显示同样的花费。
- **停止。** Stop 按钮（或 **SeekForge: Stop the Running Task**）会在服务器上取消本次运行。
- **模式** —— *Ask* 只读作答，*Edit* 修改代码，*Plan* 先生成一份只读计划。计划完成后，
  **Execute plan** 会以编辑模式继续同一个 session。
- **审批模式** —— *Confirm each* 在每次写入或命令前询问，*Accept edits* 自动应用文件编辑、
  命令仍需询问，*Auto* 自动批准写入和命令（危险调用仍会被拒绝，环境变更仍会询问）。
- **提及。** 输入 `@` 搜索工作区文件并插入 `@path`。
- **选区。** **+ Selection**（或在编辑器中按 **Cmd+Alt+K** / **Ctrl+Alt+K**，或使用编辑器
  右键菜单中的 **Add Selection to Chat**）会插入类似 `@src/app.ts#L10-24` 的引用，
  只要引用仍留在消息中，这段代码就会随消息一起发送。
- **编辑器上下文。** 勾选 **Context** 时，每条消息还会附带当前活动文件、其选区、
  打开的编辑器标签页（最多 50 个，仅限工作区文件）以及活动文件的错误诊断（最多 30 条）。
  每一部分都有对应设置，见下文。附带的内容会列在你的消息下方。
- **提问。** 当智能体提问（`ask_user`）时，可以选择一个选项；若问题允许，也可以输入自己的
  答案，或拒绝回答。

超过服务器 1 MB 帧上限的消息会在发送前被拒绝；被拒绝或发送失败的消息会回到输入框中。

## 审阅权限请求

权限请求以卡片形式显示在输入框上方。聊天被隐藏时，会弹出通知提议显示它。

- 卡片始终显示该审批所授予的**原始命令**和**原始路径**，绝不只给出摘要。
- **Open diff** 在 VS Code 的 diff 编辑器中显示拟议的编辑。两侧都是根据预览重建的只读
  文档；多文件编辑以变更视图打开；预览若触及大小上限，两侧都会注明。
- 包含多处编辑的 `apply_patch` 会以复选框列出各处编辑；**Allow selected edits** 只应用
  勾选的部分。
- 只有当 core 表示会兑现时，才会出现 **Allow for session** 和 **Always allow**。环境级
  工具永远不会提供会话授权；**Always allow** 会显示它将写入你用户配置的确切规则。
- **Deny with reason** 会把你的说明随拒绝一起发送，让智能体改为尝试你要求的做法。
  说明最多 2,000 个字符。早于此功能的服务器会忽略说明，但仍会拒绝。
- 当请求是智能体申请退出计划模式时，卡片会以 markdown 渲染该计划。
- 服务器会在 120 秒无应答后拒绝请求；卡片会倒计时，随后自行关闭。

聊天中显示的一切都以文本渲染：markdown 被解析为树，再用 DOM 节点构建，因此模型或工具的
输出永远无法注入 HTML。聊天页面运行在严格的内容安全策略下（脚本必须携带页面的 nonce，
不从网络加载任何内容），页面与扩展之间的每条消息都会在两端校验。

## 命令、快捷键与设置

| 命令 | 默认快捷键 |
| --- | --- |
| SeekForge: Focus Chat | Cmd+Esc / Ctrl+Esc |
| SeekForge: Add Selection to Chat | Cmd+Alt+K / Ctrl+Alt+K（编辑器获得焦点时） |
| SeekForge: New Chat · Resume Session · Open Chat in Editor Tab · Stop the Running Task | — |
| SeekForge: Start Server for This Workspace · Stop the Server Started by VS Code · Set Server Token | — |
| SeekForge: Show Workspace Diff · Review Memory Candidates · Open Session Transcript · Open Loop · Show Activity Output | — |

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `seekforge.serverUrl` | `http://127.0.0.1:7373` | 服务器地址。仅限用户设置。 |
| `seekforge.serveCommand` | `seekforge` | **Start Server** 运行的可执行文件。仅限用户设置。 |
| `seekforge.context.includeSelection` | `true` | 附带当前选区。 |
| `seekforge.context.includeOpenFiles` | `true` | 列出打开的工作区文件。 |
| `seekforge.context.includeDiagnostics` | `true` | 附带活动文件的错误。 |
| `seekforge.ideBridge.enabled` | `true` | 运行 IDE 桥。仅限用户设置。 |

`seekforge.serverUrl` 与 `seekforge.serveCommand` 是机器级设置：仓库中的
`.vscode/settings.json` 无法修改它们，因为已保存的 token 会被发送到前者，而后者会被执行。

## IDE 桥

扩展处于活动状态时，会在 `127.0.0.1` 的随机端口上运行一个 HTTP 服务器，使同一台机器上的
SeekForge 进程能够读取编辑器状态。终端 UI 的 `/ide` 命令通过它为你输入的每条提示获取选区、
打开的文件与诊断信息，并把待批准的编辑以 diff 形式显示在编辑器中（在权限提示上按 `o`）；
`/ide off` 断开连接。可通过 `seekforge.ideBridge.enabled` 关闭该桥。

### 发现

每个 VS Code 窗口都会写入 `~/.seekforge/ide/<port>.json`。目录以 `0700` 权限创建，
文件以 `0600` 权限创建：

```json
{
  "version": 1,
  "port": 53124,
  "token": "<64 个十六进制字符>",
  "pid": 81234,
  "ideName": "Visual Studio Code",
  "workspaceFolders": ["/Users/me/project"]
}
```

`ideName` 是编辑器自身的名称（例如 *Cursor* 或 *Visual Studio Code - Insiders*）。
窗口的文件夹变化时该文件会被重写，窗口关闭时会被删除。扩展启动时会删除所属进程已不存在的
锁文件；无法读取的文件要等一分钟后才会删除，以防其所有者仍在写入。由于进程 id 会被复用，
客户端仍应预期列出的桥可能拒绝连接，并转而尝试下一个。客户端应选择 `workspaceFolders`
包含其工作目录的那个窗口。

终端 UI 从其 SeekForge 主目录下的 `.seekforge/ide/` 读取锁文件：即你的主目录，设置了
`SEEKFORGE_HOME` 时则为 `$SEEKFORGE_HOME`。扩展总是写在你的主目录下，因此以不同
`SEEKFORGE_HOME` 启动的终端 UI 找不到任何桥。只有当锁文件是你拥有、他人不可读的普通文件，
且所在目录他人不可写时，终端 UI 才会采信它；所属进程已不存在的锁文件会被静默跳过，
其余被拒绝的文件 `/ide` 都会逐一列出并说明原因。包含当前项目的窗口排在最前面。

### 请求

每个请求都需要 `Authorization: Bearer <token>`。响应均为 JSON。

`GET /v1/context` 返回：

```json
{
  "activeFile": "/Users/me/project/src/app.ts",
  "selection": { "path": "/Users/me/project/src/app.ts", "startLine": 10, "endLine": 24, "text": "…" },
  "openFiles": ["/Users/me/project/src/app.ts"],
  "diagnostics": [
    { "path": "/Users/me/project/src/app.ts", "line": 12, "column": 5, "severity": "error", "message": "…", "source": "ts" }
  ]
}
```

路径均为绝对路径，行号与列号从 1 开始。没有活动文件或选区时，`activeFile` 与 `selection`
会被省略；只报告磁盘上的文件。选区文本上限为 20,000 个字符，`openFiles` 最多 50 项，
`diagnostics` 最多 200 条且错误优先（severity 为 `error`、`warning`、`info` 或 `hint`）。

`POST /v1/openDiff`，请求体为 `{ "path", "original", "proposed", "title"? }`，会在
VS Code 的 diff 编辑器中打开两个只读文档，并返回 `{ "ok": true }`。
`POST /v1/openFile`，请求体为 `{ "path", "line"? }`，会打开该文件（并定位到该行），
返回 `{ "ok": true }`；终端 UI 不调用它，它供其他客户端使用。`path` 必须是绝对路径；
`line` 必须是正整数；`title` 最多 200 个字符。

错误格式为 `{ "error": "<code>", "message": "…" }`：`400 bad_request`（请求体格式错误、
相对路径）、`401 unauthorized`、`403 forbidden`、`404 not_found`（未知路由，或文件不存在）、
`405 method_not_allowed`、`413 too_large`（请求体上限 16 MB）、`500 internal`。

### 安全模型

- 服务器只监听 `127.0.0.1`，端口由操作系统分配。
- token 为 32 个随机字节，只保存在仅所有者可读的锁文件中，并以恒定时间比较。
- 带有 `Origin` 请求头的请求一律拒绝，因此网页即使通过 CORS 预检也无法使用该桥。
  `Host` 请求头必须是带有该桥端口的回环主机名，以此抵御 DNS 重绑定。
- 不返回任何 CORS 响应头，响应标记为 `no-store`。
- 请求体在到达过程中即计数，超过上限立即拒绝；该桥只响应上面三个路由。
- 该桥只负责向你展示内容，从不修改文件。任何以你的身份运行的 SeekForge 进程都能读取
  token，正如它能读取你的文件一样。

## 故障排查

- **"No SeekForge server is answering"** —— 启动一个服务器（通知可以代劳），或检查
  `seekforge.serverUrl`。
- **"rejected the saved token"** —— 服务器已重启并打印了新 token；设置新 token，
  或从 VS Code 重启服务器。
- **"does not host the VS Code workspace"** —— 服务器是为其他文件夹启动的；请以当前文件夹
  作为参数启动它。
- **终端 UI 的 `/ide` 列表里什么也没有** —— 确认 `seekforge.ideBridge.enabled` 已开启，
  `~/.seekforge/ide/` 中有对应此窗口的文件，并且 `SEEKFORGE_HOME` 未设置或指向你的主目录。
  **SeekForge: Show Activity Output** 会记录桥的端口和锁文件位置。
