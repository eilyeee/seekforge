# 安全扫描

> [English](security-scanning.md) | **简体中文**

SeekForge 可以运行仓库级的只读 Agent 审查，并维护一个可审计的 Finding 队列。扫描器覆盖架构、信任边界、入口点、认证与授权、命令与文件系统访问、解析、持久化、网络、secret、依赖，以及安全测试。

## 快速上手

```sh
seekforge security scan
seekforge security list --severity high
seekforge security show sf-0123456789abcdef
seekforge security status sf-0123456789abcdef triaged --reason "confirmed reachable"
seekforge security fix sf-0123456789abcdef --max-cost 1.00
seekforge security verify sf-0123456789abcdef
seekforge security threat-model
seekforge security export --format sarif -o reports/security.sarif
```

`scan` 与 `threat-model` 使用已配置的 provider，是计费的 Agent 运行。`fix` 要求一个明确的正数成本预算。它走常规的 Agent 权限路径，运行已配置的 `verifyCommand` 与 `lintCommand` 检查，然后再执行一次安全扫描。

## Finding 队列

只追加（append-only）的事实来源是：

```text
.seekforge/security/events.jsonl
```

该目录以 `0700` 模式创建，JSONL 文件以 `0600` 模式创建。当前的 Finding、扫描、修复与威胁模型视图均由事件重建；旧事件不会被改写。

Finding 的生命周期状态为：

```text
open -> triaged -> fixing -> resolved
  \         \          \-> accepted_risk
   \         \----------> dismissed
    \--------------------> accepted_risk / dismissed

resolved / accepted_risk / dismissed -> reopened
```

验证状态独立于生命周期：`unverified`、`verified`、`failed` 或 `stale`。把一个 Finding 改为 `resolved` 并不能证明修复有效。若之后的扫描再次检出一个已 resolved 的 Finding，它会被重新打开，且先前的验证会变为 stale。

## 验证规则

自动修复只有在以下条件全部成立时才会标记为 `verified`：

1. Agent 编辑运行已完成。
2. 每个已配置的项目 verify/lint 命令都成功退出。
3. 新一次扫描不再包含目标 Finding 的指纹。
4. 新一次扫描没有引入严重程度等于或高于目标 Finding 的新 Finding。

命令、退出状态、时长、超时状态与有界的 stdout/stderr 都记录在修复事件中。至少必须配置一个项目级 `verifyCommand` 或 `lintCommand`；没有它，验证会失败关闭（fail closed），任何重新扫描都无法将 Finding 提升为 `verified`。命令使用已配置的 OS 沙箱，超时会终止其完整的进程组。

## 证据与提示注入防御

仓库内容与工具输出都被视为不可信数据。扫描器输出必须是恰好一个符合 Core schema 的 JSON 对象。未知字段、markdown 包装、格式非法的值、绝对路径或逃逸路径、不存在的文件、无效的行号范围，以及未在被引用源码行中出现的摘录，都会被拒绝。原始模型响应绝不持久化。

存储的文本与命令输出有长度限制，常见的 secret 格式会被打码。证据路径为仓库相对路径，并使用与 Core 工具相同的、symlink 感知的工作区边界解析。不要仅因为一个 LLM Finding 通过了结构校验就认定它成立；需要人工分诊其可达性与影响。

## 威胁模型

`seekforge security threat-model` 记录资产、入口点、信任边界、数据流、威胁场景、缓解措施与源码位置。每一项都必须引用至少一个真实的仓库文件与有效的行号范围。威胁模型是历史事件；生成新模型不会覆盖之前的模型。

## 导出格式

`security export` 支持：

- `json`：完整的证据包，包含事件与派生记录。
- `markdown`：供人工审阅的报告，含 Finding 证据、验证命令结果、
  修复尝试与展开的威胁场景。
- `sarif`：SARIF 2.1.0，用于 code-scanning 与归档系统。

用 `-o/--output` 写入工作区内；导出文件的模式为 `0600`。不带 `--output` 时，所选格式写到 stdout。

导出是合规证据包。它们不是认证，也不保证仓库没有漏洞或符合某个特定框架。

## 命令参考

| 命令 | 用途 |
| --- | --- |
| `security scan [--max-findings N] [--json]` | 运行一次深度只读 Agent 扫描，并追加通过校验的 Finding。 |
| `security list [--status S] [--severity S] [--json]` | 查询当前 Finding 队列。 |
| `security show <id> [--json]` | 显示单个 Finding 及其证据。 |
| `security status <id> <status> [--reason TEXT]` | 记录一次合法的生命周期转换。 |
| `security fix <id> --max-cost USD [-y]` | 修复、运行检查、重新扫描，并记录本次尝试。 |
| `security verify <id>` | 运行检查并重新扫描，不要求 Agent 做编辑。 |
| `security threat-model [--json]` | 生成有证据支撑的威胁模型。 |
| `security export --format json\|markdown\|sarif [-o PATH]` | 渲染证据包。 |

`scan`、`fix`、`verify` 与 `threat-model` 均接受 `-m/--model`。

## 桌面端 Security Center

桌面端侧边栏在 **Security** 下暴露同一套按仓库隔离的证据存储。它支持深度扫描、Finding 检查与生命周期变更、经验证的自动修复、威胁模型生成，以及 JSON、Markdown 或 SARIF 导出。切换工作区会重新加载所选仓库的队列；工作区之间不共享任何安全状态。

自动修复需要一个明确的正数 Agent 成本上限、一个 verify 命令，以及可选的 lint 命令。桌面端按照与上述 CLI 相同的规则，独立展示由此产生的生命周期与验证状态。MCP 凭据与命令输出在 REST 响应和导出的证据中始终保持打码或脱敏。
