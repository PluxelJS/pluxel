---
title: 新电脑启动 Git 源码开发
description: 克隆 Pluxel、chatbot 和 bot-new-omni，准备独立 Git 工作区并启动应用。
---

`scripts/bootstrap-source-dev.sh` 将 Pluxel、chatbot 和应用连接为[跨仓库源码工作区](./source-workspaces.md)。默认示例是 `PluxelJS/bot-new-omni`；应用自己的 `pluxel.sources.jsonc` 决定实际包依赖闭包。

## 新电脑

先安装 Git、Node.js 24 或更新版本、pnpm 11 和 Corepack，并确保四个命令都在 `PATH`。Node.js 新版本可能不附带 Corepack，可通过 `npm install --global corepack` 安装；`corepack enable` 和 `corepack install --global pnpm@11.25.0` 可准备 pnpm。应用和 chatbot 的 `packageManager` 声明由 Corepack 执行。

```bash
mkdir -p "$HOME/code/pluxel-dev"
git clone --recurse-submodules https://github.com/PluxelJS/pluxel.git "$HOME/code/pluxel-dev/pluxel"
bash "$HOME/code/pluxel-dev/pluxel/scripts/bootstrap-source-dev.sh" --dir "$HOME/code/pluxel-dev"
```

脚本复用刚克隆的 Pluxel，然后克隆 chatbot 和 bot-new-omni（包含子模块）。默认目录为：

```text
pluxel-dev/pluxel/
  local-projects/chatbot/       # 独立 Git 仓库
  local-projects/bot-new-omni/  # 独立 Git 仓库，含 vendor/gqlens 子模块
```

它安装 Pluxel 的依赖并构建 CLI，然后直接调用该 checkout 的 `packages/cli/bin/pluxel.mjs`，依次执行 `source register <chatbot>`、`source list`、`source install` 和 `source doctor`。Pluxel 从正在运行的 CLI 真实路径自动发现，不需要 `register`，也不需要全局安装 CLI。`source install` 负责按依赖顺序安装和构建源码仓库，最后安装应用 overlay；每个仓库保留独立 workspace 和 lockfile。

重复运行会复用现有 checkout，不会 pull、reset 或切换分支，也不会覆盖应用配置文件；依赖安装可能更新 lockfile 和生成机器本地 overlay。若已有 checkout 缺少子模块，脚本会给出初始化命令后停止，避免自动切换已有子模块版本。应用必须已提交声明 Pluxel/chatbot Git URL 的 `pluxel.sources.jsonc`。

显式注册的 Pluxel 路径优先于自动发现。如果这台机器之前注册过另一个 Pluxel checkout，先用 `source list` 确认；要恢复跟随当前 CLI，执行 `source unregister https://github.com/PluxelJS/pluxel`，然后重跑脚本。取消注册只移除机器记录，不删除源码。

## 启动 bot-new-omni

准备好运行中的 Docker 和 Compose v2 后：

```bash
cd "$HOME/code/pluxel-dev/pluxel/local-projects/bot-new-omni"
pnpm dev
```

也可以在 bootstrap 命令后加 `--start`，准备完成后直接执行 `pnpm dev`。默认脚本只完成依赖准备和检查。

bot-new-omni 的 `pnpm dev` 自动启动 `compose.dev.yaml` 中的 Inngest、VictoriaMetrics 和 VictoriaLogs，等待服务就绪，再通过 Portless 启动 Host。默认本地 Host 不需要 `.env`；KOOK 机器人账户需要另外通过 `KookPlugin` 配置。复制终端打印的 `Application:` 地址（通常是 `http://bot-new-omni.localhost:1355`）；Workbench 位于 `/__pluxel/workbench`，业务页面位于 `/activity`，Inngest UI 位于 `http://127.0.0.1:8288`。

Ctrl-C 停止 Host，容器继续运行。`pnpm dev:services:down` 停止容器并保留 Activity 数据卷。Flatpak IDE 用户应在宿主机终端运行 `pnpm dev`，确保 Portless 和 Host 使用同一个 PID namespace。具体账户与外部服务配置以应用 README 为准。

## 已有应用或其他仓库

已有应用可以放在任意目录，包括原来的 `local-projects`：

```bash
bash /path/to/pluxel/scripts/bootstrap-source-dev.sh \
  --dir /path/to \
  --app-dir "/path/to/my existing app"
```

克隆其他应用时同时指定仓库和目标目录：

```bash
bash /path/to/pluxel/scripts/bootstrap-source-dev.sh \
  --dir /path/to \
  --app-repo https://github.com/your-org/your-app.git \
  --app-dir /path/to/your-app
```

`--app-repo` 只用于创建尚不存在的目录；已有应用以其当前 checkout 为准。这个脚本准备 Pluxel 和 chatbot 两个源码仓库，其他 Git 依赖按应用声明自行克隆并 `source register`。

日常查看或更新源码连接可以直接使用该 CLI：

```bash
node /path/to/pluxel/packages/cli/bin/pluxel.mjs source list
node /path/to/pluxel/packages/cli/bin/pluxel.mjs source register /new/path/to/chatbot
node /path/to/pluxel/packages/cli/bin/pluxel.mjs source install --root /path/to/your-app
node /path/to/pluxel/packages/cli/bin/pluxel.mjs source doctor --root /path/to/your-app
```

修改 CLI 源码后运行 `pnpm --filter @pluxel/cli build`。其他已接入包的普通源码修改不需要重复注册；需要刷新构建产物时，在应用目录执行 `pluxel source build`。
