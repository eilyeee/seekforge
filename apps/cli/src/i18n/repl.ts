/** Strings for the interactive REPL (apps/cli/src/commands/repl.ts): the
 * /help block, prompts, status lines. Keys "repl."-prefixed. en is canonical. */
export const repl = {
  en: {
    // ── help block ──────────────────────────────────────────────────────
    "repl.help": [
      "Slash commands:",
      "  /help              show this help",
      "  /new               start a fresh session (next message opens it)",
      "  /sessions          list sessions of this project",
      "  /resume <id>       continue an existing session",
      "  /plan <task>       plan read-only first, confirm, then execute",
      "  /model <name>      switch model (e.g. deepseek-v4-flash, deepseek-v4-pro)",
      "  /think [on|off|high|max]  V4 thinking mode and reasoning effort",
      "  /remember <fact>   save a fact to project memory (project.md)",
      "  /usage             cumulative token usage and cost for this REPL",
      "  /clear             clear the terminal screen",
      "  /diff              show current git diff",
      "  /status            project/config/session overview",
      "  /compact [focus]   compact the current session (mechanical digest)",
      "  /context           context-window occupancy of the last turn",
      "  /quit              exit (Ctrl+D also works)",
      "Anything else is sent to the agent. @path tokens inline file contents.",
    ].join("\n"),

    // ── prompt / welcome ────────────────────────────────────────────────
    "repl.prompt": "seekforge \u276f ",
    "repl.welcome": "SeekForge \u2014 interactive session  ({model}, {path})",
    "repl.welcomeHint":
      "Type a task, or /help for commands. Ctrl+C cancels a running task.",
    "repl.screenCleared": "screen cleared",

    // ── slash command responses ─────────────────────────────────────────
    "repl.noActiveSession": "no active session to compact \u2014 run a task first",
    "repl.sessionTooShort": "session is too short to compact or has no messages file",
    "repl.compacted":
      "compacted: dropped {dropped} turn(s), {before} \u2192 {after} tokens",
    "repl.nextMessageFresh": "next message starts a fresh session",
    "repl.resumeUsage": "usage: /resume <session-id> (see /sessions)",
    "repl.continuingSession": "continuing session {id} \u2014 your next message resumes it",
    "repl.planUsage": "usage: /plan <task>",
    "repl.planKept": "plan kept; the session continues \u2014 refine it or /new",
    "repl.modelUsage": "usage: /think [on|off|high|max]",
    "repl.reasonerBlocked":
      "deepseek-reasoner has no tool calling and cannot drive the agent yet",
    "repl.modelCurrent": "model: {model} (try deepseek-v4-flash, deepseek-v4-pro)",
    "repl.modelSet": "model: {model}",
    "repl.thinkingCurrent":
      "thinking: {state}{effortSuffix} (V4 models only \u2014 /think on|off|high|max)",
    "repl.thinkingSet":
      "thinking {state}{effortSuffix} \u2014 applies from the next message{modelSuffix}",
    "repl.rememberUsage": "usage: /remember <fact>",
    "repl.remembered": "remembered \u2192 project.md: {content}",
    "repl.contextNone": "context: no turn run yet this REPL",
    "repl.contextInfo": "context: {used} of {budget} budget tokens used ({percent}%)",
    "repl.contextAutoCompaction":
      "When usage exceeds the budget, older turns are compacted into a short digest automatically.",
    "repl.executeQuestion": "\nExecute this plan? [y/N] ",
    "repl.error": "error: {message}",

    // ── permission prompt ──────────────────────────────────────────────
    "repl.permissionRequired": "Permission required",
    "repl.allowPrompt": "Allow? [y/N] ",
    "repl.question": "Question",
    "repl.answerPrompt": "answer [1-{max}]: ",
    "repl.userDeclined": "(the user declined to answer)",
  },
  zh: {
    // ── help block ──────────────────────────────────────────────────────
    "repl.help": [
      "斜杠命令：",
      "  /help              显示此帮助",
      "  /new               开始一个新会话（下一条消息将打开它）",
      "  /sessions          列出此项目的所有会话",
      "  /resume <id>       继续一个已有会话",
      "  /plan <task>       先以只读模式规划，确认后执行",
      "  /model <name>      切换模型（例如 deepseek-v4-flash, deepseek-v4-pro）",
      "  /think [on|off|high|max]  V4 思考模式和推理力度",
      "  /remember <fact>   将事实保存到项目记忆（project.md）",
      "  /usage             累计 Token 使用量和费用",
      "  /clear             清空终端屏幕",
      "  /diff              显示当前 git 差异",
      "  /status            项目/配置/会话概览",
      "  /compact [focus]   压缩当前会话（机械摘要）",
      "  /context           最后一轮的上下文窗口占用",
      "  /quit              退出（Ctrl+D 也可以）",
      "其他输入将发送给代理。@path 令牌内联文件内容。",
    ].join("\n"),

    // ── prompt / welcome ────────────────────────────────────────────────
    "repl.prompt": "seekforge ❯ ",
    "repl.welcome": "SeekForge — 交互式会话  ({model}, {path})",
    "repl.welcomeHint":
      "输入任务，或输入 /help 查看命令。Ctrl+C 取消正在运行的任务。",
    "repl.screenCleared": "屏幕已清空",

    // ── slash command responses ─────────────────────────────────────────
    "repl.noActiveSession": "无活动会话可压缩 — 请先运行一个任务",
    "repl.sessionTooShort": "会话太短或没有消息文件，无法压缩",
    "repl.compacted":
      "已压缩：丢弃 {dropped} 轮，{before} → {after} Token",
    "repl.nextMessageFresh": "下一条消息将开始一个新的会话",
    "repl.resumeUsage": "用法：/resume <session-id>（参见 /sessions）",
    "repl.continuingSession": "正在继续会话 {id} — 您的下一条消息将恢复它",
    "repl.planUsage": "用法：/plan <task>",
    "repl.planKept": "计划已保留；会话继续 — 完善它或输入 /new",
    "repl.modelUsage": "用法：/think [on|off|high|max]",
    "repl.reasonerBlocked":
      "deepseek-reasoner 不支持工具调用，暂无法驱动代理",
    "repl.modelCurrent": "模型：{model}（试试 deepseek-v4-flash, deepseek-v4-pro）",
    "repl.modelSet": "模型：{model}",
    "repl.thinkingCurrent":
      "思考模式：{state}{effortSuffix}（仅 V4 模型 — /think on|off|high|max）",
    "repl.thinkingSet":
      "思考模式 {state}{effortSuffix} — 从下一条消息生效{modelSuffix}",
    "repl.rememberUsage": "用法：/remember <fact>",
    "repl.remembered": "已记住 → project.md：{content}",
    "repl.contextNone": "上下文：此 REPL 尚未运行任何轮次",
    "repl.contextInfo": "上下文：已使用 {used}}/{budget} 预算 Token（{percent}%）",
    "repl.contextAutoCompaction":
      "当使用量超过预算时，较旧的轮次将自动压缩为简短摘要。",
    "repl.executeQuestion": "\n是否执行此计划？[y/N] ",
    "repl.error": "错误：{message}",

    // ── permission prompt ──────────────────────────────────────────────
    "repl.permissionRequired": "需要权限",
    "repl.allowPrompt": "是否允许？[y/N] ",
    "repl.question": "问题",
    "repl.answerPrompt": "回答 [1-{max}]：",
    "repl.userDeclined": "（用户拒绝回答）",
  },
};
