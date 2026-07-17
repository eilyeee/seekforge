# 自主 GitHub issue → PR（`seekforge resolve`）

> [English](github.md) | **简体中文**

`seekforge resolve <issue>` 读取一个 GitHub issue，用一次 headless、成本受限的智能体运行在全新工作分支上修复它，验证结果，然后打开一个 draft pull request——即 OpenHands 风格的「给它一个 issue，拿回一个 PR」流程。

**成熟度：**已实现且可用，带有明确的、由人发起的 push/PR 边界。issue 修复默认在隔离的 worktree 中运行，`--wait-ci` 可以等待托管检查，`seekforge resolve-review` 可以处理评审反馈。已有的本地 `seekforge/issue-<n>` 分支在未被其他位置 checkout 时会被复用。`--wait-ci` 可执行一次受限的 CI 修复。

```
seekforge resolve <issue-number-or-url> --max-cost <n> [--base <branch>] [--model <m>] [--no-draft] [--no-worktree] [--wait-ci] [--dry-run]
```

## 护城河：智能体负责修，命令负责推

`resolve` 是一个**由用户发起的命令**，因此 `git push` 与 `gh pr create` 是*你*的显式动作——由命令本身执行，而非智能体。智能体只在 headless 修复运行期间编辑文件；它从不 push，也从不打开 PR。因此 SeekForge 的 push 审批门禁完好无损：一个自主智能体依然无法在没有明确的人工命令的情况下把代码送上你的 remote。

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
4. **验证**：如果 `.seekforge/config.json` 中配置了 `verifyCommand`
   （和/或 `lintCommand`），则会运行它。**若失败，不会打开 PR**——
   修复留在分支上，并报告失败。
5. **提交 + push + 打开 PR**（由命令直接完成）：
   `git add -A` → `git commit -m "Resolve #<n>: <title>"` →
   `git push -u origin seekforge/issue-<n>` →
   `gh pr create --draft --base <base> --head <branch> --title "…" --body "Resolves #<n> …"`。
6. **打印 PR URL。** 使用 `--wait-ci` 时，检查失败最多触发一次修复：
   最新失败的 Actions 运行的失败步骤日志被截断到 20,000 字符，
   以「不可信数据」形式围栏后交给智能体，然后验证、提交、push，
   并再检查一次。

如果智能体没有做出任何改动，`resolve` 会在提交之前停止（没有可 PR 的内容）。

## Flag

| Flag | 含义 |
| --- | --- |
| `--max-cost <usd>` | **必填。** 单次运行的成本上限（USD）——自主修复必须有界，与 `schedule` 完全一致。 |
| `--base <branch>` | PR 的目标 base 分支。默认 `main`。 |
| `--model <m>` | headless 修复运行的模型覆盖。 |
| `--no-draft` | 打开一个 ready-for-review 的 PR 而非 draft（默认是 draft）。 |
| `--dry-run` | 执行步骤 1–4（获取 + 分支 + 修复 + 验证），然后**打印**将要运行的确切 commit/push/PR 命令——不 push，也不打开 PR。 |
| `--no-worktree` | 使用当前 checkout，而非默认的临时隔离 worktree。 |
| `--wait-ci` | 等待托管的 PR 检查；失败时允许一次受限的失败日志修复，并再检查一次。 |

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
```

每次修复都是一个正常的、可审计的 SeekForge 会话——用 `seekforge sessions` / `seekforge audit` 检查它，或用 `seekforge rewind` 撤销它。

## 评审反馈

`seekforge resolve-review <pr> --max-cost <usd>` 在隔离的 worktree 中 checkout 一个已有 PR，将其评论与 review 交给一次成本受限的 headless 智能体运行，验证改动，然后提交并 push。它支持 `--no-worktree`、`--dry-run`、`--wait-ci` 与 `--model`，安全模型与 `resolve` 相同。
