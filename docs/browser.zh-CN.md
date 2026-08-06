# 浏览器 / 可视化验证

> [English](browser.md) | **简体中文**

SeekForge 可以驱动一个真实的 headless 浏览器，让智能体**验证前端改动**：打开你的开发服务器、读取控制台中的报错、对 DOM 做快照、截取屏幕截图——并且可以**操作页面**，因此像「登录 + 提交表单」这样的流程能被真正跑通验证，而不只是看一眼。该能力由 [Playwright] 提供支持，它是一个**可选的、需你自行安装的 opt-in 附加组件**（刻意不作为声明依赖，因此常规安装绝不会拉取浏览器驱动）——核心保持精简，不需要它的用户完全不受影响。

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

如果你已经在别处装了 Playwright（全局安装、或另一个项目里），不必再装一份——把 `SEEKFORGE_PLAYWRIGHT` 指向它即可，取值是任何能解析到 `playwright-core` 模块的 import specifier 或文件 URL：

```sh
export SEEKFORGE_PLAYWRIGHT=/path/to/node_modules/playwright-core/index.mjs
```

## 打开与查看页面

| 工具 | 参数 | 权限 | 作用 |
| --- | --- | --- | --- |
| `browser_navigate` | `url` | `env`（总是需要确认） | 在共享的 headless 浏览器中打开 `url`（只启动一次，跨调用复用）。返回最终 url、HTTP 状态码与标题；并开始捕获控制台/错误/失败请求。 |
| `browser_screenshot` | `path?` | `execute` | 将整页 PNG 保存到 `.seekforge/uploads/`（或 `path`）并返回路径。对页面本身只读。 |
| `browser_snapshot` | — | `readonly` | 返回一份简洁的文本快照（标题、url、标题层级、链接、按钮、输入框、可见文本），让智能体无需图片即可「看到」页面。 |
| `browser_console` | — | `readonly` | 返回自上次 navigate 以来捕获的控制台消息、未捕获的页面错误与失败的网络请求——这是判断「我的改动是否弄坏了页面」的关键信号。交互不会清空它。 |
| `browser_network` | `urlContains?`、`failedOnly?` | `readonly` | 返回自上次 navigate 以来页面**完成**的请求——方法、URL、状态码。返回 500 的 fetch 既不会产生控制台消息也不会产生页面错误，因此这是 `browser_console` 看不到的另一半。 |

## 操作页面

| 工具 | 参数 | 权限 | 作用 |
| --- | --- | --- | --- |
| `browser_click` | `selector`、`index?`、`timeoutMs?` | 见下 | 等元素可操作后点击它。 |
| `browser_fill` | `selector`、`text`、`index?`、`submit?`、`timeoutMs?` | 见下 | 替换输入框的内容；`submit:true` 会在填完后按回车。 |
| `browser_select` | `selector`、`value?` \| `label?`、`index?`、`timeoutMs?` | 见下 | 在 `<select>` 中选择某一项；没有匹配项时以 `option_not_found` 失败。 |
| `browser_press` | `key`、`selector?`、`index?`、`timeoutMs?` | 见下 | 按下某个键或组合键（`Enter`、`Escape`、`Control+A`），可先聚焦到某元素。 |
| `browser_wait_for` | `selector?` \| `text?`、`state?`、`timeoutMs?` | `readonly` | 等到某元素/文本出现（或消失）之后再去看页面。 |
| `browser_upload` | `selector`、`path`、`index?`、`timeoutMs?` | `execute` / `env` | 把工作区中的文件挂到 file input 上，从而端到端地跑通上传流程。路径会原样出现在权限提示里，并经过工作区沙箱解析。 |

`selector` 是 Playwright 选择器：CSS（`#login button`）、文本（`text=Sign in`）或角色（`role=button[name="Save"]`）。从 `browser_snapshot` 的输出里挑。Playwright 是严格模式——选择器匹配到多个元素是错误，而不是静默取第一个——所以用 `index` 指定第几个。这类失败会报 `ambiguous_selector` 并给出匹配数量；始终没出现的选择器则报 `element_not_found`。

页面在整个会话中是共享的，因此每次交互都会被钉死在「你批准时的那个页面」上：如果在批准与执行之间有东西把页面移走了（并行的子代理、一次慢重定向），这次操作会以 `page_changed` 被拒绝，而不是落在一个用户从未看到的页面上。

每个交互都会返回操作后的页面 url、本次操作是否发生了跳转，以及操作期间页面抛出的未捕获错误。`browser_fill` 只返回输入了多少个字符，绝不回显文本本身——那个字段可能是密码。

### 安全性

`browser_navigate` 是唯一会发起对外动作的工具，因此被归为 **`env`** 级别——与 `web_fetch`/`web_search` 完全一致。它**总是需要确认**，即使在自动批准模式下也是如此，且原始 URL 会原样展示给用户。

浏览器验证对常规 `web_fetch` 的 SSRF 策略有一个狭窄的例外：在获得上述显式确认后，它可以打开 `localhost`、`127.0.0.0/8` 或 `::1` 上的回环开发服务器。其他私有、链路本地及特殊网络目标仍被阻止，包括 RFC-1918 地址、`169.254.169.254`、IPv6 ULA/链路本地地址、IPv4 映射的私有形式，以及非 `http(s)` 协议。该例外仅限于 `browser_navigate`；`web_fetch` 依旧拒绝回环目标。

