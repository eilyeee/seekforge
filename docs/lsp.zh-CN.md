# LSP / 精确符号智能

> [English](lsp.md) | **简体中文**

SeekForge 可以对接真实的**语言服务器（Language Server，LSP）**，让智能体获得**精确的**符号信息——跳转到定义、查找全部引用与诊断——直接来自编译器/类型检查器，而非词法层面的猜测。它由你在编辑器中已经在用的那个语言服务器提供支持，这是一个**可选的、需你自行安装的 opt-in 二进制**（刻意不作为声明依赖，因此常规安装绝不会拉取任何语言服务器）。

## 为什么 LSP 优于词法检索

内置的 `repo_map`、`find_definition` 与 `search_text` 工具快速且零依赖，但它们是**启发式**的：只基于标识符的正则 / tree-sitter 大纲。它们无法追踪 import、re-export 或重载，也无法区分定义与同名的无关符号。

语言服务器以编译器的方式解析符号：

| 问题 | 词法工具 | LSP 工具 |
| --- | --- | --- |
| 「`X` 在哪里定义？」 | `find_definition` — `X` 的每一个正则匹配 | `lsp_definition` — 唯一真正的定义，可跨 import/re-export |
| 「谁在用 `X`？」 | `search_text` — `X` 的每一处文本出现 | `lsp_references` — 编译器解析出的每一个真实读/写/调用点 |
| 「我的改动弄坏了什么吗？」 | grep 错误字符串 | `lsp_diagnostics` — 编译器/类型检查器自己的错误与警告 |
| 「`X` 在哪儿？」 | `search_text` — 每一处出现，不分是否声明 | `lsp_symbols` — 只返回声明，并带上它的种类 |
| 「把 `X` 改名成 `Y`」 | search/replace，一次一个文件，同名符号会被误伤 | `lsp_rename` — 声明加上每一处真实引用，跨文件 |

当你需要**精确性**时（重命名前、评估影响范围、确认修复能通过类型检查），用 LSP 工具；当你要快速定位方向、或没有安装语言服务器时，用词法工具。

## 安装语言服务器

在服务器二进制出现在你的 `PATH` 上之前，`lsp_*` 工具处于休眠状态。为你的语言安装对应的服务器：

| 语言 | 文件 | 安装 | 检测的二进制 |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `.ts .tsx .mts .cts .js .jsx .mjs .cjs` | `npm i -g typescript-language-server typescript` | `typescript-language-server` |
| Python | `.py` | `pip install pyright` **或** `pip install python-lsp-server` | `pyright-langserver`，否则 `pylsp` |
| Go | `.go` | `go install golang.org/x/tools/gopls@latest` | `gopls` |

在找到服务器之前，每个 LSP 工具都会返回一条可操作的错误信息，指出应安装哪些服务器，例如：

```
Install the TypeScript/JavaScript language server: `npm i -g typescript-language-server typescript`.
```

服务器由**工具内部惰性启动**，绝不在 import 时启动，因此无论是否安装了服务器，typecheck、构建与整个测试套件都能通过。没有配置服务器的文件类型会返回 `lsp_unsupported`。

## 工具

| 工具 | 参数 | 权限 | 作用 |
| --- | --- | --- | --- |
| `lsp_definition` | `path`, `line`, `character?` | `readonly` | 对该位置的符号执行跳转到定义；返回定义所在的 `file:line(s)`。 |
| `lsp_references` | `path`, `line`, `character?` | `readonly` | 查找该符号的全部引用；返回每个 `file:line` 及数量。 |
| `lsp_diagnostics` | `path` | `readonly` | 在服务器中打开该文件并返回其诊断信息（`error`/`warning`/… 附带行号与消息）。 |
| `lsp_symbols` | `query`, `path?`, `limit?` | `readonly` | 在整个项目里搜索匹配 `query` 的声明；返回名称、种类（`class`、`function`…）与 `path:line`。 |
| `lsp_rename` | `path`, `line`, `character?`, `newName` | `write` | 在你批准 diff 之后，把该符号在服务器能解析到的所有位置改名，跨文件。 |

`lsp_symbols` 问的是**服务器级**的问题，因此需要知道该问哪个语言服务器。它会使用当前工作区里已经在运行的服务器——通常就是之前的 `lsp_*` 调用启动的那个。如果一个都没有，它会以 `lsp_no_session` 失败；传 `path`（该语言的任意一个文件）即可启动一个。

