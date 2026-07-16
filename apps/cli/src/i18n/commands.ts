/** Strings for command outputs (models, status, sessions, doctor, memory, …).
 * Keys "cmd.<command>."-prefixed. en is canonical. */
export const commands = {
  en: {
    // ── cmd.models.* ────────────────────────────────────────────────────
    "cmd.models.header": "Models available from DeepSeek:\n",
    "cmd.models.deprecated": "(deprecated)",
    "cmd.models.default": "(default)",
    "cmd.models.footer":
      "Prices shown are in USD per 1 million tokens. Cache-hit pricing applies when the input prompt prefix is cached.",

    // ── cmd.sessions.* ──────────────────────────────────────────────────
    "cmd.sessions.none": 'No sessions yet. Run `seekforge run "<task>"` to start one.',
    "cmd.sessions.output": "{id}  [{status}]{cost}  {task}",
    "cmd.sessions.pruneSpecify": "Specify --older-than <days> and/or --keep-last <n> (use --dry-run to preview).",
    "cmd.sessions.pruneNumbers": "--older-than and --keep-last must be numbers.",
    "cmd.sessions.pruneNone": "Nothing to prune.",
    "cmd.sessions.pruneResult": "{verb} {removed} session(s); {kept} kept.",
    "cmd.sessions.pruneWouldRemove": "would remove",
    "cmd.sessions.pruneRemoved": "removed",

    // ── cmd.status.* ────────────────────────────────────────────────────
    "cmd.status.project": "project:   {path}",
    "cmd.status.config": "config:    {path}",
    "cmd.status.configInitialized": ".seekforge/ present",
    "cmd.status.configNotInit": "not initialized (run seekforge init)",
    "cmd.status.apiKey": "api key:   {key}",
    "cmd.status.apiKeyMasked": "MISSING",
    "cmd.status.model": "model:     {model}",
    "cmd.status.modelDefault": "deepseek-v4-flash (default)",
    "cmd.status.global": "global:    {path}",
    "cmd.status.sessions": "sessions:  {count}",
    "cmd.status.last": "last:      {id} [{status}] {task}",

    // ── cmd.doctor.* ────────────────────────────────────────────────────
    "cmd.doctor.checksHeader": "{passed}/{total} checks passed",
    "cmd.doctor.fixHint": "\u2192 fix: {hint}",
    "cmd.doctor.checkConfigured": "configured",
    "cmd.doctor.checkMissing": "missing",
    "cmd.doctor.checkPresent": ".git present",
    "cmd.doctor.checkNoGitRepo": "not a git repository \u2014 checkpoints and `diff` are limited",
    "cmd.doctor.checkProjectConfig": ".seekforge/config.json",
    "cmd.doctor.checkUsingDefaults": "using global defaults",
    "cmd.doctor.checkRuntimeNotFound": "{path} not found",
    "cmd.doctor.checkRuntimeNotConfigured": "not configured (TS fallback)",
    "cmd.doctor.checkMcpCount": "{count} configured",
    "cmd.doctor.checkNoSessions": "no sessions yet",
    "cmd.doctor.checkSessionCount": "{count} recorded",
    "cmd.doctor.checkEditorUnset": "$EDITOR/$VISUAL unset \u2014 external edit unavailable",
    "cmd.doctor.checkNoClipboard": "no clipboard tool found (pbcopy/wl-copy/xclip)",

    // ── cmd.memory.* ────────────────────────────────────────────────────
    "cmd.memory.factsHeader": "Project facts (remove with `seekforge memory remove <n>`):",
    "cmd.memory.noFacts": "project.md: (no facts)",
    "cmd.memory.factLine": "  {index}. {line}",
    "cmd.memory.pendingHeader": "Pending candidates (approve with `seekforge memory approve <id>`):",
    "cmd.memory.noPending": "No pending memory candidates.",
    "cmd.memory.pendingCandidate": "  {id}  [{type}] ({confidence})  {content}",
    "cmd.memory.addedQueued":
      "queued pending candidate {id}: [{type}] {content}\napprove with `seekforge memory approve {id}`",
    "cmd.memory.addedTo": "added to {path}:",
    "cmd.memory.addedUser": "added to user memory (~/.seekforge): [{type}] {content}",
    "cmd.memory.addedFact": "  - [{type}] {content}",
    "cmd.memory.auditCandidate": "audit candidate: {id}",
    "cmd.memory.removedFact": "removed fact {selector}: {content}",
    "cmd.memory.deletedCandidate": "deleted candidate {id}: {content}",
    "cmd.memory.approved": "approved \u2192 project.md: {content}",
    "cmd.memory.rejected": "rejected {id}",
    "cmd.memory.compacted": "{verb} project.md: {before} \u2192 {after} facts",
    "cmd.memory.wouldCompact": "would compact",
    "cmd.memory.compactedLabel": "compacted",
    "cmd.memory.duplicatesHeader": "Exact duplicates removed ({count}):",
    "cmd.memory.mergedHeader": "Near-duplicates merged ({count}):",
    "cmd.memory.archivedHeader": "Unused facts archived ({count}):",
    "cmd.memory.mergedKeep": "  keep: {line}",
    "cmd.memory.mergedDrop": "  drop: {line}",
    "cmd.memory.nothingToCompact": "Nothing to compact.",
    "cmd.memory.dryRunNote": "(dry run \u2014 project.md unchanged)",
    "cmd.memory.statsHeader": "Memory extraction stats:",
    "cmd.memory.statsApproved": "  approved facts: {total} ({auto} auto-extracted, {direct} direct-added)",
    "cmd.memory.statsUsed": "  used fraction (precision proxy): {percent}%",
    "cmd.memory.statsRejection": "  candidate rejection rate: {percent}%",
    "cmd.memory.statsCandidates": "  candidates: {pending} pending, {approved} approved, {rejected} rejected",
    "cmd.memory.statsConfidence": "  avg confidence \u2014 used: {used} / unused: {unused}",
    "cmd.memory.statsNa": "n/a",

    // ── cmd.agent.* ─────────────────────────────────────────────────────
    "cmd.agent.none": "No agents available. Import one with `seekforge agent import <path>`.",
    "cmd.agent.listLine": "{id}  [{scope}] [{mode}]  {description}",
    "cmd.agent.imported": 'imported "{id}" [{mode}] \u2192 {dir}',
    "cmd.agent.tools": "tools: {tools}",
    "cmd.agent.droppedTools": "dropped tools (no SeekForge equivalent): {tools}",
    "cmd.agent.importedMore": "Check it with `seekforge agent show {id}`. The main agent can now",
    "cmd.agent.importedMore2": "delegate to it via dispatch_agent; edit-mode dispatch still asks for approval.",

    // ── cmd.skill.* ─────────────────────────────────────────────────────
    "cmd.skill.none": "No skills available.",
    "cmd.skill.listLine": "{id}  [{scope}]  {description}",
    "cmd.skill.imported": 'imported "{id}" \u2192 {dir}',
    "cmd.skill.importedTriggers": "triggers: {triggers}",
    "cmd.skill.importedMore": "Check it with `seekforge skill show {id}`. Imported skills are",
    "cmd.skill.importedMore2": "procedure suggestions only \u2014 they never grant extra permissions.",
    "cmd.skill.created": "created {dir}",
    "cmd.skill.createdMore": "Edit SKILL.md and skill.json, then check with `seekforge skill show {id}`.",
    "cmd.skill.enabled": 'enabled "{id}" ({scope})',
    "cmd.skill.disabled": 'disabled "{id}" ({scope}){marker}',
    "cmd.skill.removed": 'removed "{id}" ({path})',

    // ── cmd.evolve.* ────────────────────────────────────────────────────
    "cmd.evolve.none": "No evolution proposals yet. Run `seekforge evolve analyze` after a session.",
    "cmd.evolve.session": "session:  {id} [{status}]",
    "cmd.evolve.score": "score:    {score}/100",
    "cmd.evolve.metrics":
      "metrics:  turns={turns} toolCalls={toolCalls} failed={failedToolCalls} retried={retriedCommands} cost=${cost} verification={verification}",
    "cmd.evolve.metricsYes": "yes",
    "cmd.evolve.metricsNo": "no",
    "cmd.evolve.note": "  - {note}",
    "cmd.evolve.reflectionWritten": "reflection written to {path}",
    "cmd.evolve.noNewProposals": "No new evolution proposals.",
    "cmd.evolve.newProposals": "New proposals (review with `seekforge evolve show <id>`):",
    "cmd.evolve.accepted": "accepted {id} \u2014 apply with `seekforge evolve apply {id}`",
    "cmd.evolve.rejected": "rejected {id}",
    "cmd.evolve.applied": "applied {id} [{type}] \u2192 {path}",
    "cmd.evolve.appliedMore": "Review the change with `git diff` (or `seekforge diff`).",

    // ── cmd.config.* ────────────────────────────────────────────────────
    "cmd.config.setConfig": "set {key} in {path}",

    // ── cmd.mcp.* ───────────────────────────────────────────────────────
    "cmd.mcp.none": 'no MCP servers configured \u2014 add "mcpServers" to .seekforge/config.json',
    "cmd.mcp.serverLine": "{name}  ({cmd}, {trust})  {count} tool(s)",
    "cmd.mcp.serverError": "{name}  ({cmd}, {trust})  error: {error}",
    "cmd.mcp.trusted": "trusted",
    "cmd.mcp.untrusted": "untrusted",

    // ── cmd.rewind.* ────────────────────────────────────────────────────
    "cmd.rewind.restore": "restore  {path}",
    "cmd.rewind.delete": "delete   {path}",
    "cmd.rewind.skip": "skip     {path} ({reason})",
    "cmd.rewind.summary": "{verb} session {id}: {restored} restored, {deleted} deleted, {skipped} skipped.",
    "cmd.rewind.review": "Review the working tree with `seekforge diff`.",

    // ── cmd.replay.* ────────────────────────────────────────────────────
    "cmd.replay.header": "replaying session {id} — {title}",
    "cmd.replay.userLabel": "user:",
    "cmd.replay.assistantLabel": "assistant:",
    "cmd.replay.toolLabel": "tool:",
    "cmd.replay.empty": "(this session has no recorded events or messages to replay)",

    // ── cmd.audit.* ─────────────────────────────────────────────────────
    "cmd.audit.wrote": "wrote session audit to {path}",
    "cmd.audit.writeFailed": "could not write session audit to {path}",

    // ── cmd.serve.* ─────────────────────────────────────────────────────
    "cmd.serve.url": "SeekForge server: http://127.0.0.1:{port}/?token={token}",
    "cmd.serve.workspaces": "Serving {count} workspace(s) on 127.0.0.1 only:",
    "cmd.serve.pressCtrlC": "Press Ctrl+C to stop.",

    // ── cmd.init.* ──────────────────────────────────────────────────────
    "cmd.init.createdConfig": "created .seekforge/config.json",
    "cmd.init.agentsExists": "AGENTS.md already exists \u2014 left untouched",
    "cmd.init.createdAgents": "created AGENTS.md",
    "cmd.init.initialized": "initialized .seekforge/",

    // ── cmd.mcp-serve.* ─────────────────────────────────────────────────
    "cmd.mcpServe.header": "seekforge mcp-serve: {mode} on {workspace}",
    "cmd.mcpServe.readOnly": "read-only",
    "cmd.mcpServe.fullAccess": "FULL ACCESS (trusted callers only)",

    // ── cmd.completion.* ────────────────────────────────────────────────
    "cmd.completion.unsupportedShell": "unsupported shell: {shell} (expected bash or zsh)",

    // ── cmd.loop.* ──────────────────────────────────────────────────────
    "cmd.loop.autoApproveNote":
      "note: loop is autonomous — it auto-approves edits (acceptEdits). Pass -y to silence this.",
    "cmd.loop.iterationStart": "── iteration {n} ──",
    "cmd.loop.runCompleted": "iteration {n}: run completed (${cost})",
    "cmd.loop.verifyPassed": "iteration {n}: verify PASSED",
    "cmd.loop.verifyFailed": "iteration {n}: verify FAILED (exit {code})",
    "cmd.loop.summaryHeader": "── loop done ──",
    "cmd.loop.summaryStatus": "status:     {status}",
    "cmd.loop.summaryIterations": "iterations: {n}",
    "cmd.loop.summaryCost": "cost:       ${cost}",
    "cmd.loop.summarySession": "session:    {id}",
    "cmd.loop.summaryHint": "resume: seekforge resume {id}  |  rewind: seekforge rewind {id}",
  },
  zh: {
    // ── cmd.models.* ────────────────────────────────────────────────────
    "cmd.models.header": "DeepSeek 可用模型：\n",
    "cmd.models.deprecated": "（已弃用）",
    "cmd.models.default": "（默认）",
    "cmd.models.footer": "价格以美元计，每 100 万 Token。当输入提示前缀被缓存时，适用缓存命中价格。",

    // ── cmd.sessions.* ──────────────────────────────────────────────────
    "cmd.sessions.none": '暂无会话。运行 `seekforge run "<task>"` 开始一个会话。',
    "cmd.sessions.output": "{id}  [{status}]{cost}  {task}",
    "cmd.sessions.pruneSpecify": "请指定 --older-than <天数> 和/或 --keep-last <数量>（使用 --dry-run 预览）。",
    "cmd.sessions.pruneNumbers": "--older-than 和 --keep-last 必须是数字。",
    "cmd.sessions.pruneNone": "没有需要清理的会话。",
    "cmd.sessions.pruneResult": "{verb} {removed} 个会话；保留 {kept} 个。",
    "cmd.sessions.pruneWouldRemove": "将移除",
    "cmd.sessions.pruneRemoved": "已移除",

    // ── cmd.status.* ────────────────────────────────────────────────────
    "cmd.status.project": "项目目录：  {path}",
    "cmd.status.config": "配置文件：  {path}",
    "cmd.status.configInitialized": ".seekforge/ 已存在",
    "cmd.status.configNotInit": "未初始化（运行 seekforge init）",
    "cmd.status.apiKey": "API 密钥：  {key}",
    "cmd.status.apiKeyMasked": "缺失",
    "cmd.status.model": "模型：      {model}",
    "cmd.status.modelDefault": "deepseek-v4-flash（默认）",
    "cmd.status.global": "全局配置：  {path}",
    "cmd.status.sessions": "会话数：    {count}",
    "cmd.status.last": "最近会话：  {id} [{status}] {task}",

    // ── cmd.doctor.* ────────────────────────────────────────────────────
    "cmd.doctor.checksHeader": "{passed}/{total} 项检查通过",
    "cmd.doctor.fixHint": "→ 修复：{hint}",
    "cmd.doctor.checkConfigured": "已配置",
    "cmd.doctor.checkMissing": "缺失",
    "cmd.doctor.checkPresent": ".git 存在",
    "cmd.doctor.checkNoGitRepo": "不是 git 仓库 — 检查点和 `diff` 功能受限",
    "cmd.doctor.checkProjectConfig": ".seekforge/config.json",
    "cmd.doctor.checkUsingDefaults": "使用全局默认配置",
    "cmd.doctor.checkRuntimeNotFound": "未找到 {path}",
    "cmd.doctor.checkRuntimeNotConfigured": "未配置（使用 TS 回退）",
    "cmd.doctor.checkMcpCount": "已配置 {count} 个",
    "cmd.doctor.checkNoSessions": "暂无会话",
    "cmd.doctor.checkSessionCount": "已记录 {count} 个",
    "cmd.doctor.checkEditorUnset": "$EDITOR/$VISUAL 未设置 — 无法使用外部编辑器",
    "cmd.doctor.checkNoClipboard": "未找到剪贴板工具（pbcopy/wl-copy/xclip）",

    // ── cmd.memory.* ────────────────────────────────────────────────────
    "cmd.memory.factsHeader": "项目事实（使用 `seekforge memory remove <n>` 移除）：",
    "cmd.memory.noFacts": "project.md：（无事实）",
    "cmd.memory.factLine": "  {index}. {line}",
    "cmd.memory.pendingHeader": "待定候选（使用 `seekforge memory approve <id>` 批准）：",
    "cmd.memory.noPending": "暂无待定的记忆候选。",
    "cmd.memory.pendingCandidate": "  {id}  [{type}]（{confidence}）  {content}",
    "cmd.memory.addedQueued": "已排队待定候选 {id}：[{type}] {content}\n使用 `seekforge memory approve {id}` 批准",
    "cmd.memory.addedUser": "已添加到用户记忆（~/.seekforge）：[{type}] {content}",
    "cmd.memory.addedTo": "已添加到 {path}：",
    "cmd.memory.addedFact": "  - [{type}] {content}",
    "cmd.memory.auditCandidate": "审计候选：{id}",
    "cmd.memory.removedFact": "已移除事实 {selector}：{content}",
    "cmd.memory.deletedCandidate": "已删除候选 {id}：{content}",
    "cmd.memory.approved": "已批准 → project.md：{content}",
    "cmd.memory.rejected": "已拒绝 {id}",
    "cmd.memory.compacted": "{verb} project.md：{before} → {after} 条事实",
    "cmd.memory.wouldCompact": "将压缩",
    "cmd.memory.compactedLabel": "已压缩",
    "cmd.memory.duplicatesHeader": "已移除的完全重复项（{count}）：",
    "cmd.memory.mergedHeader": "已合并的近似重复项（{count}）：",
    "cmd.memory.archivedHeader": "已归档的未使用事实（{count}）：",
    "cmd.memory.mergedKeep": "  保留：{line}",
    "cmd.memory.mergedDrop": "  丢弃：{line}",
    "cmd.memory.nothingToCompact": "没有需要压缩的内容。",
    "cmd.memory.dryRunNote": "（试运行 — project.md 未更改）",
    "cmd.memory.statsHeader": "记忆提取统计：",
    "cmd.memory.statsApproved": "  已批准事实：{total} 条（{auto} 条自动提取，{direct} 条手动添加）",
    "cmd.memory.statsUsed": "  使用占比（精确度代理）：{percent}%",
    "cmd.memory.statsRejection": "  候选拒绝率：{percent}%",
    "cmd.memory.statsCandidates": "  候选：{pending} 待定，{approved} 已批准，{rejected} 已拒绝",
    "cmd.memory.statsConfidence": "  平均置信度 — 已使用：{used} / 未使用：{unused}",
    "cmd.memory.statsNa": "暂无",

    // ── cmd.agent.* ─────────────────────────────────────────────────────
    "cmd.agent.none": "没有可用代理。使用 `seekforge agent import <path>` 导入一个。",
    "cmd.agent.listLine": "{id}  [{scope}] [{mode}]  {description}",
    "cmd.agent.imported": '已导入 "{id}" [{mode}] → {dir}',
    "cmd.agent.tools": "工具：{tools}",
    "cmd.agent.droppedTools": "已丢弃的工具（无 SeekForge 等效项）：{tools}",
    "cmd.agent.importedMore": "使用 `seekforge agent show {id}` 查看。主代理现在可以通过",
    "cmd.agent.importedMore2": "dispatch_agent 委托给子代理；编辑模式下的委托仍需批准。",

    // ── cmd.skill.* ─────────────────────────────────────────────────────
    "cmd.skill.none": "没有可用技能。",
    "cmd.skill.listLine": "{id}  [{scope}]  {description}",
    "cmd.skill.imported": '已导入 "{id}" → {dir}',
    "cmd.skill.importedTriggers": "触发器：{triggers}",
    "cmd.skill.importedMore": "使用 `seekforge skill show {id}` 查看。导入的技能仅作为",
    "cmd.skill.importedMore2": "过程建议 — 它们不会授予额外权限。",
    "cmd.skill.created": "已创建 {dir}",
    "cmd.skill.createdMore": "编辑 SKILL.md 和 skill.json，然后使用 `seekforge skill show {id}` 查看。",
    "cmd.skill.enabled": '已启用 "{id}"（{scope}）',
    "cmd.skill.disabled": '已禁用 "{id}"（{scope}）{marker}',
    "cmd.skill.removed": '已移除 "{id}"（{path}）',

    // ── cmd.evolve.* ────────────────────────────────────────────────────
    "cmd.evolve.none": "尚无进化提案。请在会话后运行 `seekforge evolve analyze`。",
    "cmd.evolve.session": "会话：    {id} [{status}]",
    "cmd.evolve.score": "评分：    {score}/100",
    "cmd.evolve.metrics":
      "指标：    turns={turns} toolCalls={toolCalls} failed={failedToolCalls} retried={retriedCommands} cost=${cost} verification={verification}",
    "cmd.evolve.metricsYes": "是",
    "cmd.evolve.metricsNo": "否",
    "cmd.evolve.note": "  - {note}",
    "cmd.evolve.reflectionWritten": "反思已写入 {path}",
    "cmd.evolve.noNewProposals": "没有新的进化提案。",
    "cmd.evolve.newProposals": "新提案（使用 `seekforge evolve show <id>` 查看）：",
    "cmd.evolve.accepted": "已接受 {id} — 使用 `seekforge evolve apply {id}` 应用",
    "cmd.evolve.rejected": "已拒绝 {id}",
    "cmd.evolve.applied": "已应用 {id} [{type}] → {path}",
    "cmd.evolve.appliedMore": "使用 `git diff`（或 `seekforge diff`）查看变更。",

    // ── cmd.config.* ────────────────────────────────────────────────────
    "cmd.config.setConfig": "已在 {path} 中设置 {key}",

    // ── cmd.mcp.* ───────────────────────────────────────────────────────
    "cmd.mcp.none": '未配置 MCP 服务器 — 在 .seekforge/config.json 中添加 "mcpServers"',
    "cmd.mcp.serverLine": "{name}  ({cmd}, {trust})  {count} 个工具",
    "cmd.mcp.serverError": "{name}  ({cmd}, {trust})  错误：{error}",
    "cmd.mcp.trusted": "受信任",
    "cmd.mcp.untrusted": "不受信任",

    // ── cmd.rewind.* ────────────────────────────────────────────────────
    "cmd.rewind.restore": "恢复    {path}",
    "cmd.rewind.delete": "删除    {path}",
    "cmd.rewind.skip": "跳过    {path}（{reason}）",
    "cmd.rewind.summary": "{verb} 会话 {id}：恢复 {restored} 个，删除 {deleted} 个，跳过 {skipped} 个。",
    "cmd.rewind.review": "使用 `seekforge diff` 查看工作树。",

    // ── cmd.replay.* ────────────────────────────────────────────────────
    "cmd.replay.header": "正在回放会话 {id} — {title}",
    "cmd.replay.userLabel": "用户：",
    "cmd.replay.assistantLabel": "助手：",
    "cmd.replay.toolLabel": "工具：",
    "cmd.replay.empty": "（该会话没有可回放的事件或消息记录）",

    // ── cmd.audit.* ─────────────────────────────────────────────────────
    "cmd.audit.wrote": "会话审计已写入 {path}",
    "cmd.audit.writeFailed": "无法将会话审计写入 {path}",

    // ── cmd.serve.* ─────────────────────────────────────────────────────
    "cmd.serve.url": "SeekForge 服务器：http://127.0.0.1:{port}/?token={token}",
    "cmd.serve.workspaces": "仅在 127.0.0.1 上服务 {count} 个工作区：",
    "cmd.serve.pressCtrlC": "按 Ctrl+C 停止。",

    // ── cmd.init.* ──────────────────────────────────────────────────────
    "cmd.init.createdConfig": "已创建 .seekforge/config.json",
    "cmd.init.agentsExists": "AGENTS.md 已存在 — 保持原样",
    "cmd.init.createdAgents": "已创建 AGENTS.md",
    "cmd.init.initialized": "已初始化 .seekforge/",

    // ── cmd.mcp-serve.* ─────────────────────────────────────────────────
    "cmd.mcpServe.header": "seekforge mcp-serve：{mode} 位于 {workspace}",
    "cmd.mcpServe.readOnly": "只读",
    "cmd.mcpServe.fullAccess": "完全访问（仅限受信任的调用方）",

    // ── cmd.completion.* ────────────────────────────────────────────────
    "cmd.completion.unsupportedShell": "不支持的 shell：{shell}（期望 bash 或 zsh）",

    // ── cmd.loop.* ──────────────────────────────────────────────────────
    "cmd.loop.autoApproveNote": "提示：loop 为自主模式，会自动批准编辑（acceptEdits）。加 -y 可隐藏此提示。",
    "cmd.loop.iterationStart": "── 第 {n} 轮 ──",
    "cmd.loop.runCompleted": "第 {n} 轮：运行完成（${cost}）",
    "cmd.loop.verifyPassed": "第 {n} 轮：校验通过",
    "cmd.loop.verifyFailed": "第 {n} 轮：校验失败（退出码 {code}）",
    "cmd.loop.summaryHeader": "── loop 结束 ──",
    "cmd.loop.summaryStatus": "状态：    {status}",
    "cmd.loop.summaryIterations": "轮数：    {n}",
    "cmd.loop.summaryCost": "费用：    ${cost}",
    "cmd.loop.summarySession": "会话：    {id}",
    "cmd.loop.summaryHint": "恢复：seekforge resume {id}  |  回退：seekforge rewind {id}",
  },
};
