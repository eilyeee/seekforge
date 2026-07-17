# 定时任务

> [English](scheduling.md) | **简体中文**

SeekForge 可以按计划运行任务——每晚一次代码审查、定期的依赖检查、一份“总结今天有哪些变化”的日报。调度是**本地优先**的：没有云端、没有守护进程、没有任何外部服务。你在项目内注册任务，然后用 `seekforge schedule install` 安装一个幂等的、按项目划分的 crontab 定时触发，或者手动接入 `seekforge schedule run`。

每次定时运行都是一个**普通的、可审计的会话**——它写入与交互式运行完全相同的 JSONL 追踪记录，因此会出现在 `seekforge sessions` 里，可以用 `seekforge replay <id>` 回放、用 `seekforge audit <id>` 审阅、用 `seekforge rewind <id>` 撤销。

## 安全为先

定时任务让 agent **自主运行**，无人盯守。两道护栏保证其安全：

1. **成本预算是强制的。** 每个任务都必须提供 `--max-cost <usd>`。一旦累计花费达到预算，运行就会平缓终止（追踪记录会保留）。没有预算的任务在注册时即被拒绝——不存在调度一次无上限运行的途径。
2. **每次触发都是无头（headless）运行。** `schedule run` 用与 `seekforge -p` 相同的引擎跑每个任务，但处于机器（非交互）模式，因此 agent 的审批回调会**自动拒绝**一切原本需要弹出提示的操作：危险命令保持被拒，`execute` / 环境类操作一律拒绝（没有 TTY 可供批准，而定时运行绝不能挂起等待输入）。`edit` 类任务运行在 *acceptEdits* 模式下，普通文件编辑可以自主进行；风险更高的一切仍被拒绝。

注册任务的同时也会为当前工作区授权后续触发（与你交互时给出的目录访问许可是同一种许可），因此无头运行不会被目录门禁拦住。

## 任务格式

任务存放在 `.seekforge/schedules.json` 中（项目级作用域，提交入库或加入 gitignore 均可，随你偏好）。每个任务形如：

```jsonc
{
  "jobs": [
    {
      "id": "nightly-review",        // stable id, unique within the project
      "task": "Review today's git diff and flag risky changes.",
      "schedule": "0 3 * * *",        // interval ("30m"/"2h"/"1d") OR a 5-field cron string
      "mode": "ask",                  // "ask" (read-only) | "edit" (may modify files)
      "maxCostUsd": 0.50,             // REQUIRED per-run budget (USD); must be > 0
      "enabled": true,
      "lastRunAt": "2026-07-02T03:00:00.000Z"  // set by `schedule run`; absent until first run
    }
  ]
}
```

- **`schedule`** 可以是简单间隔，也可以是 cron 表达式：
  - 间隔：`<n><unit>`，单位为 `s`、`m`、`h`、`d` 或 `w`——如 `30m`、`2h`、`1d`、`1w`。间隔类任务在从未运行过、或距 `lastRunAt` 已过去至少一个间隔时到期。
  - Cron：标准 5 字段表达式 `minute hour day-of-month month day-of-week`，支持 `*`、列表（`1,15`）、区间（`1-5`）和步长（`*/15`）。当 day-of-month 和 day-of-week 同时受限时，*任一*匹配即触发（标准 cron 语义）。一个 cron 任务在每个匹配的分钟内至多触发一次。
- **`mode`**——`ask` 用于只读问答 / 报告类任务；`edit` 用于可能改动文件的任务（编辑自动批准；命令 / 危险操作仍被拒绝）。
- **`maxCostUsd`**——必填；运行达到该值即停止。

## 命令

```bash
# Register a job (interval)
seekforge schedule add --task "Summarize today's changes" --every 1d --max-cost 0.50

# Register a job (cron: weekdays at 09:00), allowed to edit files
seekforge schedule add \
  --task "Fix any failing tests and open a summary" \
  --cron "0 9 * * 1-5" --mode edit --max-cost 1.00 --id weekday-fix

# List jobs (id, schedule, mode, budget, enabled, last run)
seekforge schedule list

# Enable / disable a job (kept in the registry, skipped by `run` while disabled)
seekforge schedule disable weekday-fix
seekforge schedule enable  weekday-fix

# Remove a job
seekforge schedule remove weekday-fix

# THE TICK: run every DUE job now (this is what your OS scheduler invokes)
seekforge schedule run

# Force-run one specific job now, regardless of its due time
seekforge schedule run --id weekday-fix

# Inspect without running; show next ticks and append-only history
seekforge schedule run --dry-run --json
seekforge schedule next
seekforge schedule history --id weekday-fix --json

# Manage the once-per-minute project crontab block
seekforge schedule install --dry-run
seekforge schedule install
seekforge schedule status --json
seekforge schedule uninstall
```

`schedule add` 的 flag：`--task`（必填），`--every <interval>` / `--cron "<expr>"` 二选一，`--max-cost <usd>`（必填），`--mode ask|edit`（默认 `ask`），以及 `--id <name>`（默认从任务描述派生）。

每次尝试都会连同其 `runId`、attempt、status、session、cost、error 追加到 `.seekforge/runs.jsonl`。失败会按指数退避重试，间隔从一分钟到一小时不等；成功会清零失败计数。list/run/next/history/install/uninstall/status 均支持 `--json`。

## 接入操作系统的调度器

SeekForge **不会**变成守护进程。多久 *tick* 一次——也就是多久调用一次 `seekforge schedule run`——由你决定。每次 tick 只有按其自身 `schedule` 已到期的任务才会真正运行，所以每分钟 tick 一次也没问题；设为 `1d` 的任务仍然大约一天跑一次。

### cron（Linux / macOS）

每 5 分钟 tick 一次，从项目目录执行。`schedule run` 必须以项目目录作为工作目录运行，才能找到 `.seekforge/schedules.json`：

```cron
# m h dom mon dow  command
*/5 * * * * cd /path/to/your/project && /usr/local/bin/seekforge schedule run >> .seekforge/schedule.log 2>&1
```

（在 crontab 或被 source 的 profile 中设置 `DEEPSEEK_API_KEY`，agent 才能完成鉴权。）

### launchd（macOS）

创建 `~/Library/LaunchAgents/com.you.seekforge-schedule.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.seekforge-schedule</string>
  <key>WorkingDirectory</key><string>/path/to/your/project</string>
  <key>EnvironmentVariables</key>
  <dict><key>DEEPSEEK_API_KEY</key><string>sk-…</string></dict>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/seekforge</string>
    <string>schedule</string>
    <string>run</string>
  </array>
  <key>StartInterval</key><integer>300</integer> <!-- tick every 5 minutes -->
</dict>
</plist>
```

然后执行 `launchctl load ~/Library/LaunchAgents/com.you.seekforge-schedule.plist`。

### systemd timer（Linux）

`seekforge-schedule.service`：

```ini
[Service]
Type=oneshot
WorkingDirectory=/path/to/your/project
Environment=DEEPSEEK_API_KEY=sk-…
ExecStart=/usr/local/bin/seekforge schedule run
```

`seekforge-schedule.timer`：

```ini
[Timer]
OnCalendar=*:0/5   # every 5 minutes
Persistent=true

[Install]
WantedBy=timers.target
```

然后执行 `systemctl --user enable --now seekforge-schedule.timer`。

## 审阅定时运行

由于每次 tick 都会产生一个普通会话，直接用常规工具即可：

```bash
seekforge sessions            # scheduled runs appear here like any other
seekforge audit <session-id>  # reviewable report of exactly what the agent did
seekforge rewind <session-id> # undo a scheduled edit run's file changes
```
