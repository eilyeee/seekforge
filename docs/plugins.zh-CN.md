# 插件

> [English](plugins.md) | **简体中文**

插件是一等扩展包，可通过一个经过审核的清单 —— SeekForge 自己的 `plugin.json`，或
Claude Code 的 `.claude-plugin/plugin.json`（见 [Claude Code 插件](#claude-code-插件)）——
贡献普通 SeekForge 技能、子代理、斜杠命令、输出风格、MCP 服务器、语言服务器和 hook。
插件不会绕过现有权限系统：插件工具仍经过常规工具权限判断，插件 hook 只有在显式批准后
才会启用。

强制更新会保留一个上一版本。`seekforge plugin supply-chain`（以及 `GET /api/plugins/supply-chain`）展示锁定/当前摘要、完整性、API 兼容性、能力与可回滚状态；`seekforge plugin rollback <id>` 是原子操作，恢复的上一版本保持禁用，必须重新审核摘要。产生「上一版本」的唯一动作是 `plugin update`，而它是个 CLI 命令——在此之前回滚却只能从桌面端触发，这一条此前并未说明。

## 生命周期与位置

- 项目插件位于 `.seekforge/plugins/<id>/`。SeekForge 只会以
  `review_required` 状态发现它们；仓库内容不能直接取得执行权限。
- `seekforge plugin install <source>` 从本地目录、git 仓库、https 归档或插件市场暂存
  插件（见[安装来源](#安装来源)），再复制到 `~/.seekforge/plugins/<id>/`。新安装或
  更新后的插件默认禁用。
- `seekforge plugin enable <id>` 批准安装目录全部文件的精确 SHA-256 摘要。
  此后任一文件改变都会使状态变为 `changed`，全部贡献自动停用，直到用户重新批准
  新摘要。
- `disable` 保留安装但移除全部贡献；`remove` 卸载插件并删除批准记录。

桌面端提供一级 **插件** 页面，完成同一套审核、安装和启停流程。TUI 的 `/plugins`
命令提供只读状态视图。

## 安装来源

`seekforge plugin install <source>`（以及等同于带 `--force` 的 `plugin update <source>`）
接受：

| 来源 | 示例 | 行为 |
| --- | --- | --- |
| 本地目录 | `./team-workflows` | 与以前一样复制。同一文本既是已存在的路径又形如 `<plugin>@<marketplace>` 时，按路径处理。 |
| git 仓库 | `https://github.com/acme/tools.git#v1.2.0`、`git@github.com:acme/tools.git`、`ssh://…`、`file:///srv/mirror/tools` | 以 `git clone --depth 1`（`#ref` 对应 `--branch <ref>`）克隆到私有暂存目录；记录检出的提交，并在任何校验之前删除 `.git`。 |
| https 归档 | `https://example.com/tools-1.2.0.tar.gz`（`.tgz`、`.zip`） | 下载后计算并记录 SHA-256，再用系统的 `tar` 或 `unzip` 解包。若只有一个顶层目录（如 GitHub tarball），会自动进入该目录。 |
| 插件市场条目 | `formatter@acme` | 通过已注册的插件市场解析，见[插件市场](#插件市场)。 |

未加密的 `http://` 与 `git://`、`ext::` 等其他 git 传输方式，以及以 `-` 开头的来源一律
拒绝。git 不经 shell 运行，固定 `protocol.ext.allow=never`，不拉取子模块，并关闭终端凭据
提示（`GIT_TERMINAL_PROMPT=0`）；嵌在 git URL 中的凭据只用于克隆，会从记录的来源中剔除。
带有内嵌凭据的归档 URL 会被拒绝。

无论来源如何，暂存副本随后都走与本地目录相同的安装流程：清单校验、拒绝链接与特殊文件、
1,000 个文件 / 10 MiB 上限，以及**在 `plugin enable` 批准其精确摘要之前保持禁用**。
来源信息（提交或归档 SHA-256，以及经由的插件市场）仅供参考——它出现在
`plugin list --json`、`plugin inspect --json` 与安装输出中，但批准只绑定已安装内容的
摘要，从不绑定来源。暂存目录位于 `~/.seekforge/plugins/.staging-*`，无论安装成功与否都会
被删除。

归档在交给系统工具之前会先检查：

- `.tar.gz` 在进程内解压，输出上限 32 MiB，解压炸弹不会落盘；下载本身上限 20 MiB；
- SeekForge 自行解析 tar/zip 成员表，拒绝任何符号链接、硬链接、设备文件、FIFO、
  绝对路径或 `..` 路径、set-id 位、加密成员和 zip64；
- `tar -t` / `unzip -Z1` 列出的成员必须与之一致（数量相同，纯 ASCII 名称逐一相同），
  否则不解包；
- 重定向由程序逐跳跟随，每一跳都必须仍是 https。

残余风险：上限检查的是 zip 成员*声明*的大小，而 `unzip` 只有在解压该成员之后才能发现
大小不符，因此恶意 zip 仍可能在安装失败、暂存目录被删除之前占用一些磁盘空间（受 60 秒
解包超时约束）。归档安装要求 `PATH` 上有 `tar` 与 `unzip`；仓库安装和 git 插件市场要求
有 git。

服务器的 `POST /api/plugins/install`（因而桌面端的安装流程）目前仍只接受本地路径。

## 插件市场

插件市场是把插件名映射到来源的目录，采用 Claude Code 的
`.claude-plugin/marketplace.json` 格式（也接受根目录的 `marketplace.json` 作为后备）：

```json
{
  "name": "acme",
  "owner": { "name": "Acme tools team" },
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "formatter", "source": "formatter", "description": "团队格式规则", "version": "1.2.0" },
    { "name": "reviewer", "source": { "source": "github", "repo": "acme/reviewer", "ref": "v2" } },
    { "name": "linter", "source": { "source": "url", "url": "https://git.example.com/linter.git", "path": "plugin" } },
    {
      "name": "bundle",
      "source": { "source": "archive", "url": "https://example.com/bundle.zip", "sha256": "<64 位十六进制>" }
    }
  ]
}
```

```bash
seekforge plugin marketplace add https://github.com/acme/marketplace.git   # 或本地目录
seekforge plugin marketplace list [--json]
seekforge plugin install formatter@acme
seekforge plugin enable formatter
seekforge plugin marketplace remove acme
```

- `plugin marketplace add <source> [--name <name>] [--force]` 接受 git URL（形式与
  `#ref` 同上）或本地目录。git 插件市场只克隆一次、不含历史，存放在
  `~/.seekforge/plugin-marketplaces/<name>/` 并记录提交；本地插件市场每次使用时都从其
  目录读取。名称默认取清单的 `name`，可用 `--name` 覆盖，只能使用小写字母、数字和连字符。
  注册信息保存在 `~/.seekforge/plugin-marketplaces.json`；重复添加同名市场需要 `--force`。
- 条目 `source` 的形式：相对路径（设置了 `metadata.pluginRoot` 时先与之拼接，解析符号
  链接后必须仍在市场目录内）；git 或 https 归档 URL 字符串；
  `{ "source": "github", "repo", "ref"?, "sha"?, "path"? }`；
  `{ "source": "url" | "git", "url", "ref"?, "sha"?, "path"? }`；以及
  `{ "source": "archive", "url", "sha256"? }`。`sha` 锁定确切提交（无法检出时安装失败）；
  `sha256` 必须与下载的归档一致才会解包；`path` 选择子目录。`npm` 与 `command` 来源一律
  拒绝：插件市场永远不能触发包管理器或命令。无法使用的条目会被列为跳过，而不会让整个市场
  失效。
- `plugin install <name>@<marketplace>` 只安装同名条目；若插件自身清单的 id 与之不同，
  安装会被拒绝，保证引用名副其实。记录的来源会写明插件市场以及底层的 git 提交、归档哈希或
  本地路径。
- `plugin marketplace remove <name>` 删除注册信息和缓存的克隆。已从该市场安装的插件保持
  安装（并继续受各自的批准约束）。

插件市场不授予任何权限。它解析出的每个插件都会像直接安装一样被暂存、校验并以禁用状态
安装，审核后仍需 `plugin enable`。不支持依赖 Claude Code `strict: false` 的条目（插件只由
市场条目描述、自身没有清单）：插件目录必须自带清单。

## 清单

原生插件包含严格校验的 `plugin.json`：

```json
{
  "apiVersion": 1,
  "id": "team-workflows",
  "name": "Team workflows",
  "version": "1.0.0",
  "description": "共享审核流程",
  "contributes": {
    "skillRoots": ["skills"],
    "agentRoots": ["agents"],
    "commandRoots": ["commands"],
    "outputStyleRoots": ["output-styles"],
    "lspServers": {
      "terraform": { "command": "terraform-ls", "args": ["serve"], "extensionToLanguage": { ".tf": "terraform" } }
    },
    "mcpServers": {
      "docs": {
        "url": "https://mcp.example.com/rpc",
        "permission": "readonly"
      }
    },
    "hooks": {
      "sessionStart": [{ "command": "node scripts/check-environment.mjs" }]
    },
    "graphHandlers": { "summarize": "collect" },
    "graphExecutors": { "build-farm": "trusted-build-farm" }
  }
}
```

ID 只能使用小写字母、数字与连字符；版本使用 SemVer 语法，包含可选的预发布与
构建元数据部分（`1.2.0-rc.1+build.7`）。贡献根目录必须是受限于
插件内的相对目录。MCP server 会以 `<plugin-id>__<server-name>` 对外暴露，避免歧义冲突。
当用户配置与插件 MCP 同名时，用户配置优先；插件 hook 先于用户配置 hook 运行。
hook 条目与用户 [hook](hooks.zh-CN.md) 使用相同的类型、阶段与校验，但插件的 `http`
hook 不得列出 `allowedEnvVars`。

插件贡献的 MCP server 只拥有其清单显式声明的连接信任。`trusted` 在这里与其它位置
一样默认为 `false`，因此上面的 `docs` server 会被列出，但不会被自动连接；清单里显式
写出的 `"trusted": false` 也一定会被保留。只有清单自身包含 `"trusted": true` 时，
自动发现才会启动该 server 的进程或访问其端点，其工具随后按 [MCP](mcp.zh-CN.md)
描述的常规权限映射处理。这一行属于已批准摘要的一部分：给已安装插件补上它会让插件
变为 `changed`，并停用全部贡献，直到新摘要被重新批准。若要连接清单未授予信任的
server，请在自己的配置中写入名为 `<plugin-id>__<server-name>` 的完整条目——用户配置
会替换插件条目。

`graphHandlers` 会为确定性内建处理器 `noop`、`collect`、`pick`、`project`、`merge`、`assert`、`count`、`summarize` 提供命名空间化别名，例如 `team-workflows__summarize`。`graphExecutors` 只能为嵌入宿主已经注册为可信且远程的适配器建立别名，清单本身不能创建或提升执行器。清单不能包含 Graph 处理器代码或 shell 命令；所有别名都会在 Graph 产生任何副作用前解析完成。

插件的 skill/agent 根目录按插件 ID 顺序加载；较后的插件可覆盖较早插件的同 ID 贡献，
用户级全局/项目定义总是最后加载并优先。建议 skill 与 agent ID 带插件前缀。
每次 Agent 或 Loop 组装只生成一份贡献快照，并在技能、子代理、hook 与 MCP server 间
复用其中已批准的根目录与配置。下次组装会重新校验安装摘要；活跃运行期间不要修改已安装插件。

`commandRoots` 存放[自定义命令](../apps/tui/README.md#custom-commands)格式的 Markdown
斜杠命令，命名为 `<plugin-id>:<command>`（子目录会再追加 `:` 段），作用域报告为 `user`
并带 `plugin` 字段；与项目或用户命令同名时让位于后者。模型可以像其他自定义命令一样通过
`run_user_command` 调用它们。`outputStyleRoots` 存放 `<name>.md` 输出风格，可以
`<plugin-id>:<name>` 选择，排在内置、项目与用户风格之后。`lspServers` 为 `lsp_*` 工具新增或
替换语言服务器，以 `<plugin-id>:<server>` 暴露；两个插件声明同一扩展名时插件 ID 较小者
胜出，而用户自己的 `lspServers` 配置优先于所有插件（见
[LSP](lsp.zh-CN.md#配置语言服务器)）。

## Claude Code 插件

没有 `plugin.json`、但有 `.claude-plugin/plugin.json` 的目录会被当作 Claude Code 插件读取，
并在内存中完成转换 —— 磁盘上的文件以及你批准的摘要都不会改变。只有 `name` 是必需的，它必须
是 kebab-case，并成为插件 ID。缺失或不符合 SemVer 的 `version` 显示为 `0.0.0`。组件映射如下：

| Claude Code | SeekForge |
| --- | --- |
| `skills/`（清单中的 `skills` 路径会追加） | 技能根目录；`SKILL.md` frontmatter 原生读取（[技能](skills.zh-CN.md#claude-code-技能)） |
| `commands/`（清单中的 `commands` 会替换它） | 命令根目录，`<plugin>:<command>` |
| `agents/`（清单中的 `agents` 会替换它） | 代理根目录 —— Claude Code 的扁平 `agents/<name>.md` 文件暂不加载，会被报告 |
| `output-styles/`（清单中的 `outputStyles` 会替换它） | 输出风格根目录，`<plugin>:<style>` |
| `hooks/hooks.json` 或清单 `hooks` | hook：`PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit`、`PreCompact`、`Stop`、`SubagentStop`、`Notification`、`SessionEnd` |
| `.mcp.json` 或清单 `mcpServers` | MCP 服务器，名称转为小写 `[a-z0-9-]`，并标记为 `trusted: true` |
| `.lsp.json` 或清单 `lspServers` | 语言服务器（`command`、`args`、`env`、`extensionToLanguage`、`initializationOptions`） |

清单中的组件值可以是相对路径、路径列表，或（对 hook、MCP、LSP 而言）内联对象。路径必须留在
插件内部；组件根目录只接受目录。`${CLAUDE_PLUGIN_ROOT}` 解析为已安装的插件目录：它会被代入
MCP 与 LSP 的命令、参数和环境变量值以及技能正文，并导出给 hook 命令，hook 以
`export CLAUDE_PLUGIN_ROOT='<dir>'; <command>` 的形式运行。

有两项映射带有授权含义，请在 `plugin enable` 之前审核：

- **MCP 服务器会自动连接。** Claude Code 在插件启用时启动其服务器；SeekForge 通过把转换后的
  条目标记为 `trusted: true` 做到同样的事，因此启用该摘要就是授予信任。
- **hook 沿用 SeekForge 的约定。** hook 命令收到的是 SeekForge 的 JSON 负载（见
  [配置](configuration.zh-CN.md#hooks)），且 `preToolUse` hook 任何非零退出码都会阻止调用 ——
  针对 Claude Code 负载或其「退出码 2」约定编写的脚本行为可能不同。

无法映射的内容会被略去，并作为插件记录上的 `warnings` 列出（`plugin inspect <id> --json`）：
其他 hook 事件、非 `command` 类型的 hook、不是简单 `Tool|Tool` 形式的匹配器（工具匹配器使用
Claude Code 工具名，会映射到 SeekForge 的工具）、非工具事件上的任何匹配器、使用 `sse` 等
不支持传输方式的 MCP 服务器、无效的语言服务器、缺失或越界的路径，以及扁平代理文件。
`supply-chain` 报告会在插件能力中列出 `commands`、`output-styles` 与 `lsp`。

## 安全边界

安装只接受由普通文件组成的真实目录；符号链接和特殊文件会被拒绝。单个插件最多
1,000 个文件、10 MiB，清单最多 64 KiB。无效、超限、已变更、仅项目发现或已禁用
的插件都不会产生任何贡献。

启用插件属于授权操作。请审核完整目录，尤其是 hook、stdio MCP 命令、MCP 的 `trusted`
标记（以及 Claude Code 插件的 `.mcp.json`，启用后即被信任）、语言服务器命令、环境变量/
请求头，以及 agent/skill 指令 —— 插件技能的 `allowed-tools` 会在该技能激活期间预先批准
这些工具。摘要检查能发现变更，但不能证明作者可信，也不能替代第三方代码
沙箱。

## CLI

```bash
seekforge plugin list [--json]
seekforge plugin inspect <id> [--json]
seekforge plugin validate <path>
seekforge plugin create <id>
seekforge plugin install <source>     # 路径 | git URL[#ref] | https 归档 | <plugin>@<marketplace>
seekforge plugin update <source>
seekforge plugin enable|disable <id>
seekforge plugin remove <id>
seekforge plugin marketplace add <source> [--name <name>] [--force]
seekforge plugin marketplace remove <name>
seekforge plugin marketplace list [--json]
```

顶层命令 `plugin` 也可使用别名 `plugins`。
