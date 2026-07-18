# 事件触发的自动化（webhook）

> [English](automation.md) | **简体中文**

SeekForge 的服务器可以在**外部事件**到达时运行任务——GitHub 的 push 或 pull request、CI 作业完成，或任何能发送 HTTP POST 的系统。这是[定时任务](scheduling.zh-CN.md)的 webhook 对应物：调度按时钟触发，而*触发器（trigger）*按事件触发。

触发器注册在**服务器**上（不是 CLI 调度器），存放在工作区的 `.seekforge/triggers.json` 中。当其 endpoint 被携带有效凭证调用时，服务器会启动一次**无头（headless）、成本受限**的 agent 运行来执行触发器的任务，并返回新会话的 id。

每次被触发的运行都是一个**普通的、可审计的会话**——它写入与交互式运行完全相同的 JSONL 追踪记录，因此会出现在 `seekforge sessions` 里，可以用 `seekforge replay <id>` 回放、用 `seekforge audit <id>` 审阅、用 `seekforge rewind <id>` 撤销。

## 安全为先

webhook 可能被外部系统在无人盯守的情况下调用，因此被触发的运行有三重锁定：

1. **认证投递。** 通用调用方使用服务器 bearer token 加上该触发器的独立 secret。原生 GitHub webhook 则改为用该触发器 secret 对请求体逐字节签名并发送 `X-Hub-Signature-256`；它不需要发明自定义的 GitHub header，也不需要暴露服务器 bearer token。secret 比较采用常量时间算法。
2. **成本预算是强制的。** 每个触发器都必须提供 `maxCostUsd`。一旦累计花费达到预算，运行就会平缓终止（追踪记录会保留）。没有预算的触发器在**创建时即被拒绝**——不存在注册一个无上限触发器的途径。
3. **运行是无头的。** 被触发的运行与交互式运行使用同一引擎，但处于机器（非交互）模式：agent 的审批回调会**自动拒绝**一切原本需要弹出提示的操作。危险命令保持被拒，命令执行 / 环境变更一律拒绝（没有人来批准它们，而被触发的运行绝不能挂起等待输入）。`edit` 类触发器运行在 *acceptEdits* 模式下，普通的工作区内文件编辑可以自主进行；风险更高的一切仍被拒绝。

## 触发器格式

触发器存放在 `.seekforge/triggers.json` 中（工作区作用域，因含有 secret 而以仅属主可读写的 `0600` 权限写入）。每个触发器形如：

```jsonc
[
  {
    "id": "ci-review",             // stable id; also the URL segment
    "task": "Review the latest push and flag any regressions.",
    "mode": "edit",                // "ask" (read-only) or "edit" (may edit files)
    "maxCostUsd": 0.5,             // REQUIRED hard cost cap (USD)
    "secret": "a-long-random-shared-token", // REQUIRED; min 8 chars
    "enabled": true                // optional; defaults to true
  }
]
```

- `maxCostUsd` 和 `secret` 均为**必填**；缺少任一项的触发器会被拒绝。
- **不要**把真实 secret 硬编码进文档或提交记录——生成一个（例如 `openssl rand -hex 24`），存放在你的 webhook 配置所在之处。

## Endpoint

管理 endpoint 位于 `/api` 之下，需要服务器 bearer token。所有响应中的 secret 都会被**掩码**（`"***"`）。触发（fire）路由额外接受一个签名正确的原生 GitHub 投递而无需 bearer token；这是唯一的认证例外。

| 方法 + 路径 | 用途 |
| --- | --- |
| `GET /api/triggers` | 列出触发器（secret 已掩码）。 |
| `POST /api/triggers` | 创建触发器（缺少 `maxCostUsd`/`secret` 会被拒绝）。返回 `201`。 |
| `DELETE /api/triggers/:id` | 删除触发器。 |
| `POST /api/triggers/:id` | **触发**——启动一次无头运行。返回 `202`。 |

