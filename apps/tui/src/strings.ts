/**
 * Tiny i18n layer for the TUI chrome. No deps, no ICU — just a flat
 * key → string table per locale with an English fallback chain:
 *
 *   t(key) → STRINGS[locale][key] → STRINGS.en[key] → key
 *
 * A missing key NEVER throws; it renders as the key itself so a typo is
 * visible in the UI instead of crashing a render. Locale detection follows
 * SEEKFORGE_LANG > LC_ALL/LANG (any "zh" prefix → zh-CN) > "en".
 *
 * English values are the canonical UI strings — components and helpers
 * (keyHints, TIPS, status bar, pickers) read through t(), so the en table
 * must stay byte-identical with what tests assert.
 */

export type Locale = "en" | "zh-CN";

/** Number of rotating tips (keys "tips.0" … "tips.N-1"). */
export const TIP_COUNT = 12;

const EN: Record<string, string> = {
  // ── Footer key hints (render-helpers keyHints) ────────────────────────
  "hints.idle": "⏎ send · / commands · @ files · Ctrl+R history",
  "hints.running": "Esc interrupt · Ctrl+B background · ⏎ queue",
  "hints.permission": "y allow · a allow session · A always · n deny",

  // ── Status bar ─────────────────────────────────────────────────────────
  "status.ready": "ready",
  "status.working": "working…",
  "status.interrupt": "esc to interrupt",
  "status.scrolled": "↑ scrolled",

  // ── Header ──────────────────────────────────────────────────────────────
  "tip.prefix": "※",

  // ── Picker / palette footers ────────────────────────────────────────────
  "picker.palette": "↑↓ select · Tab/Enter complete · Esc dismiss",
  "picker.list": "↑↓ select · Enter accept · Esc dismiss",
  "picker.resume": "↑↓ select · Enter resume · f fork · Esc dismiss",
  "picker.rewind": "↑↓ select · Enter rewind conversation+files · c conversation only · Esc dismiss",
  "picker.model": "↑↓ select · Enter switch · Esc dismiss",
  "picker.history": "↑↓ select · Tab fill · Enter run · Esc dismiss",
  "picker.slash": "↑↓ select · Enter insert · Esc close — @ files · # remember · ! shell · Shift+Tab approval",
  "picker.theme": "↑↓ select · Enter apply · Esc dismiss",
  "picker.candidates": "↑↓ select · a approve · r reject · s scope · Esc dismiss",
  "picker.emptyCommands": "no matching commands",
  "picker.emptyFiles": "no matching files",
  "picker.emptyList": "nothing to show",
  "picker.titleSessions": "Sessions",
  "picker.titleBacktrack": "Backtrack — rewind the conversation to…",
  "picker.titleModel": "Model",
  "picker.titleTheme": "Theme",
  "picker.titleCommands": "Commands",
  "picker.titleCandidates": "Memory candidates — review pending facts",

  // ── ask_user question overlay ─────────────────────────────────────────────
  "question.title": "Question from the agent",
  "question.footerPrefix": "↑↓ or 1-",
  "question.footerSuffix": " select · Enter answer · Esc declines",
  "question.footerFreeText": "type an answer · ↑↓ select · Enter send · Esc declines",

  // ── Sidebar file tree (Ctrl+E) ────────────────────────────────────────────
  "sidebar.title": "Files",
  "sidebar.empty": "(empty)",
  "sidebar.footer": "↑↓ · Enter insert @path · ←→ fold · Ctrl+E close",

  // ── Transcript pager (Ctrl+L) ─────────────────────────────────────────────
  "pager.title": "Transcript",
  "pager.hint": "(q/Esc close · ↑↓/PgUp/PgDn/g/G scroll)",
  "pager.empty": "(transcript is empty)",

  // ── Permission panel ────────────────────────────────────────────────────
  "permission.title": "Permission required",
  "permission.command": "command:",
  "permission.path": "path:",
  "permission.allowOnce": "y allow once",
  "permission.allowSession": "a allow similar commands this session",
  "permission.allowAlways": "A always allow, saved as",
  "permission.saved": "saved permission rule:",
  "permission.saveFailed": "could not save the permission rule (allowed for this session only):",
  "permission.deny": "any other key deny",
  "permission.reviewChange": "Review change:",
  "permission.applyChange": "Apply this change? y accept · n reject",
  "permission.hunk": "Hunk",
  "permission.hunkFooter": "number key toggle hunk · a select all · y confirm · n deny",

  // ── Mode line under the composer ────────────────────────────────────────
  "mode.autoApprove": "⏵⏵ auto-approve on",
  "mode.acceptEdits": "⏵ accept-edits on",
  "mode.plan": "⏸ plan mode on",
  "mode.cycleHint": "(shift+tab to cycle)",

  // ── Composer placeholders (app-level; integrator adopts) ───────────────
  "composer.idle": "Ask SeekForge to do something…  (/ commands · @ files · # remember · ! shell)",
  "composer.running": "working… type to queue a follow-up · Esc cancels · ! runs shell",
  "composer.permissionWait": "answer the permission prompt above (y · a · any other key denies)",

  // ── Rotating tips (render-helpers TIPS) ────────────────────────────────
  "tips.0": "Type @ to attach files to your message",
  "tips.1": "Press / to open the command palette",
  "tips.2": "Start a line with # to save a note to project memory",
  "tips.3": "Start a line with ! to run a shell command directly",
  "tips.4": "Ctrl+B detaches the current run to the background",
  "tips.5": "Ctrl+O toggles verbose output (full diffs and tool results)",
  "tips.6": "Press Esc twice to backtrack to an earlier turn",
  "tips.7": "Shift+Tab cycles approval modes (confirm / auto / plan)",
  "tips.8": "Ctrl+R searches your prompt history",
  "tips.9": "/vim enables vim keybindings in the composer",
  "tips.10": "Drop markdown files in .seekforge/commands/ to add custom commands",
  "tips.11": "Ctrl+V pastes an image from the clipboard",

  // ── Slash commands (palette + /help) ──────────────────────────────────
  "cmd.help": "show all commands",
  "cmd.new": "start a fresh session (next message opens it)",
  "cmd.clear": "clear the transcript (name labels the old session)",
  "cmd.sessions": "pick a session to resume (interactive)",
  "cmd.resume": "continue an existing session",
  "cmd.plan": "plan read-only first, confirm, then execute",
  "cmd.loop": "auto-loop: run→verify until the command passes (task = composer lines below)",
  "cmd.loop-resume": "resume a persisted loop with optional added limits",
  "cmd.loop-list": "list persisted loops in this workspace",
  "cmd.loop-show": "show one persisted loop",
  "cmd.loop-history": "show recent loop lifecycle events",
  "cmd.loop-recover": "mark orphaned loops resumable",
  "cmd.loop-pause": "pause the active loop at its next safe boundary",
  "cmd.loop-continue": "continue the paused loop in this tab",
  "cmd.loop-steer": "guide the active loop at its next safe boundary",
  "cmd.approve": "show or set the approval mode (Shift+Tab cycles)",
  "cmd.rewind": "undo this session's file changes (dry-run first)",
  "cmd.backtrack": "rewind the conversation to an earlier message (Esc Esc)",
  "cmd.fork": "fork the current session (continue without touching the original)",
  "cmd.tab": "tabs: parallel sessions (Ctrl+N new, Ctrl+T cycle)",
  "cmd.worktree": "git worktree sessions: isolated checkouts under .seekforge/worktrees",
  "cmd.diff": "git diff of the working tree",
  "cmd.review": "review the uncommitted changes (read-only)",
  "cmd.todo": "cross-session todo list (.seekforge/todos.md)",
  "cmd.add-dir": "add a read-only directory for @ references",
  "cmd.model": "switch model for subsequent messages",
  "cmd.think": "V4 thinking mode and reasoning effort",
  "cmd.remember": "save a fact to project memory (# <fact> also works)",
  "cmd.memory":
    "list project memory facts (candidates reviews pending; keywords backfills bilingual search terms; edit opens a memory file)",
  "cmd.tasks": "background and detached tasks (live; kill stops one)",
  "cmd.agents": "list dispatchable subagents",
  "cmd.agent-steer": "guide a running subagent at its next turn",
  "cmd.agent-cancel": "cancel one running subagent",
  "cmd.skills": "list installed skills and their status",
  "cmd.plugins": "list first-class plugins and approval status",
  "cmd.mcp": "list configured MCP servers and their tools",
  "cmd.prompts": "list MCP prompts (invoke as /mcp:<server>:<prompt>)",
  "cmd.init": "analyze the codebase and write/refresh AGENTS.md",
  "cmd.doctor": "diagnose the environment (key, node, git, runtime, mcp…)",
  "cmd.vim": "toggle vim mode for the composer",
  "cmd.mouse": "toggle mouse-wheel scroll (off = native text selection)",
  "cmd.theme": "switch the color theme (deepseek/mono/solarized/matrix…)",
  "cmd.terminal-setup": "how to make Shift+Enter insert a newline in your terminal",
  "cmd.context": "open the context inspector",
  "cmd.compact": "compact the session now (focus steers the LLM summary)",
  "cmd.usage": "cumulative token usage and cost",
  "cmd.balance": "DeepSeek account balance",
  "cmd.export": "export the transcript as markdown",
  "cmd.audit": "write a reviewable audit of a session (timeline, tool calls, files, cost)",
  "cmd.handoff": "write a session handoff document for the next session",
  "cmd.stash": "stash / restore the composer draft",
  "cmd.copy": "copy the last assistant message to the clipboard",
  "cmd.editor": "edit the prompt in $EDITOR (Ctrl+G)",
  "cmd.quit": "exit (Ctrl+C twice also works)",
  "group.session": "Session",
  "group.run": "Running tasks",
  "group.review": "Review & history",
  "group.context": "Context & memory",
  "group.tools": "Tools & surfaces",
  "group.settings": "Settings",
  "group.info": "Info",
};

