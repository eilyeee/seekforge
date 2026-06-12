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
  "hints.permission": "y allow · a allow session · n deny",

  // ── Status bar ─────────────────────────────────────────────────────────
  "status.ready": "ready",
  "status.working": "working…",
  "status.interrupt": "esc to interrupt",
  "status.scrolled": "↑ scrolled",

  // ── Header ──────────────────────────────────────────────────────────────
  "header.tagline": "a local-first coding agent powered by DeepSeek",
  "tip.prefix": "※",

  // ── Picker / palette footers ────────────────────────────────────────────
  "picker.palette": "↑↓ select · Tab/Enter complete · Esc dismiss",
  "picker.list": "↑↓ select · Enter accept · Esc dismiss",
  "picker.resume": "↑↓ select · Enter resume · f fork · Esc dismiss",
  "picker.rewind": "↑↓ select · Enter rewind conversation+files · c conversation only · Esc dismiss",
  "picker.model": "↑↓ select · Enter switch · Esc dismiss",
  "picker.history": "↑↓ select · Tab fill · Enter run · Esc dismiss",
  "picker.slash":
    "↑↓ select · Enter insert · Esc close — @ files · # remember · ! shell · Shift+Tab approval",
  "picker.theme": "↑↓ select · Enter apply · Esc dismiss",

  // ── Permission panel ────────────────────────────────────────────────────
  "permission.title": "Permission required",
  "permission.command": "command:",
  "permission.path": "path:",
  "permission.allowOnce": "y allow once",
  "permission.allowSession": "a allow similar commands this session",
  "permission.deny": "any other key deny",

  // ── Mode line under the composer ────────────────────────────────────────
  "mode.autoApprove": "⏵⏵ auto-approve on",
  "mode.plan": "⏸ plan mode on",
  "mode.cycleHint": "(shift+tab to cycle)",
  "mode.runningShell": "running:",
  "mode.bgTask": "background task",
  "mode.bgTasks": "background tasks",
  "mode.detachedRun": "detached run",
  "mode.detachedRuns": "detached runs",
  "mode.queued": "queued",
  "session.label": "session",

  // ── Composer placeholders (app-level; integrator adopts) ───────────────
  "composer.idle": "Ask SeekForge to do something…  (/ commands · @ files · # remember · ! shell)",
  "composer.running": "working… type to queue a follow-up · Esc cancels · ! runs shell",

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
};

const ZH_CN: Record<string, string> = {
  "hints.idle": "⏎ 发送 · / 命令 · @ 文件 · Ctrl+R 历史",
  "hints.running": "Esc 中断 · Ctrl+B 转后台 · ⏎ 排队",
  "hints.permission": "y 允许 · a 本会话允许 · n 拒绝",

  "status.ready": "就绪",
  "status.working": "处理中…",
  "status.interrupt": "esc 中断",
  "status.scrolled": "↑ 已滚动",

  "header.tagline": "本地优先的 DeepSeek 编码代理",
  "tip.prefix": "※",

  "picker.palette": "↑↓ 选择 · Tab/Enter 补全 · Esc 关闭",
  "picker.list": "↑↓ 选择 · Enter 确认 · Esc 关闭",
  "picker.resume": "↑↓ 选择 · Enter 恢复 · f 分叉 · Esc 关闭",
  "picker.rewind": "↑↓ 选择 · Enter 回退对话+文件 · c 仅对话 · Esc 关闭",
  "picker.model": "↑↓ 选择 · Enter 切换 · Esc 关闭",
  "picker.history": "↑↓ 选择 · Tab 填入 · Enter 执行 · Esc 关闭",
  "picker.slash": "↑↓ 选择 · Enter 插入 · Esc 关闭 — @ 文件 · # 记忆 · ! shell · Shift+Tab 审批",
  "picker.theme": "↑↓ 选择 · Enter 应用 · Esc 关闭",

  "permission.title": "需要授权",
  "permission.command": "命令:",
  "permission.path": "路径:",
  "permission.allowOnce": "y 允许一次",
  "permission.allowSession": "a 本会话允许同类命令",
  "permission.deny": "其他键拒绝",

  "mode.autoApprove": "⏵⏵ 自动批准已开启",
  "mode.plan": "⏸ 计划模式已开启",
  "mode.cycleHint": "(shift+tab 切换)",
  "mode.runningShell": "运行中:",
  "mode.bgTask": "个后台任务",
  "mode.bgTasks": "个后台任务",
  "mode.detachedRun": "个分离运行",
  "mode.detachedRuns": "个分离运行",
  "mode.queued": "已排队",
  "session.label": "会话",

  "composer.idle": "让 SeekForge 做点什么…  (/ 命令 · @ 文件 · # 记忆 · ! shell)",
  "composer.running": "处理中… 输入可排队后续消息 · Esc 取消 · ! 运行 shell",

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
    if (value && value.toLowerCase().startsWith("zh")) return "zh-CN";
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
