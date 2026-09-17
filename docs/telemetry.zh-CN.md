# 遥测（OpenTelemetry 导出）

> [English](telemetry.md) | **简体中文**

SeekForge 可以把使用指标和事件发送到你自己的 OpenTelemetry 采集器，让团队看到
每台运行 agent 的机器上的 token 用量、成本、工具审批与失败情况。它**默认关闭**，
也不会向 SeekForge 或任何第三方发送数据：数据只会发往你配置的端点。

导出方式是基于 HTTP、请求体为 JSON 的 OTLP，实现不引入任何额外依赖。它只能通过
环境变量配置——仓库里的配置文件既不能开启它，也不能决定数据发往哪里。

## 开启

```bash
export SEEKFORGE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # 默认值
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20my-token"
seekforge run "fix the flaky test"
```

它对所有运行 agent 的界面都生效：`seekforge run`/`ask`/REPL、TUI、
`seekforge serve`（以及经由它的 Desktop），还有定时任务。`seekforge serve` 停止时会导出
仍未发送的记录，最多等待采集端 5 秒。

## 环境变量

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `SEEKFORGE_ENABLE_TELEMETRY` | 设为 `1` 或 `true` 开启导出，其他值都保持关闭。 | 关闭 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 采集器的基础 URL；会在其路径后追加 `/v1/metrics` 与 `/v1/logs`。 | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 指标的完整 URL，按原样使用（覆盖基础 URL）。 | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | 事件的完整 URL，按原样使用（覆盖基础 URL）。 | — |
| `OTEL_EXPORTER_OTLP_HEADERS` | 额外的请求头，逗号分隔的 `key=value` 对，需百分号编码（`authorization=Bearer%20token`）。格式错误的条目会被跳过；请求头的值永远不会被打印。 | — |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | 只支持 `http/json`。其他取值（`grpc`、`http/protobuf`）会让导出**关闭**，`seekforge doctor` 会说明原因——SeekForge 不会发送采集器没有要求的格式。 | `http/json` |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | 单次请求超时，单位毫秒（100 – 60000）。 | `10000` |
| `OTEL_METRIC_EXPORT_INTERVAL` | 指标导出间隔，单位毫秒（至少 1000）。 | `60000` |
| `OTEL_BLRP_SCHEDULE_DELAY` | 排队事件的导出间隔，单位毫秒（至少 1000）。 | `5000` |
| `OTEL_METRICS_EXPORTER` | `otlp`，或设为 `none` 不发送指标。不支持其他导出器，设置后指标关闭。 | `otlp` |
| `OTEL_LOGS_EXPORTER` | `otlp`，或设为 `none` 不发送事件。不支持其他导出器，设置后事件关闭。 | `otlp` |
| `OTEL_RESOURCE_ATTRIBUTES` | 额外的资源属性，逗号分隔的 `key=value` 对（例如 `team=platform,deployment.environment=ci`）。 | — |
| `OTEL_SERVICE_NAME` | 覆盖 `service.name`。 | `seekforge` |
| `OTEL_LOG_USER_PROMPTS` | 设为 `1` 时，`user_prompt` 事件会包含提示词原文（最多 64,000 个字符）。不设置时只发送长度。 | 关闭 |

每次导出都带有资源属性 `service.name`、`service.version`、`os.type`、
`os.version` 与 `host.arch`，以及你设置的属性。