该策略会重新应用到每一次导航和子资源请求，包括 DNS 解析结果，因此初始确认后的普通重定向以及同时返回公网/私网地址的 DNS 响应都会被阻止。获准继续请求时 Chromium 会再次解析主机，而 Playwright 无法把连接固定到已检查的地址，因此仍存在很窄的 TTL-0 DNS rebinding 竞态；强制的 `env` 确认是这项残余风险的补偿控制。

检查类工具只作用于**已加载**的页面，不发起新的对外动作，因此归为 `readonly`（snapshot/console）或 `execute`（screenshot，会写出一个 PNG 产物）。在你先执行 navigate 之前，它们会以 `no_page` 失败。

交互类工具的权限**由当前页面指向哪里决定**，因为那才决定一次点击真正能造成什么后果：

- **回环页面**（`localhost`、`127.0.0.0/8`、`::1`）→ `execute`。操作你自己的开发服务器属于日常工作，在 auto 模式下无人值守地执行。
- **其他任何页面** → `env`，**每次调用**都确认（auto 模式也不例外），并原样展示选择器与页面地址。在别人的站点上点一下可能意味着发帖、下单或删除；批准了打开页面，不等于批准了之后在上面做的每一件事。

`browser_wait_for` 只是观察，因此无论页面来自哪里都保持 `readonly`。

共享浏览器在一次会话中只有一个实例，并在会话结束时销毁（另有进程退出兜底），因此绝不会泄漏 headless 浏览器进程。

## 在多次运行之间保持登录

默认情况下，每次运行都从未登录状态开始，并在结束时忘掉一切 —— 浏览器上下文是空的，
随会话一起销毁。这个默认值是对的：会被保存下来的不是某种偏好设置，而是页面接触过的
每一个 origin 的 cookie 和 localStorage，对一个已登录的站点来说，那**就是**登录本身。

在你自己的 `~/.seekforge/config.json` 里设置 `browserProfile` 即可保留它：

```json
{ "browserProfile": "work" }
```

此后会话会从 `~/.seekforge/browser-profiles/work.json` 载入，并在结束时写回；
目录与文件分别以 `0700`/`0600` 创建，因此机器上的其他账号读不到。首次运行时该文件
还不存在是正常情况，不是错误。

这个设置是**名字，不是路径**。路径会让一个笔误 —— 或者一个本就不该被信任来做这个
决定的配置层 —— 把有效的会话 cookie 落进仓库工作区，而下一次 `git add -A` 就会把
它们发布出去。名字被限制为字母、数字、点、短横线和下划线，因此无法离开那个目录。
这个值同样是用户所有：项目配置既不能打开持久化、不能指定 profile 名，也不能把浏览器
指向仓库自带的某个状态文件。

模型能调用的任何东西都碰不到它。Agent 无法决定「开始保存 cookie」，也无法决定把它们
保存到别处；应用在启动时一次性解析出路径，而浏览器会话对它一无所知。

你也不需要让 agent 来生成这个文件。把你自己的 Playwright 脚本或
`playwright codegen --save-storage` 指向同一个路径，以你自己的身份登录一次，
之后每次运行就都是已认证状态：

```bash
npx playwright codegen --save-storage ~/.seekforge/browser-profiles/work.json https://example.com
```

profile 是在一次运行**正常结束**时写入的。取消运行（Ctrl+C、停止）会关闭浏览器但
不保存：在登录跳转跑到一半、或某个 cookie 刚刚轮换之后停下来，否则就会用一个坏掉的
会话覆盖掉本来能用的那个。留在磁盘上的，始终是最后一次正常结束的运行。

`seekforge serve` 与 Desktop 不支持这个设置：整个进程只有一个 Chromium，而服务端
会同时跑多个工作区，共享的会话无法兑现「按工作区隔离的 cookie 文件」这个承诺。

要忘掉一次会话，删掉那个文件即可。

## 验证循环

1. 启动你的开发服务器（例如用 `run_command` 在后台运行 `npm run dev`），
   记下其 URL。
2. `browser_navigate({ url: "http://localhost:5173/" })` — 打开页面。
3. `browser_console()` — 检查你的改动是否引入了错误/失败请求。
   这是「我是不是弄坏了它」的最快信号。
4. `browser_snapshot()` — 确认预期的标题/链接/表单字段都在，
   而无需为一张图片消耗 token。
5. 把你真正改动的流程跑一遍：`browser_fill({selector:"#user", text:"ada"})` →
   `browser_select({selector:"#team", label:"Tools team"})` →
   `browser_click({selector:"#submit"})` → `browser_wait_for({text:"Welcome"})`。
6. `browser_screenshot()` — 截取一张 PNG 留档，或交给
   `image_analyze` 做视觉检查（「布局是不是坏了？」）。

如此迭代：编辑 → 重新 `browser_navigate`（或刷新）→ 交互 → `browser_console`，直到页面干净为止。

`scripts/browser-tools-smoke.mts` 会用真实 Chromium 与一个临时页面完整跑一遍这个循环；只要 Chromium 可用，CI 就会执行它。

停止 Agent 运行会取消等待中的浏览器 DNS 检查，以及正在执行的导航、截图、标题读取或
页面快照操作；需要中断 Playwright 时会关闭共享浏览器。
