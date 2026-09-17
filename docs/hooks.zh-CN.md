# Hook

> [English](hooks.md) | **简体中文**

Hook 是你配置的程序，在一次智能体运行的固定时点执行：每次工具调用之前和之后、权限提示即将出现时、会话开始或结束时、上下文压缩前后，以及智能体即将结束时。Hook 可以旁观、为模型补充上下文、拒绝某个动作、代你回答权限提示，或者让智能体继续工作。

Hook **归用户所有**。它们来自 `~/.seekforge/config.json`、显式的 `--settings` 文件，或已启用的[插件](plugins.zh-CN.md)；仓库里的 `.seekforge/config.json` 无法新增或修改 hook。桌面端的 hook 编辑器写入的是用户配置。

## 配置 hook

```json
{
  "hooks": {
    "preToolUse": [
      { "match": "run_command", "pattern": "npm publish", "command": "echo 'no publishing' >&2; exit 1" },
      { "match": "write_file|apply_patch", "type": "http", "url": "http://127.0.0.1:8787/review", "timeout": 5 }
    ],
    "stop": [
      { "type": "prompt", "prompt": "Did the agent run the tests after its last edit? $ARGUMENTS" }
    ],
    "sessionEnd": [{ "command": "notify-send 'SeekForge session ended'" }]
  }
}
```

每个阶段是一组条目，按顺序依次执行。条目字段如下：

