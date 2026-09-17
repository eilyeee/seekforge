# Telemetry (OpenTelemetry export)

> **English** | [简体中文](telemetry.zh-CN.md)

SeekForge can send usage metrics and events to your own OpenTelemetry collector,
so a team can see token use, cost, tool approvals, and failures across every
machine that runs the agent. It is **off by default** and sends nothing to
SeekForge or anyone else: data goes only to the endpoint you configure.

Export is OTLP over HTTP with JSON bodies, implemented without extra
dependencies. It is configured from the environment only — a repository's
config files cannot turn it on or choose where the data goes.

## Turning it on

```bash
export SEEKFORGE_ENABLE_TELEMETRY=1
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # the default
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20my-token"
seekforge run "fix the flaky test"
```

It applies to every surface that runs the agent: `seekforge run`/`ask`/REPL,
the TUI, `seekforge serve` (and Desktop through it), and scheduled runs.
`seekforge serve` exports what is still pending when it shuts down, waiting at
most 5 seconds for the collector.

## Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `SEEKFORGE_ENABLE_TELEMETRY` | `1` or `true` turns export on. Anything else leaves it off. | off |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of the collector; `/v1/metrics` and `/v1/logs` are appended to its path. | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Full URL for metrics, used as given (overrides the base). | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Full URL for events, used as given (overrides the base). | — |
| `OTEL_EXPORTER_OTLP_HEADERS` | Extra request headers, `key=value` pairs separated by commas, percent-encoded (`authorization=Bearer%20token`). Malformed entries are skipped; header values are never printed. | — |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Only `http/json` is supported. Any other value (`grpc`, `http/protobuf`) turns export **off** and `seekforge doctor` says why — SeekForge will not send a format the collector did not ask for. | `http/json` |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Per-request timeout in milliseconds (100 – 60000). | `10000` |
| `OTEL_METRIC_EXPORT_INTERVAL` | How often metrics are exported, in milliseconds (at least 1000). | `60000` |
| `OTEL_BLRP_SCHEDULE_DELAY` | How often queued events are exported, in milliseconds (at least 1000). | `5000` |
| `OTEL_METRICS_EXPORTER` | `otlp`, or `none` to send no metrics. Other exporters are not supported and turn metrics off. | `otlp` |
| `OTEL_LOGS_EXPORTER` | `otlp`, or `none` to send no events. Other exporters are not supported and turn events off. | `otlp` |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes, `key=value` pairs separated by commas (for example `team=platform,deployment.environment=ci`). | — |
| `OTEL_SERVICE_NAME` | Overrides `service.name`. | `seekforge` |
| `OTEL_LOG_USER_PROMPTS` | `1` includes the prompt text in `user_prompt` events (up to 64,000 characters). Without it only the length is sent. | off |

Every export carries the resource attributes `service.name`, `service.version`,
`os.type`, `os.version`, and `host.arch`, plus yours.

The collector is reached through the same network path as provider requests,
so a configured `HTTPS_PROXY` applies — see
[Proxies and custom certificate authorities](configuration.md#proxies-and-custom-certificate-authorities).
A collector on `localhost` stays direct.

## Metrics

All metrics are cumulative monotonic sums.

| Metric | Unit | Attributes | Counts |
| --- | --- | --- | --- |
| `seekforge.session.count` | 1 | — | Top-level agent sessions started (subagent runs are part of their parent's session). |
| `seekforge.token.usage` | tokens | `type`, `model` | Tokens per request. `type` is `input` (uncached prompt), `output`, `cacheRead`, `cacheCreation`, or `reasoning` (the reasoning share of `output`, where the provider reports it). |
| `seekforge.cost.usage` | USD | `model` | Estimated request cost, on the same basis as the cost SeekForge shows. |
| `seekforge.lines_of_code.count` | 1 | `type` (`added` / `removed`) | Lines changed by successful `apply_patch` and `write_file` calls. An overwrite with `write_file` counts its new content as added and nothing as removed. |
| `seekforge.tool.decision` | 1 | `tool_name`, `decision`, `source` | Permission decisions. `decision` is `accept` or `reject`; `source` is `user`, `user_session` (an earlier "don't ask again"), `config` (a permission rule or command allowlist), `mode` (the approval or plan mode), `readonly` (read-only tools, never prompted), or `policy` (a dangerous command, never run). |
| `seekforge.active_time.total` | s | — | Wall-clock time top-level agent runs spent running. |

At most 1,024 distinct attribute combinations are kept per process; beyond that
new series are not recorded, so a tool list from a misbehaving MCP server cannot
grow memory without bound.

## Events

Events are OTLP log records. Each has an `event.name` attribute and the same
name as its body.

| Event | Attributes |
| --- | --- |
| `seekforge.user_prompt` | `session.id`, `prompt_length`, and `prompt` only with `OTEL_LOG_USER_PROMPTS=1` |
| `seekforge.api_request` | `session.id` (when the request belongs to an agent turn), `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `reasoning_tokens` (when reported), `cost_usd`, `duration_ms` |
| `seekforge.api_error` | `session.id` (when known), `model`, `error` (the message, up to 1,024 characters), `status_code` (for HTTP errors), `duration_ms` |
| `seekforge.tool_result` | `session.id`, `tool_name`, `success`, `duration_ms`, `decision` and `decision_source` (when the call reached a permission check), `error_code` (on failure) |

What is **not** sent: tool arguments and results, file contents, commands,
paths, model output, and — unless you opt in — prompts. An `api_error` message
is the provider's error text, which never contains the API key. A cancelled
request is not an error.

## Delivery

Telemetry is built so that it cannot slow down or break a run:

- Recording is in-memory and synchronous; nothing waits on the network.
- Events wait in a queue of at most 2,048 records (the oldest are dropped when
  it is full) and go out in batches of up to 512.
- One request per signal is in flight at a time, each with the configured
  timeout. A `429`, `502`, `503`, or `504` keeps the batch for the next
  attempt; any other failure drops it. Metrics are cumulative, so a failed
  metrics export is simply superseded by the next one.
- Export failures are never raised into the run and never printed.
- Timers do not keep a process alive. Pending data is flushed when the process
  is about to exit on its own. A flush also starts on `SIGINT`/`SIGTERM`, but a
  surface that exits at once may cut it short, and a process killed outright
  loses what was still queued — up to one export interval of data.

## Checking it

`seekforge doctor` shows whether export is on and where it goes (without
credentials or query strings), and why it is off when
`SEEKFORGE_ENABLE_TELEMETRY` is set but another setting disables it.

A quick local check is the OpenTelemetry Collector with an OTLP HTTP receiver
and the `debug` exporter:

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