`path` 是工作区相对路径，且必须位于工作区内（与其他所有文件工具使用同一沙箱；`.env`/密钥等敏感文件会被拒绝）。`line` 是 **1-based**（与编辑器/工具惯例一致）；`character` 是 **0-based**（0 = 行首），默认 0。结果以 **1-based** 行号报告；仓库内的位置为工作区相对路径，仓库外的位置（标准库、依赖）以绝对路径显示。

五个工具中有四个只读取/分析，因此归为 **`readonly`**——与浏览器检查工具（`browser_snapshot` / `browser_console`）一样——在所有审批模式下自动放行。

## 重命名

`lsp_rename` 是唯一会写盘的 LSP 工具，而且它写的是调用方从未点名的文件。因此它的处理方式也不同。

**你批准的是 diff，而不是意图。** 在问你任何事情之前，这次重命名已经被完整算了出来：向服务器要到编辑、解析每一个目标、读取每一个文件并**在内存里**把编辑应用完。确认弹窗随后带着每个文件的真实 unified diff，以及按文件划分的可勾选 hunk。此刻磁盘上还没有任何改动。

**要么全做，要么不做。** 出现以下情况会**在弹窗之前**直接拒绝：编辑会碰到工作区之外的文件（例如 `node_modules` 或标准库里的定义）、路径经由指向外部的符号链接、服务器要求创建/重命名/删除文件（SeekForge 声明不支持这类操作，也不会执行），或任何目标文件自服务器读取后发生了变化。如果写入中途失败，已经写过的文件会被还原。

**被排除的文件会被明确报告。** 如果你只勾选了部分 hunk，结果里会列出被跳过的文件——部分重命名会留下仍然指向旧名字的引用，agent 必须知道这件事。

每个文件在被改动前都会打 checkpoint，因此 `seekforge rewind` 能像撤销其他编辑一样撤销整次重命名。

```
lsp_references({ path: "src/widget.ts", line: 12 })   # 先看影响范围
lsp_rename({ path: "src/widget.ts", line: 12, newName: "Panel" })
lsp_diagnostics({ path: "src/widget.ts" })            # 确认仍能编译
```

## 会话生命周期

**每种语言**只启动一个语言服务器，并跨调用复用（`initialize`/`initialized` 握手只运行一次，之后按需打开文档）。会话在运行结束时销毁——另有进程退出兜底——因此不会泄漏服务器进程，与共享的 headless 浏览器完全一样。

## 底层实现

客户端（`packages/core/src/tools/lsp/client.ts`）是一个基于服务器 stdio 的**极简 LSP JSON-RPC 客户端**：

- **帧格式（Framing）。** 每条消息是 `Content-Length: <bytes>\r\n\r\n` + 一个 JSON 体。
  `encodeLspMessage` / `parseLspMessages` 保持纯函数且流安全：
  解析器能处理一个 buffer 中的多条消息、末尾不完整的消息
  （留待下一个数据块），并能跳过畸形头部重新同步。
- **握手。** `initialize`（声明 definition/references/diagnostics/rename/
  workspace-symbol 能力与工作区根目录）→ 等待结果 → `initialized`。
  声明的 workspace edit 支持里资源操作列表为**空**，即告诉服务器：
  重命名的结果中不得包含文件的创建、改名或删除。
- **文档。** 首次触及某个文件时发送 `textDocument/didOpen`（附带文件的
  `languageId`、版本与文本）；`textDocument/didChange` 提升版本号，
  以强制一次全新的诊断。
- **请求。** `textDocument/definition`、`textDocument/references`、
  `textDocument/rename`、`workspace/symbol`，以及服务器推送的
  `textDocument/publishDiagnostics` 通知（在打开/修改文件后短暂等待）。
  位置在边界处从我们的 1-based `line` 转换为 LSP 的 0-based 行/列。
- **应用重命名。** `tools/lsp/workspace-edit.ts` 会归一化 WorkspaceEdit 的两种
  形态（`changes` 与 `documentChanges`），把 LSP 位置换算成字符串偏移
  （`character` 计的是 UTF-16 码元，正好就是 JavaScript 的字符串下标），
  拒绝相互重叠的编辑，并走与其他所有工具写入相同的校验写入路径。