| 字段 | 适用类型 | 含义 |
| --- | --- | --- |
| `type` | 全部 | `"command"`（默认）、`"http"` 或 `"prompt"`。 |
| `match` | 全部 | 该 hook 针对哪些调用（见[匹配器](#匹配器)）。缺省、`""` 或 `"*"` 表示全部。 |
| `pattern` | 全部 | 调用的原始命令（shell 类工具）或路径（文件类工具）的前缀，按单词 / 路径边界匹配。缺省表示任意。 |
| `timeout` | 全部 | 超过该秒数即放弃，`0 < timeout ≤ 600`。默认 10（`prompt` 为 30）。超时视为失败。 |
| `command` | command | shell 命令，在工作区内以 `/bin/sh -c`（Windows：`cmd /d /s /c`）执行。 |
| `url` | http | 负载以 POST 发送到的 `http://` 或 `https://` 地址。URL 中不得包含凭据。 |
| `headers` | http | 额外请求头。`${NAME}` 展开为环境变量 `NAME`——前提是它列在 `allowedEnvVars` 中；其他引用展开为空字符串并给出提示。 |
| `allowedEnvVars` | http | `headers` 允许读取的环境变量。 |
| `prompt` | prompt | 交给模型判断的条件。`$ARGUMENTS` 标记事件插入的位置；没有它时，事件追加在末尾。 |
| `model` | prompt | 当前界面能路由到时用于判断的模型；否则使用本次运行的模型。 |

校验不通过的条目——未知的 `type`、缺少 `command`/`url`/`prompt`、非 http 的 URL、超出范围的 `timeout`、不安全的 `match`——会在加载配置时被丢弃，永远不会执行。

### 匹配器

在工具阶段（`preToolUse`、`permissionRequest`、`postToolUse`、`postToolUseFailure`），`match` 与工具名比较；在 `subagentStart` / `subagentStop`，与子智能体 id 比较。其他阶段忽略它。

- 由字母、数字、`_`、`-` 组成并以 `|` 或 `,` 分隔的，是一组精确名称：`write_file|apply_patch`。
- 其余一律视为正则表达式，与**整个**名称匹配：`mcp__github__.*` 匹配该服务器的全部工具，而 `apply.*` 不会匹配 `reapply_patch`。

可能出现病态回溯的正则会被拒绝：自身又重复或含分支的重复分组（`(a+)+`、`(a|b)*`）、反向引用、超过四个重复量词，或超过 256 个字符。

## Hook 类型

所有类型收到的都是同一份 JSON 事件——`{ "stage": …, "sessionId": …, "workspace": …, …阶段字段 }`——并按同一套[输出协议](#输出协议)作答。工具参数、命令、路径和工具输出只会出现在这份 JSON 中，绝不会进入命令行、URL 或请求头。

### `command`

事件经 stdin 送达。看起来像密钥的环境变量会从 hook 的环境中移除，并额外设置：

| 变量 | 值 |
| --- | --- |
| `SEEKFORGE_HOOK_STAGE` | 触发的阶段。 |
| `SEEKFORGE_TOOL` | 工具阶段时为工具名，否则为空。 |
| `SEEKFORGE_PROJECT_DIR` | 会话所在的工作区（也是 hook 的工作目录）。 |

退出码 0 表示成功，stdout 即 hook 的输出。其他退出码表示失败，stdout+stderr 的末尾即失败原因。超时或取消时会杀掉整个进程组。

### `http`

事件作为 POST 请求体发送（`Content-Type: application/json`）。`2xx` 响应的正文即 hook 的输出。其他状态码都算失败，重定向也一样：重定向从不跟随，因为它可能把你的请求头带到另一台主机——请直接配置最终地址。网络错误和超时同样算失败。

### `prompt`

事件以数据形式（带围栏）交给模型，并要求它回答 `{"ok": true}` 或 `{"ok": false, "reason": "…"}`。

- `{"ok": false}` 被读作 `{"decision": "block", "reason": …}`——在 `preToolUse` 上拒绝该调用，在 `stop` 上让智能体继续工作，在 `postToolUse` 上把原因交给模型。
- `{"ok": true}` **不构成任何决定**。模型检查可以拒绝动作，但绝不能让动作越过权限提示。事件中包含智能体及其工具产出的文本，因此应把 prompt hook 当作审阅者而非安全边界——强制策略请用 command hook。
- 回复中没有判定结果即视为失败。
- 检查使用本次会话的 provider（或可路由时使用 `model`），其 token 计入会话的用量与费用——`sessionEnd` 除外，它在会话总量确定之后才执行。没有模型可问的界面——`seekforge mcp-serve`，以及 TUI 和 REPL 的机械式 `/compact`——无法评估 prompt hook：在那里它们会失败。服务端的手动压缩（`POST /api/sessions/:id/compact`，即 Desktop 的 `/compact`）会用已配置的 provider 评估它们。

## 阶段

| 阶段 | 触发时机 | 失败是否拦截？ | 阶段字段 |
| --- | --- | --- | --- |
| `preToolUse` | 每次工具调用前，在策略的绝对拒绝之后、任何权限提示之前 | **是** | `toolName`、`args`、`command`?、`path`? |
| `permissionRequest` | 某次工具调用（或子智能体派发）即将向用户提示 | 否——照常提示 | 工具字段 + `permission`、`description` |
| `postToolUse` | 每次实际执行的工具调用之后 | 否 | 工具字段 + `result` |
| `postToolUseFailure` | `postToolUse` 之后，且工具返回了错误 | 否 | 工具字段 + `result` |
| `sessionStart` | 顶层运行开始（恢复会话时也会触发） | 否 | `task`、`mode`、`resuming` |
| `userPromptSubmit` | 紧随 `sessionStart`，针对该任务 | **是** | `task` |
| `preCompact` | 压缩改写对话之前 | 否 | `reason`（`"auto"` / `"manual"`）、`focus`? |
| `postCompact` | 压缩之后 | 否 | `reason`、`droppedTurns`、`beforeTokens`?、`afterTokens`? |
| `stop` | 顶层智能体即将给出最终回答 | 否 | `summary`、`stopHookActive` |
| `subagentStart` | 某个被派发的子智能体运行即将开始 | 否 | `agentId`、`task` |
| `subagentStop` | 某个被派发的子智能体运行结束 | 否 | `agentId`、`ok` |
| `notification` | 显示权限提示或 `ask_user` 问题时 | 否 | `kind`、`detail` |
| `sessionEnd` | 顶层会话结束（不论状态） | 否 | `status` |

以下情况 hook 视为**失败**：非零退出、非 `2xx` 响应、超时、无法评估，或没有给出判定。在两个拦截阶段，第一个失败会以 hook 的输出为原因拒绝该调用 / 使本次运行失败，该阶段后续的 hook 不再执行。其他阶段的失败只记录到 stderr，运行照常继续。

`sessionStart`、`userPromptSubmit`、`stop` 和 `sessionEnd` 只在顶层运行触发；子智能体运行不会触发它们。

`postToolUse` 和 `postToolUseFailure` 会收到工具的 `result`：`{ "ok", "errorCode", "response", "responseTruncated"? }`。`response` 是工具的数据（或错误），其中每个字符串都经过与命令输出相同的密钥脱敏；超过 16,000 个字符时，它会变成首尾截取的字符串预览，并且 `responseTruncated` 为 `true`。

## 输出协议

成功的 hook 可以输出（或响应）一个 JSON 对象。不是 JSON 对象的内容一律忽略——`userPromptSubmit` 除外，在那里纯文本就是给模型的上下文。字段可以放在顶层；阶段专属字段也会在 `hookSpecificOutput` 下读取。

| 字段 | 阶段 | 作用 |
| --- | --- | --- |
| `systemMessage` | 全部 | 作为提示显示给用户。 |
| `continue: false` | 见下表 | 停止该阶段所守护的事情。 |
| `stopReason` | 与 `continue: false` 同用 | 显示给用户。 |
| `suppressOutput: true` | 全部 | 不把该 hook 的输出放进对话记录（模型仍会收到其上下文）。 |
| `additionalContext` | `sessionStart`、`userPromptSubmit`、`subagentStart`、`postToolUse`、`postToolUseFailure` | 给模型的文本（见下文）。 |
| `permissionDecision` + `permissionDecisionReason`，或 `decision` + `reason` | `preToolUse` | `allow`、`deny`（`block` 等同）或 `ask`。 |
| `updatedInput` | `preToolUse` | 替换后的工具参数。 |
| `decision.behavior` + `decision.message`（位于 `hookSpecificOutput` 下），或 `decision` + `reason` | `permissionRequest` | `allow` 或 `deny`。 |
| `decision: "block"` + `reason` | `userPromptSubmit`、`preCompact`、`stop`、`postToolUse`、`postToolUseFailure` | 见各阶段说明。 |

`continue: false` 会停止什么：

| 阶段 | 效果 |
| --- | --- |
| `preToolUse` | 拒绝该调用，并在记录本轮结果后结束运行。 |
| `postToolUse`、`postToolUseFailure` | 记录本轮结果后结束运行；本轮剩余的调用不再执行。 |
| `permissionRequest` | 以"拒绝"回答该提示；若是工具调用，运行也会在本轮之后结束。 |
| `userPromptSubmit` | 拒绝本次运行。 |
| `preCompact` | 取消手动压缩。 |
| `stop` | 即使另一个 stop hook 要求继续，智能体也会结束。 |
| 其他 | 无效果；`stopReason` 仍会显示。 |

被 hook 结束的运行以错误码 `stopped_by_hook` 失败，错误信息即 `stopReason`。

### `preToolUse` 与权限提示

一次工具调用依次经过：

1. **绝对拒绝**——本次运行的 `allowedTools`、deny 规则、ask（只读）模式，以及危险命令拒绝名单。在这里被拒绝的调用不会执行任何 hook。
2. **`preToolUse`**——所有匹配的 hook 都会执行。第一个失败或 `deny` 直接拒绝该调用，不询问任何人。
3. **`updatedInput`**——替换参数先按工具 schema 校验（不合法时以 `invalid_hook_args` 失败），再重新分类并再次经过第 1 步，因此改写无法触及被拒绝的命令或路径。
4. **权限**——策略照常判定，并叠加 hook 的回答：
   - 任一 hook 返回 `ask`，就强制为本次调用弹出提示，即使策略本会自动放行；该回答只覆盖本次调用。
   - 否则，任一 hook 返回 `allow`，就代为回答策略本会显示的提示——`write`、`execute`、`env` 调用都适用，与 allow 规则一致。它**不会**回答 `ask` 规则要求的提示，也不覆盖带控制语法（`&&`、`|`、`;` 等）的 shell 命令，这与 allow 规则的限制相同。
5. **`permissionRequest`**——在提示即将出现的地方先执行这些 hook。`deny` 拒绝该调用（`hook_blocked`）；`allow` 代为回答提示——但 `ask` 规则或 `preToolUse` 的 `ask` 所要求的提示除外，那仍会交给你。没有决定时，会询问你（并触发 `notification`）。
6. 工具执行，随后是 **`postToolUse`**，失败时还有 **`postToolUseFailure`**。

当 hook 代你作答时，会话的工具调用日志会记录 `hook_allowed` 或 `hook_denied`。

### 给模型的上下文

- `sessionStart` 和 `userPromptSubmit` 的上下文以 `<hook-context>` 块追加到任务末尾（每个阶段上限 8,000 个字符，并转义 `<`、`>` 与 `&`，使文本无法闭合自己的块）。`sessionStart` 和 `subagentStart` 只接受显式的 `additionalContext`，从不采纳纯 stdout，因此只是打日志的 hook 不会进入提示词。
- `subagentStart` 的上下文追加到子智能体的任务末尾。
- `postToolUse` / `postToolUseFailure` 的 `additionalContext`，以及 `decision: "block"` 的 `reason`，会附加在模型读取的工具结果旁边，并以一行说明标注为用户 hook 的输出、而非工具输出（每次调用上限 4,000 个字符）。除非该 hook 设置了 `suppressOutput`，它们也会作为提示显示给你。工具调用本身不受影响。

### `stop`

`stop` hook 在顶层智能体即将给出最终回答时执行（在内置的收尾检查之后）。带 `reason` 的 `decision: "block"` 会让运行继续：模型会被告知原因并接着工作。一旦本次运行中已有 stop hook 这样做过，事件中的 `stopHookActive` 即为 `true`，hook 可以借此在第二次时放行。此外，每次运行中 stop hook 最多让运行继续 5 次，且绝不会超过运行的回合上限。

### 压缩

自动压缩会触发 `preCompact`（`reason: "auto"`）和 `postCompact`；它不可被拦截，因为不压缩的话下一次请求就放不进上下文窗口。当界面把你的 hook 传给手动压缩（`compactSessionNow` / `llmCompactSessionNow`）时，手动压缩以 `reason: "manual"` 触发它们；此时 `preCompact` 的 `decision: "block"` 或 `continue: false` 会取消压缩，会话保持不变。对于过短而无法压缩的会话，不会触发 hook。

## 插件

插件的 `contributes.hooks` 使用同样的条目与阶段，并且只有在你启用插件经审阅的摘要后才会执行。插件的 `http` hook 不得列出 `allowedEnvVars`：command hook 从来看不到你的密钥，插件也不能借请求头把它们拿回去。`seekforge mcp-serve` 不加载插件 hook。
