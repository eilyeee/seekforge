/** Strings for components/chat/ (composer, chat items, tool rows, tab bar,
 * permission modal, etc.). en is canonical; keep keys "chat."-prefixed. */
export const chat = {
  en: {
    // Composer
    "chat.composer.uploading": "uploading image…",
    "chat.composer.uploadFailed": "upload failed: {error}",
    "chat.composer.removeImage": "Remove image #{n}",
    "chat.composer.attach": "Attach image",
    "chat.composer.slash": "Slash commands",
    "chat.composer.mention": "Mention a file",
    "chat.composer.send": "Send",
    "chat.composer.sendHint": "Enter to send · Shift+Enter for a new line",
    "chat.composer.cmdLabel": "Commands",
    "chat.composer.fileLabel": "Files",
    "chat.composer.thinkLabel": "Think",

    // ChatItems
    "chat.thinking": "thinking",
    "chat.thinking.streaming": "thinking…",
    "chat.sessionCompleted": "session completed",
    "chat.filesChanged": "{n} file(s) changed",
    "chat.tokens": "tokens",
    "chat.contextCompacted": "context compacted — {droppedTurns} turns summarized into ~{summaryTokens} tokens",
    "chat.microCompacted": "context micro-compacted — {clearedResults} old tool result(s) cleared",
    "chat.resumeInfo.prefix": "→ resume with",
    "chat.resumeInfo.suffix": "(your file changes and completed steps are preserved; checkpoints intact)",
    "chat.rewindTitle": "Rewind the conversation to just before this message",

    // ToolRow
    "chat.tool.args": "args",
    "chat.tool.result": "result",

    // TabBar
    "chat.tab.tabsSummary": "{count} tab(s) · total {cost}",
    "chat.tab.waitingApproval": "waiting for approval",
    "chat.tab.running": "running",
    "chat.tab.worktreeBranch": "worktree branch: {branch}",
    "chat.tab.worktreeBranchDirty": "worktree branch: {branch} (uncommitted changes)",
    "chat.tab.uncommitted": "uncommitted changes",
    "chat.tab.workspace": "workspace: {name}",
    "chat.tab.mergeBack": "Merge back",
    "chat.tab.discard": "Discard\u2026",
    "chat.tab.newTab": "New tab",
    "chat.tab.newWorktreeSession": "New worktree session",
    "chat.tab.newWorktreeTitle": "Run this session on an isolated git worktree branch; merge back when done",
    "chat.tab.closeLabel": "close {title}",
    "chat.tab.worktreeMenuLabel": "worktree menu for {title}",
    "chat.tab.newTabMenuLabel": "new tab menu",

    // PermissionModal
    "chat.permission.reviewEdits": "Review {count} edits in {path}",
    "chat.permission.reviewEditsFallback": "unknown",
    "chat.permission.permissionRequired": "Permission required",
    "chat.permission.skipAll": "Skip all",
    "chat.permission.applySelected": "Apply selected ({selected}/{total})",
    "chat.permission.applyAll": "Apply all",
    "chat.permission.selectAll": "Select all",
    "chat.permission.individualEdits": "Individual edits",
    "chat.permission.editNumber": "Edit #{n}",
    "chat.permission.reject": "Reject",
    "chat.permission.accept": "Accept",
    "chat.permission.deny": "Deny",
    "chat.permission.allowSession": "Allow for session",
    "chat.permission.allowOnce": "Allow once",
    "chat.permission.rawCommand": "raw command",
    "chat.permission.rawPath": "raw path",
    "chat.permission.reviewChange": "Review change: {path}",

    // QuestionModal
    "chat.question.title": "The agent has a question",
    "chat.question.decline": "Decline to answer",

    // PlanCard
    "chat.plan.title": "plan",

    // UsageFooter
    "chat.usage.prompt": "prompt {tokens}",
    "chat.usage.cacheHit": "cache-hit {tokens}",
    "chat.usage.completion": "completion {tokens}",
    "chat.usage.ctx": "ctx {percent}%",
    "chat.usage.balanceLeft": "left",
    "chat.usage.promptTitle": "prompt tokens",
    "chat.usage.cacheHitTitle": "DeepSeek context-cache hits",
    "chat.usage.completionTitle": "completion tokens",
    "chat.usage.costTitle": "cumulative cost",
    "chat.usage.ctxTitle": "context window: {used} of {budget} budget tokens used",
    "chat.usage.balanceTitle": "DeepSeek account balance remaining",
  },
  zh: {
    // Composer
    "chat.composer.uploading": "正在上传图片…",
    "chat.composer.uploadFailed": "上传失败：{error}",
    "chat.composer.removeImage": "移除图片 #{n}",
    "chat.composer.attach": "添加图片",
    "chat.composer.slash": "斜杠命令",
    "chat.composer.mention": "引用文件",
    "chat.composer.send": "发送",
    "chat.composer.sendHint": "Enter 发送 · Shift+Enter 换行",
    "chat.composer.cmdLabel": "命令",
    "chat.composer.fileLabel": "文件",
    "chat.composer.thinkLabel": "思考",

    // ChatItems
    "chat.thinking": "思考",
    "chat.thinking.streaming": "思考中…",
    "chat.sessionCompleted": "会话完成",
    "chat.filesChanged": "修改了 {n} 个文件",
    "chat.tokens": "token",
    "chat.contextCompacted": "上下文已压缩 — 将 {droppedTurns} 轮对话总结为约 {summaryTokens} 个 token",
    "chat.microCompacted": "上下文微压缩 — 清除了 {clearedResults} 个旧工具结果",
    "chat.resumeInfo.prefix": "→ 使用",
    "chat.resumeInfo.suffix": "（文件改动和已完成步骤均已保留，检查点完好）",
    "chat.rewindTitle": "将对话回退到本条消息之前",

    // ToolRow
    "chat.tool.args": "参数",
    "chat.tool.result": "结果",

    // TabBar
    "chat.tab.tabsSummary": "共 {count} 个标签 · 总计 {cost}",
    "chat.tab.waitingApproval": "等待批准",
    "chat.tab.running": "运行中",
    "chat.tab.worktreeBranch": "工作树分支：{branch}",
    "chat.tab.worktreeBranchDirty": "工作树分支：{branch}（有未提交更改）",
    "chat.tab.uncommitted": "有未提交更改",
    "chat.tab.workspace": "工作区：{name}",
    "chat.tab.mergeBack": "合并回主分支",
    "chat.tab.discard": "丢弃…",
    "chat.tab.newTab": "新建标签",
    "chat.tab.newWorktreeSession": "新建工作树会话",
    "chat.tab.newWorktreeTitle": "在独立的工作树分支上运行此会话，完成后合并回主分支",
    "chat.tab.closeLabel": "关闭 {title}",
    "chat.tab.worktreeMenuLabel": "{title} 的工作树菜单",
    "chat.tab.newTabMenuLabel": "新建标签菜单",

    // PermissionModal
    "chat.permission.reviewEdits": "审查 {path} 中的 {count} 处编辑",
    "chat.permission.reviewEditsFallback": "未知",
    "chat.permission.permissionRequired": "需要权限",
    "chat.permission.skipAll": "全部跳过",
    "chat.permission.applySelected": "应用所选（{selected}/{total}）",
    "chat.permission.applyAll": "全部应用",
    "chat.permission.selectAll": "全选",
    "chat.permission.individualEdits": "单处编辑",
    "chat.permission.editNumber": "编辑 #{n}",
    "chat.permission.reject": "拒绝",
    "chat.permission.accept": "接受",
    "chat.permission.deny": "拒绝",
    "chat.permission.allowSession": "本次会话允许",
    "chat.permission.allowOnce": "允许一次",
    "chat.permission.rawCommand": "原始命令",
    "chat.permission.rawPath": "原始路径",
    "chat.permission.reviewChange": "审查更改：{path}",

    // QuestionModal
    "chat.question.title": "代理有一个问题",
    "chat.question.decline": "拒绝回答",

    // PlanCard
    "chat.plan.title": "计划",

    // UsageFooter
    "chat.usage.prompt": "提示 {tokens}",
    "chat.usage.cacheHit": "缓存命中 {tokens}",
    "chat.usage.completion": "补全 {tokens}",
    "chat.usage.ctx": "上下文 {percent}%",
    "chat.usage.balanceLeft": "剩余",
    "chat.usage.promptTitle": "提示 token",
    "chat.usage.cacheHitTitle": "DeepSeek 上下文缓存命中",
    "chat.usage.completionTitle": "补全 token",
    "chat.usage.costTitle": "累计费用",
    "chat.usage.ctxTitle": "上下文窗口：已用 {used}，预算 {budget} 个 token",
    "chat.usage.balanceTitle": "DeepSeek 账户余额",
  },
} as { en: Record<string, string>; zh: Record<string, string> };
