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
| 桌面端与本地网页工作台 | 已实现，走向成熟 | macOS、Linux 与 Windows 原生安装包构建已交付；updater/平台签名及干净安装冒烟仍需发布凭据。 |
| DeepSeek provider 与成本统计 | 生产就绪的基础 | 主调用、压缩调用与记忆提取调用共享统计；保留 provider 特有的 token/缓存语义。 |
| Provider 预设 / OpenAI 兼容端点 | 已实现，走向成熟 | 为各 provider 增加兼容性 fixture；不宣称工具/思考行为完全一致。 |
| 记忆、技能、hook、MCP、子智能体 | 已实现，走向成熟 | 曝光/检索指标、OAuth token 刷新与长连接 HTTP 通知/请求流已交付；首次交互式 OAuth 授权仍由前端负责。 |
| Worktree 与隔离执行 | 已实现 | Git 仓库中的可写后台与 webhook 作业默认使用 worktree 隔离，并支持显式原工作区/强制 worktree 模式。 |
| `seekforge resolve` issue 到 draft PR | 已实现，走向成熟 | 已有分支续用与单次受限的 CI 日志修复已交付；扩大 provider/托管平台兼容性 fixture。 |
| 定时任务、webhook 与后台运行 | 已实现，安全敏感 | 持久化运行台账、取消、重放游标与按数量/天数保留已交付；继续强化外部投递操作。 |
| 浏览器 / 可视化验证 | 已实现，可选 | 真实 Chromium 集成 CI 已交付；在保持私有网络限制的前提下扩大浏览器/平台覆盖。 |
| Rust runtime 与 Docker runner | 已实现，可选 | 每周真实二进制/容器门禁已交付；扩大平台矩阵与发布冒烟覆盖。 |
| Eval 框架 | 已实现 | 真实 Loop/恢复/记忆场景、成对多样本 A/B、CI 历史恢复、趋势报告及带来源标记的 dogfood 回归已交付。 |
| `@seekforge/core` 嵌入 API | 按策略保持内部使用 | 0.x 包继续私有；[公开发布条件](core-package-policy.zh-CN.md)明确了编译产物、导出、semver、消费者测试、示例与安全文档。 |
| VS Code / JetBrains 集成 | VS Code 桥接已实现；JetBrains 待实现 | 基于 REST/WS 契约的轻量 VS Code 客户端已支持聊天、diff、原始权限审阅、会话续接、问题回答与 `@file` 上下文。 |
| 远程/团队执行服务 | 设计阶段 | 在不削弱本地优先默认设置的前提下，稳定一套自托管 runner 契约。 |

## 近期优先级

1. 在拿到平台签名凭据后，产出签名的 updater 产物，并增加跨平台干净安装
   冒烟任务；CI 已能构建各平台原生安装包。
2. 扩充真实项目生命周期的 eval fixture，并保留足够的 CI 趋势历史，
   以便发现跨版本的缓慢成本/质量漂移。
3. 完成远程 MCP server 的首次交互式 OAuth 授权；refresh-token 运转与长连接
   Streamable HTTP 处理已交付。
4. 改进 provider 兼容性 fixture，同时把 DeepSeek 特有的成本与 cache-hit
   报告保持在一等公民地位。
5. 加固并打包 VS Code 桥接，然后评估基于同一契约的 JetBrains 客户端。
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
