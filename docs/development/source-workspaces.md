---
title: 跨仓库源码开发
description: 在保持 Git 仓库、工作区和 lockfile 独立的前提下联调本地源码。
---

当应用需要联调尚未发布的 Pluxel 或另一个独立仓库时，可以用 `pluxel source` 管理开发期的包解析。每个源码仓库仍保留自己的 Git 历史、工作区和 lockfile。CLI 同时管理包链接、`docs/pluxel` 和 `.agents/skills/pluxel-development`；它不接管运行时 Plugin 安装。

## 准备 checkout 和 CLI

先准备应用、Pluxel 和需要联调的 provider Git checkout，并按各仓库要求安装 mise 工具链。消费方是最终运行 `pnpm dev` 的应用，不是 Pluxel 根仓库。

本页后续命令在消费方根目录执行，要求 `pluxel --version` 可运行。可以使用全局 CLI；希望以 Pluxel 源码为准时，用该 checkout 已构建的 `packages/cli/bin/pluxel.mjs` 入口或它的全局符号链接。CLI 会从自己的真实路径发现 Pluxel，不会根据目录相邻关系猜测。

各 checkout 可独立切换分支；依赖声明变化后重新执行 `source install`。

拉取或修改 CLI 源码后，先在 Pluxel checkout 执行 `pnpm --filter @pluxel/cli build`。
Git launcher 在加载命令前核对 CLI 源码内容与构建指纹；缺失或不匹配时明确提示重建，不执行旧命令或自动安装。
重建后再从消费方运行 `source install`，更新包改名、移动或依赖变化后的 overlay。

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
作为上游安装的 checkout 同样隐式使用当前 Git CLI 的 Pluxel 来源，即使其 `sources` 为空；它自己的开发依赖也在该 checkout 的 overlay 中解析。
安装和构建顺序从实际 package dependency graph 推导；provider repository 先完成，互不依赖的 repository 可并行。
`--frozen-lockfile` 只在显式传入时生效。

`pluxel source build` 默认构建本次 closure 中所有确实发布 artifact 的 package。只需要让 Vitest preset 在 config 求值前可用时，使用可重复的
`--package` 精确选择：

```sh
pluxel source build --package @pluxel/test
```

默认尊重 source checkout 自己的 Turbo 缓存；只有明确需要重新执行时才使用 `pluxel source build --force`。

多个消费方可同时执行 `source build` / `source install`。CLI 按 checkout 的真实路径排序获取整个来源图的 `.pluxel/source-operation.lock`；共享来源的命令会显示持有者 PID 与等待路径，并在前一操作结束后继续。安装内部的构建复用同一次所有权，失败时等待已经启动的同层任务全部退出后再释放锁。

锁只协调这些 source 命令，不覆盖直接运行的上游 `pnpm build`、Turbo、`pnpm verify`，也不覆盖 source 命令返回后消费者自己的构建或运行。不要让这些操作与会重写相同产物的构建（尤其 `--force`）重叠。进程异常终止后若留下锁，CLI 不会自动删除：先确认原命令及其子进程均已停止，再按错误中给出的准确路径清理锁并重试。
具有非标准 artifact 目录的 package 可以在 manifest 中声明 `"pluxel": { "sourceBuild": true }`；纯源码 package
也可显式声明 `false`。省略时 CLI 继续根据标准 package entry 推断。

CLI 会拒绝不在当前 closure 中或本来不需要 artifact 的名称；被选 package 自己的 Turbo/pnpm task graph 仍决定必要前置。这个窄构建不安装依赖、
不改 consumer lockfile，也不替代 production build 或 source install。

`singletons` 只用于具有 nominal/private identity 的 direct dependency，而且必须能从本次选中的 source package 中推导出唯一 owner。不要把 node_modules 绝对路径写进配置。

## 与运行时来源的区别

| 能力                   | 所有者           | 时机                                                 |
| ---------------------- | ---------------- | ---------------------------------------------------- |
| `pluxel source`        | CLI              | 开发期 package resolution、构建和 live source        |
| runtime `sources`      | Native/Vite 入口 | Native 启动扫描一次；Vite 持续观察已发布的 ESM entry |
| package manager Plugin | Host 显式装配    | 运行中的安装/删除和原子发布操作                      |

