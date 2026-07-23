# 插件

> [English](plugins.md) | **简体中文**

插件是一等扩展包，可通过一个经过审核的清单贡献普通 SeekForge 技能、子代理、MCP
服务器和 hook。插件不会绕过现有权限系统：插件工具仍经过常规工具权限判断，插件
hook 只有在显式批准后才会启用。

## 生命周期与位置

- 项目插件位于 `.seekforge/plugins/<id>/`。SeekForge 只会以
  `review_required` 状态发现它们；仓库内容不能直接取得执行权限。
- `seekforge plugin install <path>` 把审核过的本地目录复制到
  `~/.seekforge/plugins/<id>/`。新安装或更新后的插件默认禁用。
- `seekforge plugin enable <id>` 批准安装目录全部文件的精确 SHA-256 摘要。
  此后任一文件改变都会使状态变为 `changed`，全部贡献自动停用，直到用户重新批准
  新摘要。
- `disable` 保留安装但移除全部贡献；`remove` 卸载插件并删除批准记录。

桌面端提供一级 **插件** 页面，完成同一套审核、安装和启停流程。TUI 的 `/plugins`
命令提供只读状态视图。

## 清单

每个插件都必须包含严格校验的 `plugin.json`：

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
    "mcpServers": {
      "docs": {
        "url": "https://mcp.example.com/rpc",
        "permission": "readonly"
      }
    },
    "hooks": {
      "sessionStart": [{ "command": "node scripts/check-environment.mjs" }]
    }
  }
}
```

ID 只能使用小写字母、数字与连字符；版本使用 SemVer 语法。贡献根目录必须是受限于
插件内的相对目录。MCP server 会以 `<plugin-id>__<server-name>` 对外暴露，避免歧义冲突。
当用户配置与插件 MCP 同名时，用户配置优先；插件 hook 先于用户配置 hook 运行。

插件的 skill/agent 根目录按插件 ID 顺序加载；较后的插件可覆盖较早插件的同 ID 贡献，
用户级全局/项目定义总是最后加载并优先。建议 skill 与 agent ID 带插件前缀。
每次 Agent 或 Loop 组装只生成一份贡献快照，并在技能、子代理、hook 与 MCP server 间
复用其中已批准的根目录与配置。下次组装会重新校验安装摘要；活跃运行期间不要修改已安装插件。

## 安全边界

安装只接受由普通文件组成的真实目录；符号链接和特殊文件会被拒绝。单个插件最多
1,000 个文件、10 MiB，清单最多 64 KiB。无效、超限、已变更、仅项目发现或已禁用
的插件都不会产生任何贡献。

启用插件属于授权操作。请审核完整目录，尤其是 hook、stdio MCP 命令、环境变量/请求头，
以及 agent/skill 指令。摘要检查能发现变更，但不能证明作者可信，也不能替代第三方代码
沙箱。

## CLI

```bash
seekforge plugin list [--json]
seekforge plugin inspect <id> [--json]
seekforge plugin validate <path>
seekforge plugin create <id>
seekforge plugin install <path>
seekforge plugin update <path>
seekforge plugin enable|disable <id>
seekforge plugin remove <id>
```

顶层命令 `plugin` 也可使用别名 `plugins`。
