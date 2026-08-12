# 自主 GitHub issue → PR（`seekforge resolve`）

> [English](github.md) | **简体中文**

`seekforge resolve <issue>` 读取一个 GitHub issue，用一次 headless、成本受限的智能体运行在全新工作分支上修复它，验证结果，然后打开一个 draft pull request——即 OpenHands 风格的「给它一个 issue，拿回一个 PR」流程。

**成熟度：**已实现且可用，带有明确的、由人发起的 push/PR 边界。issue 修复默认在隔离的 worktree 中运行，`--wait-ci` 可以等待托管检查，`seekforge resolve-review` 可以处理评审反馈。已有的本地 `seekforge/issue-<n>` 分支在未被其他位置 checkout 时会被复用。`--wait-ci` 可执行一次受限的 CI 修复。

```
seekforge resolve <issue-number-or-url> --max-cost <n> [--base <branch>] [--model <m>] [--no-draft] [--no-worktree] [--wait-ci] [--dry-run] [-y]
```

## 护城河：智能体负责修，命令负责推

`resolve` 是一个**由用户发起的命令**，因此 `git push` 与 `gh pr create` 是*你*的显式动作——由命令本身执行，而非智能体。智能体只在 headless 修复运行期间编辑文件；它从不 push，也从不打开 PR。因此 SeekForge 的 push 审批门禁完好无损：一个自主智能体依然无法在没有明确的人工命令的情况下把代码送上你的 remote。

## 这里的「headless」意味着什么

修复运行是真正无人值守的——它永远不会停下来问你任何事：

- **任何会弹出提示的审批都被自动拒绝。** 该运行采用机器输出格式，理由与
  `schedule run` 完全相同：凡是超出 `acceptEdits` 的操作（执行 shell、修改环境、
  被策略拒绝的调用）都会被拒绝，而不是升级给人。一条只有在有人盯着终端时才成立的
  护栏，不是护栏。
- **只有文件编辑会自动应用**（`acceptEdits`），且发生在工作分支内。
- **不会流式输出智能体的每一步。** 你看到的是 resolve 自己的进度行（worktree、
  验证、PR URL），而不是逐个工具调用的实时渲染。
- **文件夹授权依然生效。** SeekForge 必须先被授权才能编辑某个目录。已授权的仓库会把
  该授权带入本次运行创建的临时 worktree；而从未被授权的 checkout（例如 CI 里的全新
  clone）必须传 `-y`——因为 headless 运行没有可回退的交互提示，只会尽早失败。

## 流程

1. **获取 issue**（只读）：`gh issue view <n> --json title,body,number`。
   也接受完整的 issue URL——编号会从中提取。
2. **从选定的 base 创建隔离 worktree 与工作分支**，或复用已有的本地
   issue 分支。只有当你有意要改动当前 checkout 时才传
   `--no-worktree`。
3. **以 headless 方式运行智能体**进行修复。任务提示词由 issue 构建：

   > Resolve GitHub issue #\<n>: \<title>
   >
   > \<body>
   >
   > Make the minimal change that fixes it and ensure tests pass.

   该运行为 `edit` 模式并启用 `acceptEdits`（文件编辑自动应用），
   并受**必填的** `--max-cost` 预算约束。
4. **验证**：如果**你的用户配置**（`~/.seekforge/config.json` 或 `--settings`
   文件）中配置了 `verifyCommand`（和/或 `lintCommand`），则会运行它。
   **若失败，不会打开 PR**——修复留在分支上，并报告失败。这两项是用户级设置：
   仓库 `.seekforge/config.json` 中的取值会作为仓库输入被剥离，因此克隆下来的
   仓库无法让 `resolve` 运行它自选的命令。
5. **提交 + push + 打开 PR**（由命令直接完成）：
   `git add -A` → `git commit -m "Resolve #<n>: <title>"` →
   `git push -u origin seekforge/issue-<n>` →
   `gh pr create --base <base> --head <branch> --title "…" --body "Resolves #<n> …" --draft`
   （`--draft` 追加在最后，使用 `--no-draft` 时省略）。
6. **打印 PR URL。** 使用 `--wait-ci` 时，检查失败最多触发一次修复：
   最新失败的 Actions 运行的失败步骤日志被截断到 20,000 字符，
   以「不可信数据」形式围栏后交给智能体，然后验证、提交、push，
   并再检查一次。
7. **在删除临时 worktree 之前把会话 trace 复制回仓库**，使这次运行保持可审计
   （见下文）。

如果智能体没有做出任何改动，`resolve` 会在提交之前停止（没有可 PR 的内容）。

### 隔离 worktree 里能看到什么

`.seekforge/` 通常被 gitignore，所以新建的 worktree 里不会有它，运行就只能退回到
你的全局配置。因此 `resolve` 会把仓库的项目层带进去：项目的偏好（模型、编辑格式
等）、它的 `deny` 权限规则，以及 `.seekforge/skills`、`agents`、`commands`、
`output-styles` 与 `memory/project.md`。