工作区通过 `?ws=<id>` 选择，与其他所有工作区作用域路由一致（默认第一个工作区）。

### 触发一个 trigger

对于通用的 CI 或服务调用方，`POST /api/triggers/:id` **同时**需要：

- 服务器 bearer token（`Authorization: Bearer <token>`），以及
- 触发器 secret，通过 `x-seekforge-trigger-secret` header **或** `?secret=` 查询参数传入。

对于原生 GitHub webhook，把触发器的 `secret` 配置为 GitHub 的 webhook secret。GitHub 会发送：

- `X-Hub-Signature-256: sha256=<HMAC>`，针对请求的原始字节计算，
- `X-GitHub-Delivery: <unique-delivery-id>`，以及
- `X-GitHub-Event: <event-name>`。

签名有效的 GitHub 请求不需要服务器 bearer token 或 `x-seekforge-trigger-secret`。接受的事件为 `push`、`pull_request`、`issues`、`issue_comment` 和 `workflow_run`。投递按工作区、触发器和 delivery ID 去重，去重窗口 24 小时；重复投递返回 `409`。持久 claim 由跨进程工作区 lease 保护，因此共享同一工作区的两个 Server 实例也不能同时接受同一投递。

可选的 JSON 请求体（例如 GitHub webhook payload）会被提炼成一段简短摘要——action、仓库、ref、PR/issue 编号 + 标题、发起者、head commit——并追加到任务描述中，让本次运行拥有上下文。请求体大小有上限；未知结构只贡献其顶层键名（不含值）。

成功时服务器立即返回 `202 Accepted` 与新会话 id；运行在后台继续：

```json
{ "sessionId": "20260703-...-ab12", "triggerId": "ci-review" }
```

响应码：`202` 已触发 · `400` 请求体畸形或 GitHub 事件元数据无效 · `401` 通用请求的服务器 token 错误或缺失 · `403` 触发器 secret 或 GitHub 签名错误 · `404` 触发器不存在 · `409` 触发器已禁用或 GitHub 投递重复。

## 把 GitHub / CI webhook 指过来

1. 创建触发器：

   ```bash
   curl -sS -X POST "http://127.0.0.1:7373/api/triggers" \
     -H "Authorization: Bearer $SEEKFORGE_TOKEN" \
     -H "content-type: application/json" \
     -d '{"id":"ci-review","task":"Review the latest push.","mode":"ask","maxCostUsd":0.5,"secret":"'"$TRIGGER_SECRET"'"}'
   ```

2. 对 GitHub：把 payload URL 设为触发 endpoint，内容类型选 JSON，并在 GitHub 的 **Secret** 一栏填入与触发器 `secret` 相同的值。只勾选受支持的事件。SeekForge 会验证 GitHub 原生的 `X-Hub-Signature-256`，要求其 delivery / event header，并拒绝重复投递。不需要自定义的 `Authorization` 或 `x-seekforge-trigger-secret` header。

3. 通用 CI 作业保留双 secret 模式，直接 `curl` 即可：

   ```bash
   curl -X POST "http://127.0.0.1:7373/api/triggers/ci-review" \
     -H "Authorization: Bearer $SEEKFORGE_TOKEN" \
     -H "x-seekforge-trigger-secret: $TRIGGER_SECRET" \
     -H "content-type: application/json" \
     --data-binary @event.json
   ```

## 暴露到公网

服务器只绑定 `127.0.0.1`，因此按设计触发器无法从公网直接访问。要接收真实的 GitHub/CI webhook，请在前面架设一个由你掌控的反向代理或隧道。转发 GitHub 的签名、delivery、event 和 content-type header 时不要改写请求体；HMAC 验证依赖逐字节一致。通用调用方还必须转发 bearer 和触发器 secret 两个 header。有了每触发器独立的 secret，URL 泄露本身既无法触发运行，也无法访问管理 endpoint。轮换 secret 的方式是 `DELETE` 后重新创建触发器（或编辑 `triggers.json` 后重启）。
