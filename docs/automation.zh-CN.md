# 事件触发的自动化（webhook）

> [English](automation.md) | **简体中文**

SeekForge 的服务器可以在**外部事件**到达时运行任务——GitHub 的 push 或 pull request、CI 作业完成，或任何能发送 HTTP POST 的系统。这是[定时任务](scheduling.zh-CN.md)的 webhook 对应物：调度按时钟触发，而*触发器（trigger）*按事件触发。

触发器注册在**服务器**上（不是 CLI 调度器），存放在工作区的 `.seekforge/triggers.json` 中。当其 endpoint 被携带有效凭证调用时，服务器会启动一次**无头（headless）、成本受限**的 agent 运行来执行触发器的任务，并返回新会话的 id。

每次被触发的运行都是一个**普通的、可审计的会话**——它写入与交互式运行完全相同的 JSONL 追踪记录，可以用 `seekforge replay <id>` 回放、用 `seekforge audit <id>` 审阅、用 `seekforge rewind <id>` 撤销。

运行发生在哪里取决于隔离方式，但追踪记录最终总会落在你查找它的地方。`ask` 触发器（以及任何显式设为 `isolation: "workspace"` 的触发器）在工作区内运行并把追踪写在那里。`edit` 触发器通常在自己的 git worktree 中运行（见下文第 4 条），运行期间把追踪写在该 worktree 里；运行结束时，服务器会把这次运行产生的每个会话——它自身的，以及它派发的子 agent 会话——复制到基工作区的 `.seekforge/sessions/` 下。通过 `POST /api/runs` 启动的后台运行同样如此，无论是 agent 还是 Loop：凡是在 worktree 中执行的运行，其追踪都会落到持有该运行 ledger 的检出里。因此即使该 worktree 之后被合并或丢弃（`DELETE /api/worktrees/:id`，过去这会连审计线索一起删掉），在**基仓库**中执行 `seekforge sessions`、`seekforge audit <id>`、`seekforge replay <id>` 依然能找到这次运行。run ledger 无论如何都留在基工作区：`GET /api/runs`（或 `.seekforge/runs.jsonl`）给出 `runId`、`sessionId` 以及 `worktreeId`/`worktreeBranch` 标签——而这个 `sessionId` 现在指向的是基检出可以打开的会话。

这次复制被刻意限制得很窄：只按名字复制已知的追踪文件（`session.json`、`messages.jsonl`、`tool-calls.jsonl`、`events.jsonl`、`checkpoints.jsonl`、`compaction.json`、`summary.md`），只复制运行开始时还不存在的会话，并且绝不覆盖基检出中已存在的会话 id——被隔离的运行既不能把自选文件写进基工作区的会话目录，也不能改写更早那次运行的记录。

但它**不能**证明被复制过来的会话确实出自 agent 循环。新建的 worktree 里没有 `.seekforge/`，因此运行往里写的任何能被解析为会话的东西都会被带过去，而且没有任何不可伪造的依据可供过滤——反正整份追踪本来就由 agent 进程写入，想记录假内容，在它自己那份真实会话里就能记。请把一次运行的追踪理解为「该次运行对自己的陈述」，这本来就是会话追踪的含义。复制由服务器在运行结束后完成：运行本身不会因此获得对基检出的任何访问权限。凡是无法复制过去的内容（id 已被占用、文件不可读、单次运行超过 64 个会话或 256 MiB 追踪）都会作为**一条**汇总的 warning `notice` 帧记录在该 run 上，可通过 `GET /api/runs/:id/events` 读到，而不是被悄悄丢弃。触及上限的运行丢失的是派发出去的子会话追踪，而不是它自己的——run ledger 指向的那个会话会最先复制。这个排序需要知道 id，因此对「在报告出 id 之前就失败或被取消」的运行不适用，那种情况下上限按创建顺序生效。

## 安全为先

webhook 可能被外部系统在无人盯守的情况下调用，因此被触发的运行有四重锁定：

1. **认证投递。** 通用调用方使用服务器 bearer token 加上该触发器的独立 secret。原生 GitHub webhook 则改为用该触发器 secret 对请求体逐字节签名并发送 `X-Hub-Signature-256`；它不需要发明自定义的 GitHub header，也不需要暴露服务器 bearer token。secret 比较采用常量时间算法。
2. **每次运行都有上限——能按成本就按成本，不能就按 token。** 每个触发器都必须提供 `maxCostUsd`，缺少它的触发器在**创建时即被拒绝**。一旦累计花费达到预算，运行就会平缓终止（追踪记录会保留）。但在没有价目表的 provider 上这个预算是空转的：成本恒报 0，永远达不到预算。与定价无关、始终成立的保证是每次被触发的运行有一个 **800 万累计 token**（提示 + 补全）的硬上限，达到即以同样平缓的方式中止。若希望你填写的美元数字才是真正生效的那个上限，请在配置中设置 `modelPricing`。
3. **运行是无头的。** 被触发的运行与交互式运行使用同一引擎，但处于机器（非交互）模式：agent 的审批回调会**自动拒绝**一切原本需要弹出提示的操作。危险命令保持被拒，命令执行 / 环境变更一律拒绝（没有人来批准它们，而被触发的运行绝不能挂起等待输入）。`edit` 类触发器运行在 *acceptEdits* 模式下，普通的工作区内文件编辑可以自主进行；风险更高的一切仍被拒绝。`ask` 触发器完全不放宽权限——它是只读的，任何需要确认的操作都会被拒绝。
4. **可写运行默认隔离。** `edit` 触发器默认使用 `isolation: "auto"`：在 Git 仓库中，SeekForge 会创建独立 worktree/分支，并把其 id 写进 run label，便于之后审阅和合并；非 Git 工作区则回退到串行的原工作区执行。显式设为 `"workspace"` 可关闭隔离，设为 `"worktree"` 则要求必须成功隔离，否则直接失败。

