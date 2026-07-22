# `@seekforge/core` 包策略

> [English](core-package-policy.md) | **简体中文**

## 决策

在 0.x 系列中，`@seekforge/core` 继续作为私有的内部 workspace 包。受支持的
公开界面是 `seekforge` CLI，以及 `seekforge serve` 暴露的版本化本地
REST/WebSocket 协议。

现在发布该包会制造误导性的兼容承诺：它直接导出 TypeScript 源码、暴露编排
内部实现，并与 CLI/server 同步变化。VS Code 桥接已经证明，集成不需要依赖
这些内部实现；它们可以通过可审计的 server 边界保持轻量。

## 重新评估条件

只有以下条件全部具备后，才重新考虑公开 core SDK：

- 面向 Node 20+ 的已编译 ESM 产物与声明文件；
- 明确且精简的 export map，而不是当前宽泛的源码导出；
- semver 与弃用规则，包括 provider/协议兼容策略；
- 针对打包产物的干净安装消费者测试；
- provider 注入、权限、取消与 trace 存储示例；
- 区分可信嵌入与工作区沙箱的安全说明。

在此之前，内部消费者使用 `workspace:*`，第三方集成使用 `seekforge serve`。
这是分发边界，并不排除未来发布 SDK。
