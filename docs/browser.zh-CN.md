# 浏览器 / 可视化验证

> [English](browser.md) | **简体中文**

SeekForge 可以驱动一个真实的 headless 浏览器，让智能体**验证前端改动**：打开你的开发服务器、读取控制台中的报错、对 DOM 做快照、截取屏幕截图。该能力由 [Playwright] 提供支持，它是一个**可选的、需你自行安装的 opt-in 附加组件**（刻意不作为声明依赖，因此常规安装绝不会拉取浏览器驱动）——核心保持精简，不需要它的用户完全不受影响。

[Playwright]: https://playwright.dev

## 安装

在 Playwright 与浏览器二进制就位之前，浏览器工具处于休眠状态：

```sh
pnpm add -w playwright-core   # the driver; does NOT auto-download browsers
npx playwright install chromium
```

我们有意依赖 `playwright-core`（而非 `playwright`）：它在安装时不会下载浏览器，因此 CI 以及从不使用这些工具的用户不付出任何代价。在安装完成之前，每个浏览器工具都会返回同一条可操作的错误信息：

```
browser tools need Playwright: pnpm add -w playwright-core && npx playwright install chromium
```

Playwright 通过**工具内部的动态 import** 加载，绝不在顶层加载，因此无论是否安装，typecheck、构建与测试套件都能通过。

## 四个工具

| 工具 | 参数 | 权限 | 作用 |
| --- | --- | --- | --- |
| `browser_navigate` | `url` | `env`（总是需要确认） | 在共享的 headless 浏览器中打开 `url`（只启动一次，跨调用复用）。返回最终 url、HTTP 状态码与标题；并开始捕获控制台/错误/失败请求。 |
| `browser_screenshot` | `path?` | `execute` | 将整页 PNG 保存到 `.seekforge/uploads/`（或 `path`）并返回路径。对页面本身只读。 |
| `browser_snapshot` | — | `readonly` | 返回一份简洁的文本快照（标题、url、标题层级、链接、按钮、输入框、可见文本），让智能体无需图片即可「看到」页面。 |
| `browser_console` | — | `readonly` | 返回自上次 navigate 以来捕获的控制台消息、未捕获的页面错误与失败的网络请求——这是判断「我的改动是否弄坏了页面」的关键信号。 |

### 安全性

`browser_navigate` 是唯一会发起对外动作的工具，因此被归为 **`env`** 级别——与 `web_fetch`/`web_search` 完全一致。它**总是需要确认**，即使在自动批准模式下也是如此，且原始 URL 会原样展示给用户。

浏览器验证对常规 `web_fetch` 的 SSRF 策略有一个狭窄的例外：在获得上述显式确认后，它可以打开 `localhost`、`127.0.0.0/8` 或 `::1` 上的回环开发服务器。其他私有、链路本地及特殊网络目标仍被阻止，包括 RFC-1918 地址、`169.254.169.254`、IPv6 ULA/链路本地地址、IPv4 映射的私有形式，以及非 `http(s)` 协议。该例外仅限于 `browser_navigate`；`web_fetch` 依旧拒绝回环目标。

该策略会重新应用到每一次导航和子资源请求，包括 DNS 解析结果，因此初始确认后的普通重定向以及同时返回公网/私网地址的 DNS 响应都会被阻止。获准继续请求时 Chromium 会再次解析主机，而 Playwright 无法把连接固定到已检查的地址，因此仍存在很窄的 TTL-0 DNS rebinding 竞态；强制的 `env` 确认是这项残余风险的补偿控制。

三个检查工具只作用于**已加载**的页面，不发起新的对外动作，因此归为 `readonly`（snapshot/console）或 `execute`（screenshot，会写出一个 PNG 产物）。在你先执行 navigate 之前，它们会以 `no_page` 失败。

共享浏览器在一次会话中只有一个实例，并在会话结束时销毁（另有进程退出兜底），因此绝不会泄漏 headless 浏览器进程。

## 验证循环

1. 启动你的开发服务器（例如用 `run_command` 在后台运行 `npm run dev`），
   记下其 URL。
2. `browser_navigate({ url: "http://localhost:5173/" })` — 打开页面。
3. `browser_console()` — 检查你的改动是否引入了错误/失败请求。
   这是「我是不是弄坏了它」的最快信号。
4. `browser_snapshot()` — 确认预期的标题/链接/表单字段都在，
   而无需为一张图片消耗 token。
5. `browser_screenshot()` — 截取一张 PNG 留档，或交给
   `image_analyze` 做视觉检查（「布局是不是坏了？」）。

如此迭代：编辑 → 重新 `browser_navigate`（或刷新）→ `browser_console`，直到页面干净为止。

停止 Agent 运行会取消等待中的浏览器 DNS 检查，以及正在执行的导航、截图、标题读取或
页面快照操作；需要中断 Playwright 时会关闭共享浏览器。
