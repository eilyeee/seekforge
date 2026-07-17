# 发布桌面应用（DMG）

> [English](RELEASING.md) | **简体中文**

桌面端 bundle 是自包含的：它将 CLI 的服务器作为 Tauri sidecar 内嵌其中（见 [`apps/desktop/src-tauri/README.md`](../apps/desktop/src-tauri/README.md)），因此最终用户只需安装 DMG——无需系统级 `seekforge`。

## 发布前检查清单

1. **绿色基线** — 运行与 CI 相同的确定性门禁：
   ```sh
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm test:coverage:critical
   node scripts/npm-pack-smoke.mjs
   cargo test --workspace --exclude seekforge-desktop
   ```
   包冒烟测试基于现有的 CLI `dist` 构建，打包出与 npm 完全一致的产物，
   安装到一个干净的临时 prefix 下，并运行两个已发布的入口点。
   它需要访问 registry 以安装运行时依赖。
2. **版本号提升** — 在 `apps/cli/package.json` 与
   `apps/desktop/src-tauri/tauri.conf.json`（`version`）中设置发布版本；更新 `CHANGELOG.md`。
3. **为目标 triple 构建 sidecar**（Tauri 要求）：
   ```sh
   pnpm --filter seekforge build:sidecar
   # cross-build: SIDECAR_TARGET=aarch64-apple-darwin pnpm --filter seekforge build:sidecar
   ```
4. **构建桌面网页应用 + bundle**：
   ```sh
   pnpm --filter @seekforge/desktop build
   pnpm tauri build            # -> target/release/bundle/**/SeekForge_<ver>_<arch>.dmg
   ```

## 干净机器验证（手动门禁——必做）

GUI 端到端在这里无法用 CI 自动化；请在一台 PATH 中**没有** `seekforge` 的机器（或全新用户账户）上手动执行：

- [x] 安装 DMG 并启动 `SeekForge.app`。_（已完成——维护者开发机）_
- [ ] 窗口加载的工作台**由内嵌 sidecar 提供服务，而非系统 CLI**——
      这是尚未验证的部分：它需要一台 PATH 中没有 `seekforge` 的机器
      才有意义（开发机上的运行可能用的是系统 CLI）。
- [x] **⏺ 聊天端到端**：打开一个项目、发送一个任务、收到流式响应、
      批准一次工具调用。_（已完成——开发机）_
- [ ] 退出应用——sidecar 的进程组被杀死（没有孤儿
      `seekforge-server`）。

> 状态：DMG 可安装、可启动，应用内聊天端到端可用（已在开发机验证）。
> 剩余的必做检查是 **no-PATH / 内嵌 sidecar** 隔离性——请在发布前
> 于一台干净机器或全新用户账户上执行。

将结果（OS 版本、架构）记录到 release notes 中。这是最后一项发布前检查，且**尚未**接入 CI。

## 自动化质量门禁

- `.github/workflows/ci.yml` 在 Node 22 上运行完整的 typecheck/构建/测试，
  对风险最高的 URL/浏览器/命令/缓存边界强制执行分域覆盖率下限，
  然后在受支持的最低版本 Node 20 上安装并运行打包后的 CLI。
- `.github/workflows/integration.yml` 每周及按需运行。它测试
  真实的 Rust runtime 协议，构建/运行 Docker 镜像，并启动
  Playwright Chromium 做截图冒烟测试。
- `.github/workflows/eval.yml` 每周及按需针对已提交的行为 baseline 运行。
  它需要仓库的 `DEEPSEEK_API_KEY` secret，并会发起付费的、非确定性的
  provider 调用；在刷新 `evals/baseline.json` 之前请审阅其上传的报告与成本。

集成与 eval 的定时任务是对确定性 PR 门禁的补充；它们不能替代上面的干净机器桌面端检查。

## Updater 策略

Updater 目前是**禁用**的：`tauri.conf.json` 中 `createUpdaterArtifacts: false`，且 `updater.pubkey` 是占位符。DMG 发布时不带更新产物，也没有 `latest.json`。

**决定：保持 updater 关闭**，直到项目所有者生成并妥善保存一把真实的签名密钥。之后若要启用：

1. `pnpm tauri signer generate -w ~/.tauri/seekforge.key`（私钥保密；
   绝不提交到仓库）。
2. 将公钥填入 `tauri.conf.json` 的 `updater.pubkey`，并设置
   `createUpdaterArtifacts: true`。
3. 在发布环境中通过 `TAURI_SIGNING_PRIVATE_KEY`（+ 密码）对构建签名。
4. 将生成的 `latest.json` + 签名产物发布到 GitHub release；
   将 `updater.endpoints` 指向它。

在此之前，发布均为「仅安装」模式（更新即下载新 DMG）。