## 触发器格式

触发器存放在 `.seekforge/triggers.json` 中（工作区作用域，因含有 secret 而以仅属主可读写的 `0600` 权限写入）。每个触发器形如：

```jsonc
[
  {
    "id": "ci-review",             // stable id; also the URL segment
    "task": "Review the latest push and flag any regressions.",
    "mode": "edit",                // "ask" (read-only) or "edit" (may edit files)
    "isolation": "auto",           // optional: auto | workspace | worktree
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
| `POST /api/triggers` | 创建触发器（缺少 `maxCostUsd`/`secret` 返回 `400`；id 已存在返回 `409`）。返回 `201`。 |
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

去重存储另有**每工作区最多记住 10,000 条投递**的硬上限；超出后会优先丢弃最快过期的条目。因此在 webhook 流量持续很高时，某个 delivery id 可能在 24 小时未满时就被遗忘，此时对它的重投递会再次触发运行。去重是尽力而为的重复抑制，不是事务级的 exactly-once 承诺。

可选的 JSON 请求体（例如 GitHub webhook payload）会被提炼成一段简短摘要——action、仓库、ref、PR/issue 编号 + 标题、发起者、head commit——并追加到任务描述中，让本次运行拥有上下文。请求体上限为 25 MiB（GitHub 自身的 webhook 上限），超出返回 `413`。追加到任务里的摘要另有远为严格的长度限制，未知结构只贡献其顶层键名（不含值）。

成功时服务器立即返回 `202 Accepted`，携带新的 run id 与会话 id；运行在后台继续：

```json
{ "runId": "run-lz4k9x-3f8a1c2b5d6e", "sessionId": "20260703-...-ab12", "triggerId": "ci-review" }
```

`runId` 是在 ledger 中定位这次运行的键（`GET /api/runs/:id`、`.seekforge/runs.jsonl`）——包括它的最终状态、成本，以及查找 worktree 隔离运行的追踪记录所需的隔离标签。

响应码：`202` 已触发 · `400` 请求体畸形或 GitHub 事件元数据无效 · `401` 通用请求的服务器 token 错误或缺失 · `403` 触发器 secret 或 GitHub 签名错误 · `404` 触发器不存在 · `409` 触发器已禁用或 GitHub 投递重复 · `413` 请求体超过 25 MiB · `500` 运行未能启动（已认领的 GitHub delivery id 会被释放，以便重投递重试）。

注意：携带 GitHub 形状 header（`X-Hub-Signature-256` 或 `X-GitHub-Delivery`）的请求永远不会得到 `404`：未知的触发器 id 与签名错误一样返回 `403`，因此未认证的调用方无法探测存在哪些触发器 id。

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

   **不要在通用调用上带 GitHub 的 header。** 只要请求携带了 `X-Hub-Signature-256` *或* `X-GitHub-Delivery`，它就会被当作原生 GitHub 投递处理，必须带有对请求原始字节计算的有效 `X-Hub-Signature-256`——正确的 bearer token 和触发器 secret 也救不了它，结果是 `403`。这一点最常咬到会转发 `X-GitHub-Delivery` 却重新签名或丢掉签名的中继/代理：要么两个 header 都原样转发，要么两个都不转发。

## 暴露到公网

服务器只绑定 `127.0.0.1`，因此按设计触发器无法从公网直接访问。要接收真实的 GitHub/CI webhook，请在前面架设一个由你掌控的反向代理或隧道。转发 GitHub 的签名、delivery、event 和 content-type header 时不要改写请求体；HMAC 验证依赖逐字节一致。通用调用方还必须转发 bearer 和触发器 secret 两个 header——并且不能被额外加上 GitHub 的签名或 delivery header，否则会被推到只认签名的那条路径上。有了每触发器独立的 secret，URL 泄露本身既无法触发运行，也无法访问管理 endpoint。轮换 secret 的方式是 `DELETE` 后重新创建触发器（或编辑 `triggers.json` 后重启）。
