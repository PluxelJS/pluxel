---
title: 跨仓库源码开发
description: 在保持 Git 仓库、工作区和 lockfile 独立的前提下联调本地源码。
---

当应用需要联调尚未发布的 Pluxel 或另一个独立仓库时，可以用 `pluxel source` 管理开发期的包解析。每个源码仓库仍保留自己的 Git 历史、工作区和 lockfile；这个命令也不会接管运行时的 Plugin 安装。

## 准备 checkout 和 CLI

先准备应用、Pluxel 和需要联调的 provider Git checkout，并按各仓库要求安装 mise 工具链。消费方是最终运行 `pnpm dev` 的应用，不是 Pluxel 根仓库。

本页后续命令在消费方根目录执行，要求 `pluxel --version` 可运行。可以使用全局 CLI；希望以 Pluxel 源码为准时，用该 checkout 已构建的 `packages/cli/bin/pluxel.mjs` 入口或它的全局符号链接。CLI 会从自己的真实路径发现 Pluxel，不会根据目录相邻关系猜测。

从新电脑开始开发 bot-new-omni，优先使用[应用自己的 bootstrap 脚本](https://github.com/PluxelJS/bot-new-omni#develop)：用户安装 mise 后，脚本准备工具、三个 Git checkout、登记和源码依赖，布局为：

```text
pluxel/
  local-projects/
    chatbot/
    bot-new-omni/
```

通用手动接入继续下面的步骤。每个仓库可自行切换 Git 分支；修改应用或 provider 分支后若依赖声明变化，再执行 `source install`。

## 声明源码仓库

在消费方根目录提交 `pluxel.sources.jsonc`。下面是同时使用 Pluxel 和 Chatbot 的示例；只联调 Pluxel 时移除 Chatbot URL 与不需要的 singleton：

```jsonc
{
	"version": 1,
	"sources": ["https://github.com/PluxelJS/pluxel", "https://github.com/PluxelJS/chatbot"],
	"singletons": ["drizzle-orm"],
}
```

`sources` 只接受 Git repository URL，不接受机器路径、package 列表或构建命令。CLI 会规范化 HTTPS、SSH 和 `.git` 形式，拒绝未知字段、重复 repository 和不支持的版本。

## 安装和运行

从 Pluxel Git checkout 运行 CLI 时（包括全局符号链接），CLI 会根据自身文件的真实路径自动识别该 checkout，无需登记 Pluxel。其他仓库使用 `register` 登记；机器路径只写入用户 registry：

```sh
pluxel source register /path/to/chatbot
pluxel source list
pluxel source install
pluxel source doctor
pnpm dev
```

成功时，`source list` 应显示每个 URL 对应的真实 checkout，`source doctor` 应通过；随后应用启动应读取这些 checkout 的源码。若 list 标记 `missing`，先修正路径，不要继续安装。

`source` 命令族始终使用实际调用的 CLI，因此项目尚未安装依赖、安装不完整或固定了另一个 CLI 版本，都不影响源码自举。普通命令仍使用项目固定版本。使用 npm 安装的 CLI 时没有可自动识别的源码 checkout，需要另外运行 `pluxel source register /path/to/pluxel`。

## 管理登记和移动目录

显式登记的同一 repository 优先于自动发现。`pluxel source list` 可在任意目录运行，显示当前可用的路径及来源（`registered` 或 `cli`），路径不存在时标记 `missing`。自动发现不写入 registry，也不从当前目录、相邻目录或父项目猜测源码位置；Git worktree 和入口符号链接同样可用。

移除过期登记：

```sh
pluxel source unregister https://github.com/PluxelJS/chatbot
```

`unregister` 只删除登记记录，不删除 checkout 或已有项目 overlay；移除 Pluxel 的显式登记后，CLI 自身 checkout 仍会自动出现。`register`、`list`、`unregister` 和其他 source 命令均支持 `--registry <path>`，也可用 `PLUXEL_SOURCE_REGISTRY` 环境变量选择独立 registry。

移动显式登记的 checkout 后需要重新登记；移动自动发现的 Pluxel checkout 后需更新外部入口链接。修改路径或 `pluxel.sources.jsonc` 后运行 `source install`；已接入 checkout 内的普通源码修改不需要重装。
`.pnpmfile.cjs` 与 `.pluxel/` 都是 CLI 生成的机器本地 overlay，应被 Git 忽略，不是需要提交的 workspace 配置。
新 checkout 使用 mise 准备工具后，先由独立 CLI 激活 source overlay，再安装应用依赖。

## 何时重新安装或构建

源码联调不表示所有模块都由 Vite 直接执行源码。开发期浏览器可读取框架的 source export，
但 Node 宿主和 Vite 配置使用的框架 singleton 仍加载构建产物。修改或拉取 Pluxel 框架源码后，
先运行 `pluxel source build` 再重启宿主；应用可以把此命令加入 dev 启动脚本，复用上游构建缓存。
否则浏览器与服务端可能使用不同版本的 RPC 接口，出现方法不存在等错误。
`source doctor` 检查源码映射和安装 overlay，不检查构建产物是否与当前源码一致。

CLI 扫描每个 checkout 自己的 workspace 和 manifest，按实际依赖闭包创建代理。source package 的 devDependencies 仍属于它自己的 checkout，不进入消费方 closure。
安装和构建顺序从实际 package dependency graph 推导；provider repository 先完成，互不依赖的 repository 可并行。
`--frozen-lockfile` 只在显式传入时生效。

`pluxel source build` 默认构建本次 closure 中所有确实发布 artifact 的 package。只需要让 Vitest preset 在 config 求值前可用时，使用可重复的
`--package` 精确选择：

```sh
pluxel source build --package @pluxel/test
```

默认尊重 source checkout 自己的 Turbo 缓存；只有明确需要重新执行时才使用 `pluxel source build --force`。
具有非标准 artifact 目录的 package 可以在 manifest 中声明 `"pluxel": { "sourceBuild": true }`；纯源码 package
也可显式声明 `false`。省略时 CLI 继续根据标准 package entry 推断。

CLI 会拒绝不在当前 closure 中或本来不需要 artifact 的名称；被选 package 自己的 Turbo/pnpm task graph 仍决定必要前置。这个窄构建不安装依赖、
不改 consumer lockfile，也不替代 production build 或 source install。

`singletons` 只用于具有 nominal/private identity 的 direct dependency，而且必须能从本次选中的 source package 中推导出唯一 owner。不要把 node_modules 绝对路径写进配置。

## 与 dynamic sources 的区别

| 能力                   | 所有者        | 时机                                          |
| ---------------------- | ------------- | --------------------------------------------- |
| `pluxel source`        | CLI           | 开发期 package resolution、构建和 live source |
| runtime `sources`      | dynamic route | 运行期观察已发布的 ESM plugin entry           |
| package manager Plugin | host 显式装配 | 运行中的安装/删除操作                         |

三者不是同一个 lifecycle。source install 不会替 dynamic route 发布 mutable entry，dynamic route 也不会下载 source checkout。

## 边界和排错

- 每个 checkout 保留自己的 Git、pnpm workspace 和 lockfile。
- 不在根 workspace 增加机器路径或 nested workspace pattern。
- 上游有 Turbo 时，把目标交给它自己的 task graph；不要复制 package filter。
- source checkout 的 Plugin 仍必须经过 Pluxel Vite/Rolldown pipeline。
- 解析冲突先看 package identity、singletons 和 dependency owner，再看 lockfile。
- `pluxel source doctor` 同时检查 checkout identity、当前 package closure、生成的 pnpmfile 和每个稳定代理；配置正确但 overlay 未安装或已漂移也会失败。