const ZH_CN: Record<string, string> = {
  "hints.idle": "⏎ 发送 · / 命令 · @ 文件 · Ctrl+R 历史",
  "hints.running": "Esc 中断 · Ctrl+B 转后台 · ⏎ 排队",
  "hints.permission": "y 允许 · a 本会话允许 · A 始终允许 · n 拒绝",

  "status.ready": "就绪",
  "status.working": "处理中…",
  "status.interrupt": "esc 中断",
  "status.scrolled": "↑ 已滚动",

  "tip.prefix": "※",

  "picker.palette": "↑↓ 选择 · Tab/Enter 补全 · Esc 关闭",
  "picker.list": "↑↓ 选择 · Enter 确认 · Esc 关闭",
  "picker.resume": "↑↓ 选择 · Enter 恢复 · f 分叉 · Esc 关闭",
  "picker.rewind": "↑↓ 选择 · Enter 回退对话+文件 · c 仅对话 · Esc 关闭",
  "picker.model": "↑↓ 选择 · Enter 切换 · Esc 关闭",
  "picker.history": "↑↓ 选择 · Tab 填入 · Enter 执行 · Esc 关闭",
  "picker.slash": "↑↓ 选择 · Enter 插入 · Esc 关闭 — @ 文件 · # 记忆 · ! shell · Shift+Tab 审批",
  "picker.theme": "↑↓ 选择 · Enter 应用 · Esc 关闭",
  "picker.candidates": "↑↓ 选择 · a 批准 · r 拒绝 · s 范围 · Esc 关闭",
  "picker.emptyCommands": "无匹配命令",
  "picker.emptyFiles": "无匹配文件",
  "picker.emptyList": "暂无内容",
  "picker.titleSessions": "会话",
  "picker.titleBacktrack": "回退 — 将对话回退到…",
  "picker.titleModel": "模型",
  "picker.titleTheme": "主题",
  "picker.titleCommands": "命令",
  "picker.titleCandidates": "记忆候选 — 审阅待定事实",

  "question.title": "来自代理的提问",
  "question.footerPrefix": "↑↓ 或 1-",
  "question.footerSuffix": " 选择 · Enter 回答 · Esc 拒绝",
  "question.footerFreeText": "直接输入答案 · ↑↓ 选择 · 回车提交 · esc 拒绝",

  "sidebar.title": "文件",
  "sidebar.empty": "（空）",
  "sidebar.footer": "↑↓ · Enter 插入 @path · ←→ 折叠 · Ctrl+E 关闭",

  "pager.title": "记录",
  "pager.hint": "(q/Esc 关闭 · ↑↓/PgUp/PgDn/g/G 滚动)",
  "pager.empty": "（记录为空）",

  "permission.title": "需要授权",
  "permission.command": "命令:",
  "permission.path": "路径:",
  "permission.allowOnce": "y 允许一次",
  "permission.allowSession": "a 本会话允许同类命令",
  "permission.allowAlways": "A 始终允许，将写入规则",
  "permission.saved": "已保存授权规则:",
  "permission.saveFailed": "授权规则保存失败（本次会话仍然允许）:",
  "permission.deny": "其他键拒绝",
  "permission.reviewChange": "审查变更:",
  "permission.applyChange": "应用此变更? y 接受 · n 拒绝",
  "permission.hunk": "代码块",
  "permission.hunkFooter": "数字键切换代码块 · a 全选 · y 确认 · n 拒绝",

  "mode.autoApprove": "⏵⏵ 自动批准已开启",
  "mode.acceptEdits": "⏵ 自动接受编辑已开启",
  "mode.plan": "⏸ 计划模式已开启",
  "mode.cycleHint": "(shift+tab 切换)",

  "composer.idle": "让 SeekForge 做点什么…  (/ 命令 · @ 文件 · # 记忆 · ! shell)",
  "composer.running": "处理中… 输入可排队后续消息 · Esc 取消 · ! 运行 shell",
  "composer.permissionWait": "请回答上方的授权提示（y · a · 其他键拒绝）",

  "tips.0": "输入 @ 将文件附加到消息",
  "tips.1": "按 / 打开命令面板",
  "tips.2": "以 # 开头的行会存入项目记忆",
  "tips.3": "以 ! 开头的行直接运行 shell 命令",
  "tips.4": "Ctrl+B 将当前运行转入后台",
  "tips.5": "Ctrl+O 切换详细输出（完整 diff 与工具结果）",
  "tips.6": "连按两次 Esc 回退到更早的轮次",
  "tips.7": "Shift+Tab 循环切换审批模式（确认 / 自动 / 计划）",
  "tips.8": "Ctrl+R 搜索提示历史",
  "tips.9": "/vim 在输入框启用 vim 键位",
  "tips.10": "在 .seekforge/commands/ 放置 markdown 文件可添加自定义命令",
  "tips.11": "Ctrl+V 从剪贴板粘贴图片",

  // ── Slash commands (palette + /help) ──────────────────────────────────
  "cmd.help": "显示全部命令",
  "cmd.new": "开始新会话（下一条消息将开启它）",
  "cmd.clear": "清空对话记录（name 用于标记旧会话）",
  "cmd.sessions": "选择一个会话恢复（交互式）",
  "cmd.resume": "继续一个已有会话",
  "cmd.plan": "先只读地规划，确认后再执行",
  "cmd.loop": "自动循环：run→verify 直到命令通过（任务写在下方输入框）",
  "cmd.loop-resume": "恢复一个已持久化的 loop，可追加限制",
  "cmd.loop-list": "列出本工作区已持久化的 loop",
  "cmd.loop-show": "查看某个已持久化的 loop",
  "cmd.loop-history": "查看最近的 loop 生命周期事件",
  "cmd.loop-recover": "把孤立的 loop 标记为可恢复",
  "cmd.loop-pause": "在下一个安全边界暂停当前 loop",
  "cmd.loop-continue": "在本标签页继续已暂停的 loop",
  "cmd.loop-steer": "在下一个安全边界引导当前 loop",
  "cmd.approve": "查看或设置审批模式（Shift+Tab 循环切换）",
  "cmd.rewind": "撤销本会话的文件改动（先 dry-run）",
  "cmd.backtrack": "把对话回退到更早的一条消息（Esc Esc）",
  "cmd.fork": "复刻当前会话（继续推进而不影响原会话）",
  "cmd.tab": "标签页：并行会话（Ctrl+N 新建，Ctrl+T 切换）",
  "cmd.worktree": "git worktree 会话：位于 .seekforge/worktrees 的隔离检出",
  "cmd.diff": "工作树的 git diff",
  "cmd.review": "审查未提交的改动（只读）",
  "cmd.todo": "跨会话待办清单（.seekforge/todos.md）",
  "cmd.add-dir": "添加一个只读目录供 @ 引用",
  "cmd.model": "为后续消息切换模型",
  "cmd.think": "V4 思考模式与推理强度",
  "cmd.remember": "把一条事实存入项目记忆（用 # <事实> 也可以）",
  "cmd.memory": "列出项目记忆事实（candidates 审阅待定项；keywords 补齐双语检索词；edit 打开记忆文件）",
  "cmd.tasks": "后台与分离任务（实时；kill 可终止其一）",
  "cmd.agents": "列出可调度的子智能体",
  "cmd.agent-steer": "在下一轮引导某个运行中的子智能体",
  "cmd.agent-cancel": "取消某个运行中的子智能体",
  "cmd.skills": "列出已安装的技能及其状态",
  "cmd.plugins": "列出一等公民插件及批准状态",
  "cmd.mcp": "列出已配置的 MCP 服务器及其工具",
  "cmd.prompts": "列出 MCP 提示词（以 /mcp:<server>:<prompt> 调用）",
  "cmd.init": "分析代码库并写入/刷新 AGENTS.md",
  "cmd.doctor": "诊断运行环境（key、node、git、runtime、mcp…）",
  "cmd.vim": "切换输入框的 vim 模式",
  "cmd.mouse": "切换鼠标滚轮滚动（关闭后可用原生文本选择）",
  "cmd.theme": "切换配色主题（deepseek/mono/solarized/matrix…）",
  "cmd.terminal-setup": "如何让 Shift+Enter 在你的终端里插入换行",
  "cmd.context": "打开上下文检查器",
  "cmd.compact": "立即压缩会话（focus 可引导 LLM 摘要）",
  "cmd.usage": "累计 token 用量与花费",
  "cmd.balance": "DeepSeek 账户余额",
  "cmd.export": "把对话记录导出为 markdown",
  "cmd.audit": "为某个会话写出可审阅的审计报告（时间线、工具调用、文件、花费）",
  "cmd.handoff": "为下一个会话写一份交接文档",
  "cmd.stash": "暂存 / 恢复输入框草稿",
  "cmd.copy": "复制最后一条助手消息到剪贴板",
  "cmd.editor": "在 $EDITOR 中编辑提示词（Ctrl+G）",
  "cmd.quit": "退出（连按两次 Ctrl+C 也可以）",
  "group.session": "会话",
  "group.run": "运行任务",
  "group.review": "审查与历史",
  "group.context": "上下文与记忆",
  "group.tools": "工具与界面",
  "group.settings": "设置",
  "group.info": "信息",
};