三者分别拥有自己的 lifecycle。`source install` 管理开发期包解析；Package Manager 发布 mutable entry；执行入口消费应用声明的来源。来源契约与更新时机见 [Host 配置](../host/configuration.md#动态来源)。

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

## 统一外部依赖

每个工作区在自己的 `pnpm-workspace.yaml` 中集中声明版本，各包通过 `catalog:` 引用。核心 catalog 是 Pluxel 共用外部版本政策的唯一来源：Git CLI 读取所属 checkout，npm CLI 使用构建时生成的同一政策快照。项目仍保留自己的成员、依赖声明和 lockfile。

| 操作                                                          | 职责                                            | 写入范围                 |
| ------------------------------------------------------------- | ----------------------------------------------- | ------------------------ |
| `pluxel pncat add/remove/migrate`                             | 使用原生 pncat 添加、删除或迁移依赖声明         | 包清单与 catalog         |
| `pluxel pncat clean`                                          | 清理没有任何声明引用的 catalog 项               | catalog                  |
| `pluxel workspace sync`                                       | 用本 CLI 的政策对齐已有 catalog 版本            | 仅 `pnpm-workspace.yaml` |
| `workspace sync --check`、`workspace doctor`、`source doctor` | 检查声明、引用和版本差异                        | 只读                     |
| `pnpm install` 或 `pluxel source install`                     | 安装并更新锁文件；source install 先同步版本政策 | 安装产物与 lockfile      |

工作区必须已有 `pnpm-workspace.yaml`（单包项目可使用 `packages: []`）。已有裸版本时先显式迁移，再同步：

```sh
cd /absolute/path/to/project
pluxel pncat migrate --yes --no-install
pluxel workspace sync
pnpm install
pluxel workspace sync --check
```

Git 源码工作区将上面的 `pnpm install` 替换为 `pluxel source install`。该命令在安装锁内对 consumer 和相关 checkout 执行相同版本同步，再生成 overlay 并安装；不会替你迁移清单。使用 `--frozen-lockfile` 时，政策更新若使锁文件过期，pnpm 会如实拒绝，先普通安装并审查变更。

`workspace sync` 不添加新依赖，不更改任何 `package.json`，也不联网查询 latest。政策之外的已有 catalog 条目保持原值。升级共享版本先更新核心 catalog 或升级 CLI；`pncat.config.ts` 只拥有分类与迁移规则。未迁移的可治理裸版本、缺失 catalog 引用和政策冲突会明确报错，修复后再同步。

Peer 兼容范围与实际安装版本分别维护。只有 peer 引用的 catalog 保持原兼容范围；若普通依赖与 peer 共用同一个即将更新的条目，sync 拒绝变更，先显式将 peer 分到独立 catalog 或保留为包自己的兼容范围。同步不会为了更新安装版本而隐式收窄、扩大或改写 peer 声明。`workspace:`、`file:`、`link:` 及受配置排除的范围保持各自契约。

工作区无需额外安装 pncat，原生命令与选项由 `pluxel pncat` 直接交给内联实现：

```sh
pluxel pncat init --yes
pluxel pncat add yaml@^2.9.1 --yes --no-install
pluxel pncat clean --yes --no-install
pluxel pncat --help
```

`--no-install` 将声明维护与安装分开，适合随后运行 `source install` 的 Git 工作区；原生 pncat 默认会在变更后安装，安装失败会以失败状态退出。`clean` 即使排除了某字段的迁移，也会保留该字段仍引用的 catalog 项。

内联 `init` 生成随 CLI 发布的配置入口，运行时和类型均不依赖另装 pncat：

```ts
import { defineConfig, mergeCatalogRules } from '@pluxel/cli/pncat'

export default defineConfig({
	catalogRules: mergeCatalogRules([{ name: 'runtime', match: ['yaml'] }]),
})
```

嵌入的独立 Git 仓库仍需拥有可独立安装的 catalog 和 lockfile。父工作区将其包列为成员时，也必须具备这些声明所引用的 catalog 名称；不能把依赖改成只有父工作区才能解析的形式。中性上游仓库自行依赖原生 `pncat`，配置从 `pncat` 导入，维护命令不使用 `pluxel pncat`。

原生 `pncat detect` 只报告待迁移声明，即使有差异也可能成功退出；可命名为 `catalog:detect`，不能把它当作阻断式检查。Pluxel 应用的 `workspace sync --check` 则会在声明或版本冲突时非零退出。
