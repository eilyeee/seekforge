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
| 桌面端与本地网页工作台 | 已实现，走向成熟 | Security Center、MCP 编辑、团队规划与历史子智能体重放已交付；扩大签名的跨平台打包。 |
| DeepSeek provider 与成本统计 | 生产就绪的基础 | 主调用、压缩调用与记忆提取调用共享统计；保留 provider 特有的 token/缓存语义。 |
| Provider 预设 / OpenAI 兼容端点 | 已实现，走向成熟 | 为各 provider 增加兼容性 fixture；不宣称工具/思考行为完全一致。 |
| 记忆、技能、hook、MCP、子智能体 | 已实现，走向成熟 | 曝光/检索指标与 HTTP token 刷新已交付；完成交互式 OAuth 与长连接 HTTP 流。 |
| Worktree 与隔离执行 | 已实现，走向成熟 | 让 worktree 隔离成为并行 issue/PR 任务的默认方式。 |
| `seekforge resolve` issue 到 draft PR | 已实现，走向成熟 | 已有分支续用与单次受限的 CI 日志修复已交付；扩大 provider/托管平台兼容性 fixture。 |
| 定时任务、webhook 与后台运行 | 已实现，安全敏感 | 持久化运行台账、历史、取消、重试退避与 WS 重放已交付；增加保留期控制。 |
| 浏览器 / 可视化验证 | 已实现，可选 | 真实 Chromium 集成 CI 已交付；在保持私有网络限制的前提下扩大浏览器/平台覆盖。 |
| Rust runtime 与 Docker runner | 已实现，可选 | 每周真实二进制/容器门禁已交付；扩大平台矩阵与发布冒烟覆盖。 |
| Eval 框架 | 已实现 | 真实 Loop/恢复/记忆场景、成对多样本 A/B、CI 历史恢复与趋势报告已交付。 |
| `@seekforge/core` 嵌入 API | 内部 / 实验性 | 包为私有、以源码导出；在公开发布 SDK 前需先定义构建、semver 与兼容性政策。 |
| VS Code / JetBrains 集成 | 未实现 | 从基于现有 REST/WS 服务器契约的轻量客户端起步。 |
| 远程/团队执行服务 | 设计阶段 | 在不削弱本地优先默认设置的前提下，稳定一套自托管 runner 契约。 |

## 近期优先级

1. 在拿到平台签名凭据后，产出签名的 updater 产物，并增加 Linux/Windows
   干净安装的桌面端冒烟任务。
2. 在默认启用长时运行的远程 runner 之前，先补齐运行台账/事件的保留、
   压缩与运维控制。
3. 扩充真实项目生命周期的 eval fixture，并保留足够的 CI 趋势历史，
   以便发现跨版本的缓慢成本/质量漂移。
4. 完成交互式 OAuth 授权与长连接 Streamable HTTP MCP 的通知/请求处理；
   refresh-token 运转已交付。
5. 改进 provider 兼容性 fixture，同时把 DeepSeek 特有的成本与 cache-hit
   报告保持在一等公民地位。
6. 基于版本化的 `seekforge serve` 契约构建轻量 VS Code 桥接，支持聊天、diff、
   权限、会话恢复与 `@file` 上下文。
7. 决定是否公开发布 `@seekforge/core`；若发布，则补齐编译产物、
   受支持的入口点、示例、semver 政策与 API 兼容性测试。

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