带进去的恰好只有这些。配置会经过与基检出对仓库层完全相同的那道降权，因此凭据、
`baseUrl`、`verifyCommand` 和 hook 都到不了临时目录。`mcpServers` 被排除——仓库
条目永远不受信任，在无头运行中根本无法连接，而它们的 `env`/`headers` 恰恰可能装着
密钥。`.seekforge/plugins` 也被排除，因为插件可以授予受信任的 MCP 服务器和 hook。
除非 git 确认目标被忽略，否则不写入任何文件，所以带进去的文件绝不会出现在 PR 里。
`resolve-review` 的行为相同。

## Flag

| Flag | 含义 |
| --- | --- |
| `--max-cost <usd>` | **必填。** 单次运行的成本上限（USD）——自主修复必须有界，与 `schedule` 完全一致。 |
| `--base <branch>` | PR 的目标 base 分支。默认 `main`。 |
| `--model <m>` | headless 修复运行的模型覆盖。 |
| `--no-draft` | 打开一个 ready-for-review 的 PR 而非 draft（默认是 draft）。 |
| `--dry-run` | 执行步骤 1–4（获取 + 分支 + 修复 + 验证），然后**打印**将要运行的确切 commit/push/PR 命令——不 push，也不打开 PR。 |
| `--no-worktree` | 使用当前 checkout，而非默认的临时隔离 worktree。 |
| `--wait-ci` | **最多等待 15 分钟**托管的 PR 检查；失败时允许一次受限的失败日志修复，并再检查一次。达到 15 分钟上限只会报告为警告，**不是**失败：PR 已经打开，因此命令仍以成功退出，并打印可供你自己跟进的 `gh pr checks` 命令。 |
| `-y`、`--yes` | 预先授权工作目录（文件夹访问授权）。只有在 SeekForge 从未授权过的 checkout 上才需要——通常是 CI。它**不会**放宽本次运行的审批：修复运行始终是 `acceptEdits`。 |

## 前置条件

- 必须安装并认证 **GitHub CLI**（`gh`）（`gh auth login`；
  用 `gh auth status` 检查）。若缺少 `gh`，`resolve` 会尽早失败并给出可操作的提示。
- 仓库必须有 **`origin` remote**（`git remote add origin <url>`）。
- 必须配置好 provider API 密钥（与任何 `seekforge run` 相同）。

## 示例

```bash
# Fix issue 42 and open a draft PR against main, capped at $1.00.
seekforge resolve 42 --max-cost 1.00

# From a URL, targeting a release branch, ready for review.
seekforge resolve https://github.com/owner/repo/issues/42 \
  --max-cost 2.00 --base release/1.4 --no-draft

# See what it would do without pushing or opening a PR.
seekforge resolve 42 --max-cost 1.00 --dry-run

# In CI, on a checkout SeekForge has not been authorized for.
seekforge resolve 42 --max-cost 1.00 --wait-ci -y
```

## 事后审计一次运行

每次修复都是一个正常的 SeekForge 会话。修复发生在临时 worktree *内部*，而它在运行成功后会被删除——因此 `resolve` 会在删除之前把会话 trace 复制回你仓库的 `.seekforge/sessions/`。于是在仓库里运行 `seekforge sessions` 与 `seekforge audit`，都能像查看其他任何会话一样看到这次修复运行，无论是否使用 worktree。

`seekforge rewind` 是例外：它只在**运行它的那个 checkout** 里恢复文件。使用默认 worktree 时，修复从未触碰你的 checkout——它位于已 push 的 `seekforge/issue-<n>` 分支上，所以撤销方式是关闭 PR 并删除该分支。而在 `--no-worktree` 下，改动确实在你的 checkout 里，`seekforge rewind` 可以就地撤销。

## 评审反馈

`seekforge resolve-review <pr> --max-cost <usd>` 在隔离的 worktree 中 checkout 一个已有 PR，将其评论与 review 交给一次成本受限的 headless 智能体运行，验证改动，然后提交并 push。它支持 `--no-worktree`、`--dry-run`、`--wait-ci`、`--model` 与 `-y`。

它与 `resolve` 共享同样的边界——智能体只编辑文件、由命令执行 push、运行受成本约束、非交互且可审计——但有两处刻意的差异：

- **这里的 `--wait-ci` 不做 CI 修复。** 它只等待（同样是 15 分钟上限）并报告检查失败，绝不会针对失败日志再启动一次智能体运行。如果需要再来一轮，请在 push 修复后重新运行 `resolve-review`。
- **它使用普通的 `git push`**，推送到 `gh pr checkout` 配置的 upstream——对于来自 fork 的 PR，那是*该 fork 的*分支，而不是你的仓库。运行前请确认你在修的是谁的 PR。