访问采集器与 provider 请求走同一条网络路径，因此已配置的 `HTTPS_PROXY` 同样适用——见
[代理与自定义证书颁发机构](configuration.zh-CN.md#代理与自定义证书颁发机构)。
位于 `localhost` 的采集器保持直连。

## 指标

所有指标都是累积型的单调递增和（cumulative monotonic sum）。

| 指标 | 单位 | 属性 | 统计内容 |
| --- | --- | --- | --- |
| `seekforge.session.count` | 1 | — | 启动的顶层 agent 会话数（子 agent 的运行属于其父会话）。 |
| `seekforge.token.usage` | tokens | `type`、`model` | 每次请求的 token 数。`type` 为 `input`（未命中缓存的提示）、`output`、`cacheRead`、`cacheCreation` 或 `reasoning`（`output` 中用于推理的部分，provider 有报告时才有）。 |
| `seekforge.cost.usage` | USD | `model` | 估算的请求成本，与 SeekForge 显示的成本口径一致。 |
| `seekforge.lines_of_code.count` | 1 | `type`（`added` / `removed`） | 成功的 `apply_patch` 与 `write_file` 调用改动的行数。用 `write_file` 覆盖文件时，新内容计为新增，不计删除。 |
| `seekforge.tool.decision` | 1 | `tool_name`、`decision`、`source` | 权限决策。`decision` 为 `accept` 或 `reject`；`source` 为 `user`、`user_session`（之前选择过「不再询问」）、`config`（权限规则或命令放行清单）、`mode`（审批模式或计划模式）、`readonly`（只读工具，从不询问）或 `policy`（危险命令，从不执行）。 |
| `seekforge.active_time.total` | s | — | 顶层 agent 运行所花的实际时间。 |

每个进程最多保留 1,024 个不同的属性组合；超出后新的序列不再记录，因此行为异常的
MCP 服务器提供的工具列表也无法让内存无限增长。

## 事件

事件以 OTLP 日志记录的形式发送。每条都有 `event.name` 属性，正文与之同名。

| 事件 | 属性 |
| --- | --- |
| `seekforge.user_prompt` | `session.id`、`prompt_length`；仅在 `OTEL_LOG_USER_PROMPTS=1` 时附带 `prompt` |
| `seekforge.api_request` | `session.id`（请求属于某个 agent 回合时）、`model`、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_creation_tokens`、`reasoning_tokens`（有报告时）、`cost_usd`、`duration_ms` |
| `seekforge.api_error` | `session.id`（已知时）、`model`、`error`（错误信息，最多 1,024 个字符）、`status_code`（HTTP 错误时）、`duration_ms` |
| `seekforge.tool_result` | `session.id`、`tool_name`、`success`、`duration_ms`、`decision` 与 `decision_source`（调用走到了权限检查时）、`error_code`（失败时） |

**不会**发送的内容：工具参数与结果、文件内容、命令、路径、模型输出，以及——除非你
主动开启——提示词。`api_error` 的信息是 provider 的错误文本，其中绝不包含 API key。
被取消的请求不算错误。

## 投递

遥测的设计保证它不会拖慢或破坏一次运行：

- 记录发生在内存中且是同步的，不会等待网络。
- 事件在一个最多 2,048 条的队列中等待（满了会丢弃最旧的），每批最多发送 512 条。
- 每种信号同一时间只有一个请求在途，各自使用配置的超时。遇到 `429`、`502`、`503`
  或 `504` 时这一批会保留到下次重试；其他失败则丢弃。指标是累积值，所以一次失败的
  指标导出会直接被下一次取代。
- 导出失败永远不会抛到运行中，也不会被打印。
- 定时器不会让进程保持存活。进程即将自行退出时会把待发送的数据发出去。收到
  `SIGINT`/`SIGTERM` 时也会开始发送，但立即退出的界面可能会把它打断；被直接杀掉的
  进程会丢失仍在队列中的数据——最多一个导出间隔的量。

## 检查

`seekforge doctor` 会显示导出是否开启、发往哪里（不含凭据与查询字符串），以及在设置了
`SEEKFORGE_ENABLE_TELEMETRY` 却被其他设置关闭时的原因。

在本地快速验证，可以使用带 OTLP HTTP receiver 与 `debug` exporter 的
OpenTelemetry Collector：

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 127.0.0.1:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    metrics: { receivers: [otlp], exporters: [debug] }
    logs: { receivers: [otlp], exporters: [debug] }
```
