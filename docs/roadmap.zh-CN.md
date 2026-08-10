# 路线图与能力成熟度

> [English](roadmap.md) | **简体中文**

SeekForge 已经具备了较为完整的本地优先编码智能体能力面。本路线图将「已交付的能力」与「生产级成熟度」区分开来，避免已实现的功能被反复当作缺失项。状态反映的是仓库当前的真实情况，而非对 API 稳定性的承诺。

## 产品定位

- 默认本地优先，配备可审计的 JSONL trace。
- DeepSeek 优先的成本可见性，包括 cache-hit token 统计。
- 强权限边界，提示时展示原始命令/路径。
- 可审阅的 search/replace 补丁、rewind、worktree，以及人工把关的记忆。
- 对中文友好的 CLI、TUI、桌面端与文档工作流。

## 能力成熟度

| 能力 | 状态 | 当前边界 / 下一步 |
| --- | --- | --- |
| 核心智能体循环、CLI、TUI、会话 trace、权限 | 生产就绪的基础 | 持续进行边界回归测试与真实项目实战验证（dogfooding）。 |
| 自主 Loop 与 Graph 工程 | 已实现，走向成熟 | 安全边界自适应调度、Desktop 创建/模拟、灰度控制、运维诊断、版本化决策证据、消耗率冻结控制、可续租执行器 fencing 和签名 CAS 血缘已交付。持久控制、外部信号、证据、运行对比与模板注册表现已覆盖 CLI 与 TUI，不再只有 REST；确定性处理器目录让「只写定义」的工作流可用。下一步：先补齐下方的工程图 `loop` 节点缺口，再扩大真实 provider 与真实项目覆盖。 |
| Loop DAG → 工程图收敛 | 迁移路径已交付，引擎未合并 | `seekforge loop-dag export-graph` 可确定性地转换 DAG，并拒绝任何它无法保证行为一致的定义。Loop DAG 契约已冻结：新的编排能力只落在工程图上。合并仍受阻于工程图的 `loop` 节点——它只转发 `task`/`workspace`/`verifyCommand`/`approvalMode`/预算/`timeoutMs`，逐 Loop 的 `options`、`consumeDependencyOutputs`、`outputPaths`、`budgetWeight`、`predictiveBudget`、`verifierId` 与逐节点失败策略在图上尚无等价物。 |
| 桌面端与本地网页工作台 | 已实现，走向成熟 | macOS、Linux 与 Windows 原生安装包构建已交付；updater/平台签名及干净安装冒烟仍需发布凭据。 |
| DeepSeek provider 与成本统计 | 生产就绪的基础 | 主调用、压缩调用与记忆提取调用共享统计；保留 provider 特有的 token/缓存语义。 |
| Provider 预设 / OpenAI 兼容端点 | 已实现，走向成熟 | 各家兼容端点的线上方言差异（`reasoning` 拼写、`function_call`、无 index 的工具分片、`prompt_tokens_details`）已归一化并由 fixture 矩阵锁定；仍不宣称工具/思考行为完全一致。 |
| 记忆、技能、hook、MCP、子智能体 | 已实现，走向成熟 | 曝光/检索指标、长连接 HTTP 通知/请求流，以及首次交互式 OAuth 授权（`seekforge mcp login`，PKCE，凭据存放在配置文件之外）均已交付。 |
| Worktree 与隔离执行 | 已实现 | Git 仓库中的可写后台与 webhook 作业默认使用 worktree 隔离，并支持显式原工作区/强制 worktree 模式。 |
| `seekforge resolve` issue 到 draft PR | 已实现，走向成熟 | 已有分支续用与有界 CI 日志修复已交付；Loop PR 交付现已提供相同的有界检查与修复闭环。继续扩大 provider/托管平台兼容性 fixture。 |
| 定时任务、webhook 与后台运行 | 已实现，安全敏感 | 持久化运行台账、取消、重放游标与按数量/天数保留已交付；继续强化外部投递操作。 |
| 浏览器 / 可视化验证 | 已实现，可选 | 真实 Chromium 集成 CI 已交付；在保持私有网络限制的前提下扩大浏览器/平台覆盖。 |
| Rust runtime 与 Docker runner | 已实现，可选 | 每周真实二进制/容器门禁已交付；扩大平台矩阵与发布冒烟覆盖。 |
| Eval 框架 | 已实现 | 真实 Loop/恢复/记忆场景、成对多样本 A/B、CI 历史恢复、Desktop 趋势可视化、带来源标记的 dogfood 回归，以及携带来源并支持 CI 漂移门禁的生态/执行/故障编排矩阵已交付。新增 `graph` runner 驱动真实图引擎，并有五个任务评测控制面（多节点、审批门、rerun 连带后代、wait/signal、失败后继续）。基线已于 2026-08-10 以 68 任务 ×3 样本重录：203/204。 |
| `@seekforge/core` 嵌入 API | 按策略保持内部使用 | 0.x 包继续私有；[公开发布条件](core-package-policy.zh-CN.md)明确了编译产物、导出、semver、消费者测试、示例与安全文档。 |
| VS Code / JetBrains 集成 | VS Code 客户端已交付（对话 + 只读 Loop 面板）；JetBrains 待实现 | 轻量 VS Code 客户端以带版本号的 .vsix 随发布提供：工具活动流、以 diff 文档呈现并支持逐 hunk 批准的权限审阅、成本/缓存读数、会话续接、问题回答、`@file` 上下文、记忆候选审阅，以及可读的会话记录。Marketplace 发布仍需手动（发布者令牌）。 |
| 远程/团队执行服务 | 设计阶段；单操作者远程执行已交付 | Graph 的 `remote` 节点现在可以跑在 Docker 与 ssh runner 上，且只从 `~/.seekforge/graph-executors.json` 注册，因此被克隆的仓库无法指定主机。剩下的是多操作者场景：在不削弱本地优先默认设置的前提下，稳定一套自托管 runner 契约。 |

