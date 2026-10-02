---
title: 跨仓库源码开发
description: 在保持 Git 仓库、工作区和 lockfile 独立的前提下联调本地源码。
---

当应用需要联调尚未发布的 Pluxel 或另一个独立仓库时，可以用 `pluxel source` 管理开发期的包解析。每个源码仓库仍保留自己的 Git 历史、工作区和 lockfile。CLI 同时管理包链接、`docs/pluxel` 和 `.agents/skills/pluxel-development`；它不接管运行时 Plugin 安装。

## 准备 checkout 和 CLI

先准备应用、Pluxel 和需要联调的 provider Git checkout，并按各仓库要求安装 mise 工具链。消费方是最终运行 `pnpm dev` 的应用，不是 Pluxel 根仓库。

本页后续命令在消费方根目录执行，要求 `pluxel --version` 可运行。可以使用全局 CLI；希望以 Pluxel 源码为准时，用该 checkout 已构建的 `packages/cli/bin/pluxel.mjs` 入口或它的全局符号链接。CLI 会从自己的真实路径发现 Pluxel，不会根据目录相邻关系猜测。

各 checkout 可独立切换分支；依赖声明变化后重新执行 `source install`。

## 声明源码仓库

Git CLI 自身的 Pluxel checkout 自动加入，无需配置。联调其他仓库或声明 singleton 时，在消费方根目录提交 `pluxel.sources.jsonc`：

```jsonc
{
	"version": 1,
	"sources": ["https://github.com/PluxelJS/chatbot"],
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

`source` 命令族始终使用实际调用的 CLI，因此项目尚未安装依赖、安装不完整或固定了另一个 CLI 版本，都不影响源码自举。Git CLI 不委托另一份项目 CLI；工具 owner 仍从消费方已安装依赖解析。源码工作区的 install/build/doctor 必须从 Pluxel Git checkout 的 CLI 执行；npm 用户使用 `workspace setup`。

## 管理登记和移动目录

Git CLI 所属的 Pluxel checkout 始终优先，不受同名全局登记覆盖。首次接入将它绑定到消费工作区；用另一份 checkout 接入会报来源不匹配，不自动切换。其他仓库通过登记定位。`pluxel source list` 可在任意目录运行，显示当前可用的路径及来源（`registered` 或 `cli`），路径不存在时标记 `missing`。自动发现不写入 registry，也不从当前目录、相邻目录或父项目猜测源码位置；Git worktree 和入口符号链接同样可用。

移除过期登记：

```sh
pluxel source unregister https://github.com/PluxelJS/chatbot
```

`unregister` 只删除登记记录，不删除 checkout 或已有项目 overlay；移除 Pluxel 的显式登记后，CLI 自身 checkout 仍会自动出现。`register`、`list`、`unregister` 和其他 source 命令均支持 `--registry <path>`，也可用 `PLUXEL_SOURCE_REGISTRY` 环境变量选择独立 registry。

移动其他已登记 checkout 后重新登记并运行 `source install`。Pluxel 绑定的 checkout 缺失时先恢复其位置；本流程不自动重绑到另一份源码。修改依赖声明后运行 `source install`；同一 checkout 内的普通源码与文档修改不需要重装。
`.pnpmfile.cjs` 与 `.pluxel/` 都是 CLI 生成的机器本地 overlay，应被 Git 忽略，不是需要提交的 workspace 配置。
新 checkout 使用 mise 准备工具后，先由独立 CLI 激活 source overlay，再安装应用依赖。

## 何时重新安装或构建

源码联调不表示所有模块都由 Vite 直接执行源码。开发期浏览器可读取框架的 source export，
但 Node 宿主和 Vite 配置使用的框架 singleton 仍加载构建产物。修改或拉取 Pluxel 框架源码后，
dev 脚本先运行 `pluxel source doctor && pluxel source build`，再启动原有宿主；构建复用上游缓存。Vite host 对声明 CLI 或已接入的工作区也会在启动前调用 doctor，直接运行 Vite 同样检查。
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

## 文档、skill 与接入状态

`source install` 预检目标占用，安装依赖与构建后自动创建 `docs/pluxel`、`.agents/skills/pluxel-development` 的上游目录链接，在 `.pluxel/development.json` 记录来源与完成状态，并维护精确的 `.gitignore` 规则及 AGENTS 入口块。项目原有 AGENTS 内容保留。

这些生成路径不提交；提交项目声明、lockfile、ignore 和 AGENTS。clone 到另一目录后，从准备好的 Git CLI 重新执行 `source install --root /absolute/consumer`。普通文件、未知链接和已被 Git 跟踪的目标会明确冲突；先处理占用，不自动覆盖或移除 Git 跟踪。

已有依赖只需修复文档与 skill 时，可运行 `pluxel workspace setup --root /absolute/consumer`；它只物化开发资源，不安装包，也不能代替 source doctor 对包 overlay 的检查。setup 可以重复执行，失败会保留未完成状态；不会回滚已经完成的包安装。

`pluxel docs` 默认直接输出当前来源的开发指南正文；`pluxel docs plugin-development/testing.md` 读取具体页面，并标明来源路径与 CLI 版本。不联网获取另一份 main 文档。skill 和 API 文档各自在上游维护一份正文。

`source doctor` 检查包 overlay 以及开发资源来源、完整性与链接；缺失或漂移会失败并提示接入命令。检查本身不写文件、不联网、不修复。它不证明构建产物最新或在线应用健康。

npm 用户正常安装依赖后运行 `pnpm exec pluxel workspace setup`，从 CLI 随包携带的发行文档与 skill 建立相同入口；升级后重新 setup。无需 Git checkout 或额外下载。`workspace doctor` 检查开发资源与工作区治理。

Codex 从项目 `.agents/skills` 发现链接的 skill；AGENTS 同时保留显式读取要求。新链接未出现在已有会话时重新打开会话。项目不复制正文，其他自有 skill 不受 setup 影响。