/** All UI strings, keyed by locale then string key. en is canonical. */
export const STRINGS: Record<Locale, Record<string, string>> = {
  en: EN,
  "zh-CN": ZH_CN,
};

let currentLocale: Locale = "en";

/**
 * Detect the UI locale from the environment. Precedence:
 * SEEKFORGE_LANG (explicit override) > LC_ALL > LANG; any value whose
 * lowercase form starts with "zh" selects zh-CN, everything else is en.
 */
export function detectLocale(env: Record<string, string | undefined> = process.env): Locale {
  const explicit = env.SEEKFORGE_LANG;
  if (explicit) return explicit.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  for (const value of [env.LC_ALL, env.LANG]) {
    if (value?.toLowerCase().startsWith("zh")) return "zh-CN";
  }
  return "en";
}

/** Set the active locale (called once at startup; takes effect immediately). */
export function setLocale(l: Locale): void {
  currentLocale = l;
}

/** The currently active locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/**
 * Translate `key` for the active locale. Falls back to English, then to the
 * key itself — never throws, so a missing translation degrades gracefully.
 */
export function t(key: string): string {
  return STRINGS[currentLocale][key] ?? STRINGS.en[key] ?? key;
}

/**
 * Translate `key`, falling back to a caller-supplied string rather than to the
 * key itself. For text that already exists in English at its definition site —
 * the slash-command registry, whose summaries are part of how that module
 * reads — so the English does not have to be written twice to stay authoritative.
 */
export function translate(key: string, fallback: string): string {
  return STRINGS[currentLocale][key] ?? fallback;
}