## 近期优先级

1. 在拿到平台签名凭据后，产出签名的 updater 产物，并增加跨平台干净安装
   冒烟任务；CI 已能构建各平台原生安装包。
2. 扩充真实项目生命周期的 eval fixture，并保留足够的 CI 趋势历史，以便发现跨版本的
   缓慢成本/质量漂移；基线已于 2026-08-10 更新（68 任务、三样本、203/204）。
3. 补齐工程图 `loop` 节点的能力缺口，使 Loop DAG 真正可以退役；随后扩大
   Loop/Graph 控制面的真实 provider 覆盖；OpenAI 兼容端点的线上方言差异已
   归一化并有 fixture 锁定。
4. 改进 provider 兼容性 fixture，同时把 DeepSeek 特有的成本与 cache-hit
   报告保持在一等公民地位。
5. 评估基于同一契约的 JetBrains 客户端；VS Code 客户端现已作为带版本号的 .vsix 发布产物交付。
6. 仅在文档规定的退出条件全部满足后，重新评估 `@seekforge/core` 的公开发布。

## 文档优先级

- 让任务向的 cookbook 与迁移指南与已交付的行为保持一致。
- 明确标注可选与实验性的能力面，而不是把它们呈现为普遍安装或稳定的功能。
- 保持项目 README 精简，将运维/安全细节放在 `docs/` 中。

## 下一阶段的非目标

- 不为过早追逐云端功能而稀释本地优先的安全模型。
- 不把成本或 token 统计隐藏在泛化的 provider 抽象背后。
- 在分发与兼容性契约成型之前不发布 SDK。
- 不添加无法通过常规会话 trace 审计的集成。

## 有用的对比参考

- [Aider](https://github.com/Aider-AI/aider)
- [Cline](https://github.com/cline/cline)
- [OpenHands](https://github.com/All-Hands-AI/OpenHands)
- [Roo Code](https://github.com/RooCodeInc/Roo-Code)
