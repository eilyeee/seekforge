# 技能

> [English](skills.md) | **简体中文**

技能是针对当前任务自动选择、长度受限的流程简报。它们只会向 system prompt
添加操作指引；绝不会授予工具权限、批准命令或削弱沙箱。

## 目录与优先级

原生技能是一个包含两个普通文件的真实目录：

```text
.seekforge/skills/review-api/
├── skill.json
└── SKILL.md
```

`skill.json` 使用 `apiVersion: 1`，定义 `id`、`name`、`description`、`tags`、
`triggers`，以及可选的 `negativeTriggers`、`taskTypes`、
`appliesTo.languages/frameworks/filePatterns`、`dependsOn`、`conflictsWith`、
`order`、`priority`、`enabled` 和 `risk`（`low`、`medium` 或 `high`）。`id`
必须与目录名一致。`SKILL.md`
保存流程；系统会优先提取名为 Procedure、Workflow、Steps、Instructions、步骤、
流程或操作步骤的章节。

层级按「内置 < 已启用插件根目录 < 全局 `~/.seekforge/skills` < 项目
`.seekforge/skills`」解析。高层同 ID 技能替换低层定义；`enabled:false` 标记可
禁用内置技能。

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

高风险技能不会被自动选择，只能由调用方显式选择或直接调用。每份已选简报都会标明来源层级
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

外部 Claude 风格 `SKILL.md` 的 frontmatter 会被转换为原生双文件布局，初始风险为 medium。
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
