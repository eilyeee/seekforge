# 技能

> [English](skills.md) | **简体中文**

技能是 agent 处理某类任务时遵循的有界流程。它们通过两条路径到达模型：少数技能被自动选中、
以简报形式预先注入；所有允许模型调用的技能都会列入清单，模型可以用 `invoke_skill` 加载。
技能绝不会削弱沙箱；它在激活期间能对工具权限做什么，取决于是谁写的它（见
[技能激活期间的工具规则](#技能激活期间的工具规则)）。

`GET /api/skills/supply-chain` 与桌面 Skills 页面会为每个生效技能（含插件贡献）展示规范 SHA-256、API 版本、作用域、风险、依赖、冲突和加载诊断。

## 目录与优先级

技能是一个以其 id 命名的真实目录，包含 `SKILL.md`，以及可选的 `skill.json`：

```text
.seekforge/skills/review-api/
├── skill.json      （可选）
└── SKILL.md
```

`SKILL.md` 保存流程，开头可以带 YAML frontmatter（见 [Claude Code 技能](#claude-code-技能)）。
生成简报时会优先提取名为 Procedure、Workflow、Steps、Instructions、步骤、流程或操作步骤的章节。

`skill.json` 使用 `apiVersion: 1`，可以定义 `name`、`description`、`tags`、`triggers`、
`negativeTriggers`、`taskTypes`、`appliesTo.languages/frameworks/filePatterns`、`dependsOn`、
`conflictsWith`、`order`、`priority`、`enabled`、`risk`（`low`、`medium` 或 `high`），以及
驼峰拼写的调用字段（`whenToUse`、`argumentHint`、`argumentNames`、`allowedTools`、
`disallowedTools`、`model`、`effort`、`context`、`agent`、`disableModelInvocation`、
`userInvocable`、`paths`）。`id` 必须与目录名一致。两个文件同时存在时，`skill.json` 中设为
非空值的字段优先；空字符串与空列表（`skill create` 生成的脚手架就是这样）视为未设置，由
frontmatter 补齐。

目录中的其他文件会随技能一起携带 —— 检查清单、模板、脚本 —— 并可用 `read_skill` 读取。

层级按「内置 < 已启用插件根目录 < 用户层（开启 `claudeUserSkills` 时先读 `~/.claude/skills`，
再读 `~/.seekforge/skills`）< 项目层（先 `.claude/skills`，再 `.seekforge/skills`）」解析。
高层同 ID 技能替换低层定义，同一层内 `.seekforge` 目录优先。`.seekforge/skills` 中的
`enabled:false` 标记可以禁用同 ID 的低层技能 —— 内置技能、插件技能或读自 `.claude/skills`
的技能，SeekForge 从不修改这些来源。

## Claude Code 技能

Claude Code 技能可以原样放入：项目中的 `.claude/skills/<name>/SKILL.md` 始终会被读取；
`~/.claude/skills` 需要用户在自己的配置里设置 `"claudeUserSkills": true` 才会读取（仓库配置
中的该键会被忽略）。`SKILL.md` 的 frontmatter 提供：

| 字段 | 含义 |
|---|---|
| `name`、`description` | 显示名（默认为目录名）与摘要（默认为正文第一段）。 |
| `when_to_use` | 在清单中显示在描述旁边。 |
| `argument-hint`、`arguments` | 参数占位提示，以及绑定到 `$name` 的参数名（列表或空格分隔的字符串）。 |
| `allowed-tools`、`disallowed-tools` | 技能激活期间生效的工具规则（见下文）。 |
| `model`、`effort` | 宿主能切换时，本次运行余下部分使用的模型；`effort` 会记录但不会在运行中途生效。 |
| `context: fork`、`agent` | 在子代理中运行技能；`agent` 指定代理（`Explore`/`Plan` 对应 `explorer`/`planner`）。 |
| `disable-model-invocation` | `true`：只有用户能调用 —— 既不会列入清单，也不会被自动选择。 |
| `user-invocable` | `false`：在斜杠菜单中隐藏（`GET /api/skills` 以 `userInvocable` 暴露）。 |
| `paths` | glob 列表；只有工作区中有文件匹配时才会提供该技能。 |
| `triggers`、`tags` | 若存在，作为 SeekForge 自己的选择元数据。 |

列表可以写成 YAML 列表、`[a, b]`，或逗号/空格分隔的字符串。SeekForge 读不懂的值
（`context: forked`、`disable-model-invocation: maybe`、无法解析的工具条目）会让该技能变成
一条诊断，而不是被猜测。其他 Claude Code 键（`hooks`、`shell`、`license` 等）会被忽略。
frontmatter 技能的初始风险为 medium。

## 模型调用

system prompt 会列出模型可以加载的每个已启用技能 —— id、描述与 `when_to_use`（每项最多
1,536 字符）、参数提示，以及是否在子代理中运行 —— 总预算 8,000 字符：超出时先缩短每一项，
再丢弃条目，并注明丢弃了多少。已禁用、高风险、`disable-model-invocation`，以及 `paths`
没有匹配文件的技能不会列出。已作为简报预先注入的技能仍会列出并加以标注，因为简报只是摘录。

`invoke_skill(name, arguments?)` 把技能的指令作为工具结果返回。参数替换与 Claude Code 一致，
且只做一遍，替换进去的值不会被再次展开：`$ARGUMENTS`（整个字符串）、`$ARGUMENTS[N]` 与
`$N`（从 0 开始、按 shell 规则切分的词），以及 `arguments` 中每个名字对应的 `$name`；没有值的
占位符保持原样，正文里没有任何占位符时会在末尾追加 `ARGUMENTS: …`。`${CLAUDE_SKILL_DIR}`、
`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PROJECT_DIR}` 与 `${CLAUDE_SESSION_ID}` 解析为本次运行的
值。`` !`command` `` 块永远不会执行 —— 这次调用由模型触发，模型不能借此运行 shell。

同一次运行中以相同参数再次加载同一技能，只会返回简短的「已加载」说明；传入 `reload: true`
会再次返回指令（例如压缩把它们丢掉之后）。

## 技能激活期间的工具规则

内联技能的规则从调用那一刻起生效到本次运行结束，且只作用于这次运行的策略（此后派发的子代理
会继承这些规则）；下一次运行从干净状态开始。条目使用 Claude Code 语法及其工具名（`Bash`、`Read`、`Edit`、`Write`、`Glob`、
`Grep`、`WebFetch` 等，会映射到 SeekForge 的工具），也可以直接写 SeekForge 的工具名：

- `disallowed-tools` 在**所有**作用域下都会添加拒绝规则。SeekForge 无法精确表达的条目
  （`Bash(npm test)`、`Read(*.ts)`）会改为拒绝整个工具 —— 过宽的拒绝是失败即关闭；路径条目
  还会同时拒绝其在工作区下的绝对路径写法。
- `allowed-tools` 添加允许规则 —— **仅限**内置技能和用户层技能（`~/.seekforge/skills`、
  `~/.claude/skills`，以及用户已启用插件中的技能）。项目技能属于仓库内容，其 `allowed-tools`
  会被忽略，调用结果会说明这一点。`Bash(git log:*)` 会变成以 `git log` 为前缀的允许规则；
  无法精确表达的条目完全不会被预先批准，用户会像平常一样被询问。

允许规则走普通的匹配器，因此拒绝规则、ask 规则、`dangerous` 命令与复合 shell 命令的优先级
都保持不变。参见[安全模型](security-model.zh-CN.md#技能工具规则)。

## 分叉技能

`context: fork` 通过常规派发机制在子代理中运行技能，并返回其报告。代理为 `agent` 指定的那个
（以 `skill:<id>` 为 id 复制一份，这样之后 `agent_send` 无法在缺少技能规则的情况下恢复它），
未指定 `agent` 时则是一个沿用父运行模式的临时代理。分叉运行使用本次运行的规则加上技能自己
的规则，`model` 成为子代理的模型。可能写入的分叉会被归类为写操作：`confirm` 模式下用户需要
批准 `invoke_skill` 本身，只读的父运行不能分叉出可编辑的代理。不支持子代理的宿主会内联运行
该技能，并在结果中说明。

## 自动选择

选择过程确定且有界，默认最多三个技能。唯一的 trigger/tag 命中、推断出的任务类型、检测到
的框架与语言、以及匹配的工作区路径都会计分；若这些信号都未命中，还会通过本地、长度受限
的词法与字符相似度检索描述和流程。`negativeTriggers` 会否决自动选择；priority 只对已相关
的候选作排序。拉丁词按单词边界匹配，
CJK 和含标点的词使用子串匹配。工作区探测忽略生成目录和依赖目录，并在 5,000 个路径后停止。
信号索引会在进程内缓存，只有全部已扫描目录和 `package.json` 的物理身份及修改时间都未改变
时才会复用。

`dependsOn` 技能占用同一选择预算，并先于依赖方注入。依赖缺失、禁用、高风险或形成循环时，
整个依赖组合都会被拒绝。`conflictsWith` 由排名更高的候选获胜，之后再用 `order` 确定稳定顺序。

## 两级披露：先简报，再全文

进入 prompt 的只是**摘录**。每个被选中的技能分到 2,500 字符预算中的一份，流程超出这一份
就会被截断 —— 并留下一个指明「去哪里取回其余部分」的标记：

```text
…[truncated — call read_skill("review-api") for the full procedure]
```

`read_skill(id)` 返回完整的 `SKILL.md`，以及该技能携带的文件清单；
`read_skill(id, file)` 返回其中某个文件。两者都是只读。这正是分两级的意义：简报便宜到
可以每个会话都注入，负责说明这个技能是**干什么用的**；只有当模型判断它确实适用时，才为
全文付费。

携带文件在技能自己的目录内解析，符号链接与 `..` 一律拒绝 —— 技能可能来自仓库，因此它的
文件名和仓库里任何其他内容一样不可信。

放不进剩余预算的技能会被**整条略去**，而不是以残片形式出现：缺席是模型可以据此推理的，
残缺不是。

2,500 字符的预算是**按需分配，而非均分**。均分会让长流程被饿死、同时让短流程的份额闲置
——选中三个内建技能时均分是每个 832 字符，`simplify` 用不完还剩 92，`bugfix` 却差 272，
于是一边在丢步骤、一边在浪费预算。现在改为「注水式」分配：每个技能只拿它花得掉的份额，
剩余额度再回炉分给仍然不够的技能。最后剩下的零头会整块给到某一个技能，而不是摊薄到每一个
——多送达一个完整步骤，胜过三份各多几个字符。

被截断的流程一律在**步骤边界**切断，绝不切在步骤中间。这些流程是带编号的列表，步骤会跨行
折行，所以按行边界切仍然会落在第 4 步内部——而半个第 4 步读起来和完整的第 4 步一模一样，
模型无从分辨。现在会丢弃这半步，并由 `read_skill(…)` 标记指明其余部分在哪里。

高风险技能不会被自动选择，只能由调用方显式选择或直接调用。带 `disable-model-invocation`
的技能永远不会被选择，带 `paths` 的技能必须有匹配的工作区文件。每份已选简报都会标明来源层级
和风险，与其他技能公平共享 2,500 字符的 prompt 预算；恢复 Agent/Auto-Loop 时也会针对
本次续跑任务重新选择。每次组装只生成一次插件根目录与配置快照，并在技能、代理、hook 与
MCP 工具之间复用。应用工厂还会快照已加载的技能内容，因此运行中修改技能存储不会改变当前
Agent 的 prompt。

## 生命周期与诊断

```bash
seekforge skill create review-api
seekforge skill import ./external/SKILL.md [-g] [-f]
seekforge skill list
seekforge skill show review-api
seekforge skill stats
seekforge skill repair [--id review-api] [-g]
seekforge skill enable|disable|remove review-api
```

`skill import` 会原样复制外部 Claude 风格的 `SKILL.md`（因此其调用字段继续有效），并写入
一个包含推导出的选择元数据的 `skill.json`；技能初始风险为 medium，SeekForge 读不懂的
frontmatter 会在写入任何内容之前被拒绝。`skill show` 会打印调用字段以及技能来源。
`skill enable|disable` 也适用于只有 `SKILL.md` 的技能（开关写入一个最小的 `skill.json`），
并能通过标记作用于读自 `.claude/skills` 或插件的技能。
变更使用跨进程租约，不会与活跃项目 Agent 竞争；链接或非物理根目录/文件会被拒绝，导入采用
原子替换。CLI `skill list`、TUI `/skills`、桌面端技能页以及
`GET /api/skills/diagnostics` 都会展示畸形或不安全安装的诊断，而不是静默隐藏。缺少
`apiVersion` 的旧版对象元数据仍可加载，并会标记为可修复；`skill repair` 会以原子方式补充
版本 1，同时保留未知用户字段。系统不会猜测不支持的版本或非对象元数据。

选择遥测以尽力而为方式追加到 `.seekforge/skills-usage.jsonl`。它不会跟随链接或阻塞在
特殊文件上，会限制原因长度、串行化并发写入，并在 8 MiB 时轮转。遥测失败绝不会改变
Agent 的运行结果。每个已选技能还会记录终态成功/失败，以及有界的轮次、工具调用数、成本和
已配置验证器观测；已配置验证器失败会计为不成功结果。
`skill stats`、TUI `/skills`、桌面端以及 `GET /api/skills/stats` 会展示聚合结果。自动权重至少
收集三个终态样本后才开始生效，按置信度收缩并限制在 `[-0.75, 0.75]`；它只影响排序，绝不
影响权限。评测工具提供 `no-skills` A/B 变体用于受控测量。
