---
title: 跨仓库源码开发
description: 在保持 Git 仓库、工作区和 lockfile 独立的前提下联调本地源码。
---

本页维护开发期包解析、源码 overlay、catalog 政策与 docs/skill 接入。各仓库保留独立 Git、workspace 和 lockfile；运行时 Plugin 安装不属于 `pluxel source`。

首次接入按下文准备、声明和安装；已有项目直接查[重新构建](#何时重新安装或构建)、[docs/skill 接入](#文档skill-与接入状态)或 [catalog](#统一外部依赖)。

CLI 加载与源码转换规则见[工具链](./tooling.md)；在线状态和日志见[开发控制台](./dev-console.md)。

## 准备 checkout 和 CLI

准备消费应用、Pluxel 和 provider checkout，并按各仓库要求安装工具与依赖。后续命令在消费应用根目录执行。

源码 `install/build/doctor` 使用 Pluxel Git checkout 已构建的 `packages/cli/bin/pluxel.mjs` 或其全局符号链接。拉取或修改 CLI 后，先在该 checkout 执行 `vp run @pluxel/cli#build`；launcher 核对源码内容与构建指纹，缺失或不匹配时要求重建，不执行旧命令或自动安装。CLI 来源选择见[安装分层](./tooling.md#安装分层)。

各 checkout 可独立切换分支；包改名、移动或依赖声明变化后重新 `source install`。

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

其他仓库的机器路径只写入用户 registry：

```sh
pluxel source register /path/to/chatbot
pluxel source list
pluxel source install
pluxel source doctor
vp run dev
```

`list` 标记 `missing` 时先修正路径；安装后要求 doctor 通过。`source` 使用实际调用入口，因此消费方尚未安装依赖或本地 CLI 不完整仍可自举；执行命令所需的工具 owner 仍从消费方已安装依赖解析。npm 接入使用 [workspace setup](#文档skill-与接入状态)。

## 管理登记和移动目录

Git CLI 所属的 Pluxel checkout 优先于同名登记，首次接入即绑定到消费工作区。另一 checkout 接入会报来源不匹配；绑定路径缺失时先恢复，不自动重绑。发现依据仅是 CLI 的真实路径与显式 registry，不按相邻目录、当前目录或父项目猜测；支持 Git worktree 和入口符号链接。

- `pluxel source list`：可在任意目录查看路径及 `registered` / `cli` 来源；缺失标记 `missing`，自动发现不写 registry。
- `pluxel source register /new/path`：登记或更新其他 checkout 的机器路径；移动后再执行 `source install`。
- `pluxel source unregister <repository-url>`：只删登记，不删 checkout 或已有 overlay；Git CLI 自身的 Pluxel 仍会出现。
- `--registry <path>` / `PLUXEL_SOURCE_REGISTRY`：为所有 source 命令选择独立 registry。

`.pnpmfile.cjs` 与 `.pluxel/` 是 CLI 生成的机器本地 overlay，应被 Git 忽略。新消费 checkout 先准备工具，再由独立 Git CLI 运行 `source install` 激活 overlay 并安装依赖；不要把机器路径或 nested workspace pattern 加进根 workspace。

## 何时重新安装或构建

- 依赖声明、包名或位置变化：`pluxel source install`，重建 overlay 并安装。
- 修改或拉取框架源码：`pluxel source doctor && pluxel source build` 后再启动或重启 dev。
- 同一 checkout 内普通源码、文档修改：不重装；是否需构建取决于消费者读取源码还是 artifact。
- 只准备测试 preset 等指定 artifact：`pluxel source build --package @pluxel/test`；`--package` 可重复。

浏览器开发图可读框架 source export，但 Node 宿主和 Vite 配置中的框架 singleton 仍使用构建产物。框架更新后省略构建，可能造成浏览器/服务端 RPC 版本不一致。Host 对声明 CLI 或已接入的工作区会在 Vite 启动前执行 doctor，**不会代替 source build**；doctor 不证明 artifact 最新或在线应用健康。

CLI 扫描每个 checkout 自己的 workspace 和 manifest，按实际依赖闭包创建代理。source package 的 devDependencies 仍属于它自己的 checkout，不进入消费方 closure。
作为上游安装的 checkout 同样隐式使用当前 Git CLI 的 Pluxel 来源，即使其 `sources` 为空；它自己的开发依赖也在该 checkout 的 overlay 中解析。
安装和构建顺序从实际 package dependency graph 推导；provider repository 先完成，互不依赖的 repository 可并行。
`--frozen-lockfile` 只在显式传入时生效。

`source build` 默认构建 closure 中所有需要 artifact 的 package，并尊重各 checkout 的任务缓存；仅明确需要重跑时加 `--force`。`pluxel.sourceBuild: true` 可声明非标准 artifact，`false` 可声明纯源码包，省略时按标准 package entry 推断。

`--package` 必须属于本次 closure 且确实需要 artifact；前置任务仍由该 package 的 Vite Task 图决定。窄构建不安装依赖、不改 consumer lockfile，也不替代 production build 或 `source install`。

多个消费方可同时执行 `source build` / `source install`。CLI 按 checkout 的真实路径排序获取整个来源图的 `.pluxel/source-operation.lock`；共享来源的命令会显示持有者 PID 与等待路径，并在前一操作结束后继续。安装内部的构建复用同一次所有权，失败时等待已经启动的同层任务全部退出后再释放锁。

锁只协调这些 source 命令，不覆盖直接运行的上游 `vp run build`、Vite Task、`vp run verify`，也不覆盖 source 命令返回后消费者自己的构建或运行。不要让这些操作与会重写相同产物的构建（尤其 `--force`）重叠。进程异常终止后若留下锁，CLI 不会自动删除：先确认原命令及其子进程均已停止，再按错误中给出的准确路径清理锁并重试。

`singletons` 只用于具有 nominal/private identity 的 direct dependency，而且必须能从本次选中的 source package 中推导出唯一 owner。不要把 node_modules 绝对路径写进配置。

## 与运行时来源的区别

- `pluxel source`：CLI 拥有开发期 package resolution、构建和 live source。
- runtime `sources`：执行入口拥有；Native 启动扫描一次，Vite 持续观察已发布的 ESM entry。
- package manager Plugin：Host 显式装配，负责运行中的安装/删除和原子发布。

Package Manager 发布 mutable entry，执行入口消费应用声明的来源；见[动态来源](../host/configuration.md#动态来源)。

## 边界和排错

- checkout、包映射或代理不正确：`source list` 核对来源，`source doctor` 检查 identity、closure、生成的 pnpmfile 与稳定代理。
- nominal/private 类型或模块身份冲突：先看 package identity、singleton 的唯一 owner，再看 lockfile。
- Plugin metadata 或 constructor 错误：[源码转换边界](./tooling.md#source-build-boundary)；Plugin source 仍须经过 Vite/Rolldown pipeline。
- 配置正确但接入未完成或漂移：按 doctor 指出的路径修复；检查命令只读，不自动补写。

上游使用 Vite Task 时，构建前置交给它自己的任务图，不复制 package filter。

## 文档、skill 与接入状态

- Git checkout：`pluxel source install --root /absolute/consumer`；预检目标占用，安装与构建后链接上游 `docs/pluxel`、`.agents/skills/pluxel-development`。
- npm 依赖：安装后 `vp exec pluxel workspace setup`；使用 CLI 随包文档与 skill，无需 Git 或额外下载；升级后重新 setup。
- 已安装依赖，仅修复开发资源：`pluxel workspace setup --root /absolute/consumer`；不安装包，不代替 source doctor 的包 overlay 检查。

接入在 `.pluxel/development.json` 记录来源和完成状态，维护精确 `.gitignore` 规则及 AGENTS 入口块，保留原有 AGENTS 内容和其他 skill。普通文件、未知链接或已被 Git 跟踪的目标会报冲突，不覆盖或自动移除 Git 跟踪。setup 可重复执行；失败保留未完成状态，不回滚已完成的包安装。

提交项目声明、lockfile、ignore 和 AGENTS；生成路径不提交。新 clone 从准备好的 Git CLI 重新 `source install`。同一来源中的 docs/skill 正文只维护一份，消费方不复制。

- `source doctor`：checkout identity、当前 closure、包 overlay，以及开发资源来源、完整性与链接。
- `workspace doctor`：pnpm 主版本、workspace 契约、已激活时的 machine-local source pnpmfile，以及 docs/skill 接入。

doctor 只读，不联网或修复；不证明构建最新或应用健康。依赖政策检查另见[统一外部依赖](#统一外部依赖)，产品目录与依赖方向由项目治理脚本负责。

`pluxel docs [path]` 读取当前来源正文，默认 `development/index.md`，输出来源路径与 CLI 版本；例如 `pluxel docs plugin-development/testing.md`。不会联网取得另一份 main 文档。Codex 从 `.agents/skills` 发现链接的 skill，AGENTS 保留显式入口；已有会话未发现新链接时重新打开会话。

## 统一外部依赖

每个工作区在自己的 `pnpm-workspace.yaml` 中集中声明版本，各包通过 `catalog:` 引用。核心 catalog 是 Pluxel 共用外部版本政策的唯一来源：Git CLI 读取所属 checkout，npm CLI 使用构建时生成的同一政策快照。项目仍保留自己的成员、依赖声明和 lockfile。

- `pluxel pncat add/remove/migrate`：添加、删除或迁移依赖声明，写入包清单与 catalog。
- `pluxel pncat clean`：仅清理没有声明引用的 catalog 项。
- `pluxel workspace sync`：用本 CLI 政策对齐已有 catalog 版本，只写 `pnpm-workspace.yaml`。
- `workspace sync --check`、`workspace doctor`、`source doctor`：检查声明、引用和版本差异；只读。
- `vp install` 或 `pluxel source install`：写入安装产物与 lockfile；source install 先同步版本政策。

工作区必须已有 `pnpm-workspace.yaml`（单包项目可使用 `packages: []`）。已有裸版本时先显式迁移，再同步：

```sh
cd /absolute/path/to/project
pluxel pncat migrate --yes --no-install
pluxel workspace sync
vp install
pluxel workspace sync --check
```

Git 工作区用 `source install` 替换 `vp install`：它在安装锁内同步 consumer 与相关 checkout 的版本政策，再生成 overlay 并安装，不自动迁移清单。显式 `--frozen-lockfile` 遇政策变更使锁过期时会失败；先普通安装并审查差异。

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
