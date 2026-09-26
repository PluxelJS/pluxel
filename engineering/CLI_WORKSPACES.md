# CLI、模板与源码工作区

修改命令 owner 加载、项目生成、跨仓库源码链接或窄 bootstrap 时读本页。这些是开发期编排，不进入 Host runtime graph。Plugin 编译规则见 [TOOLCHAIN](TOOLCHAIN.md)，包依赖政策见 [GOVERNANCE](GOVERNANCE.md)。

## CLI 与 scaffold 所有权

CLI 是静态命令目录和交互 adapter，按所选命令从启动 cwd 的依赖图解析官方 owner、检查 optional peer range，再 lazy import public subpath。`--root` 是领域输入，不改变 owner 解析基准。Help/version/completion 不扫描依赖、不加载 owner、不访问 registry 或自动安装。Owner 保持 external；缺包、不兼容、缺 subpath 与加载异常分别诊断，最后一种保留 cause。

全局 launcher 委托最近直接声明 `@pluxel/cli` 的项目 executable；声明但安装不完整则失败。`source` 命令族先于委托运行，允许建立包含项目 CLI 的 overlay。依赖查找止于最近 Git/workspace/lockfile 边界，不把物理父仓库当 fallback。Package scripts 与 CI 固定本地 CLI。

`@pluxel/create` 独立发布固定、无插值 starter；不加载 CLI、远程模板或 registry。目标必须不存在或为空，先 staging 再原子落盘。tsdown `exports.bin` 生成带 shebang 的 Node ESM executable，`copy` 交付 template；不使用 Node SEA `exe`。模板只链接上游文档，不复制 API 快照。

`pluxel new` 的唯一流程为 source → acquire → validate → answers → byte plan → materialize → optional install。Bare name 只解析 bundled plugin template，local source 须显式路径；无 remote fallback。`pluxel-template.jsonc` 只声明 identity、包管理器与 prompts。仅 `.tpl` 支持固定插值，其余文件按字节复制；不接受任意代码、命令、循环或 symlink。

Byte plan 在写入前完成 UTF-8/token/path/portable collision/目标检查，持有最终 bytes。Materializer 不重读模板；`--force` 只覆盖 plan 已确认的精确 existing files，每文件 temp+rename，不承诺整个目录 rollback。Bundled template 默认 install，local template 仅显式 `--install` 才执行包管理器。

Starter 的 Host package 拥有唯一 Vite/应用/freezer，独立 Web package 只拥有浏览器代码；根 Turbo 只编排。Portless 只路由现有 listener，不成为 runtime capability。Browser assets 在 freezer 后写入时，必须再次调用同一个 distribution finalizer。目录、命令和样例以 [create README](../packages/create/README.md) 为准。

CLI packed smoke 验证独立 Plugin scaffold，create packed smoke 验证完整 workspace、Vite 与 production distribution；两者不是输出 parity。CLI 不提供第三方 command discovery/registry，capability ID 的类型映射只用 type import，不能提前加载可选 owner。

## Independent source workspaces

`pluxel source` 是 CLI 拥有的开发期 pnpm 编排层。消费仓库只在 `pluxel.sources.jsonc` 声明稳定 Git
repository identity；机器级 registry 将 identity 映射到 checkout。CLI 扫描各 checkout 自己的
`pnpm-workspace.yaml` 和 package manifest，拒绝 package name collision 与 source dependency cycle，
再从消费方依赖递归推导需要链接和安装的 package closure。源码 package 的 devDependency 属于其自身
checkout，不进入消费方 closure。

少数外部 package 同时具有类型期 nominal/private identity 时，项目可声明 `singletons`。CLI 只接受在
本次实际选中的源码 package 中有唯一 direct dependency owner 的名称，并在该 owner checkout 安装后
解析物理实例；不得把 owner 的 `node_modules` 相对路径写进项目配置。

pnpm override 是一次安装的生成细节，不进入项目 workspace 配置。CLI 生成 machine-local `.pnpmfile.cjs`，并在 `.pluxel/` 原子生成 pnpmfile
和 `repository-hash/package-slug-package-hash` package link；lockfile 因而只记录可审查的稳定代理路径，保留外部依赖可复现性且不泄漏机器
目录。代理只暴露实际依赖的 package，不把整个 checkout 嵌入 consumer 文件树；移动 checkout 或 package 目录只更新
machine registry 和 package link。source package 若包含 consumer root 会被拒绝，因为这种所有权拓扑无法形成无环代理。每个 checkout 始终按自己的依赖闭包生成
overlay，并通过 Corepack 尊重精确的 `packageManager` 版本，所以被下游编排不会改写出另一份 lockfile。根 bootstrap 与
`.pluxel/` 一样由 CLI 管理并被 Git 忽略；workspace governance 只在它存在时验证 canonical 内容。

首次安装由独立的全局或 `pnpm dlx` CLI 直接执行标准 `pluxel source` 命令：操作者用 `source register`
登记其他 checkout，再在 consumer 中运行 `source install`。源码运行的 CLI 根据自身模块 realpath、最近 CLI package 与 Pluxel workspace/Git 标记自动发现核心 checkout；显式 registry 同 identity 记录优先。发现结果不落盘，`source list` 显示来源，`source unregister` 只删除显式登记。CLI 不从 cwd、目录邻接、父仓库
或同机其他 checkout 猜测 repository identity。不得把首次 bootstrap 放进 consumer 的 pnpm script：pnpm 可能在
执行 script 前先做 dependency-status install，此时 source overlay 尚未生成，会把私有 source package 错误解析到
registry。package closure、overlay、构建与 lockfile 始终由唯一的 `pluxel source` 实现拥有。
`pluxel source build --package <name>` 可以重复传入 source closure 内确实需要 artifact 的精确 target；它只用于需要先使一个
package export 可执行的窄 bootstrap，例如 Vitest config 的 `@pluxel/test`。不带 `--package` 才构建整个 selected artifact closure。
上游构建优先把精确目标交给其 Turbo task graph，并默认尊重该 checkout 自己的 cache；显式 `--force` 才绕过。
repository 执行层级从 selected package dependency edge 与 nested source edge 推导，同层独立 checkout 可以并行。无 Turbo 时
回落到 pnpm recursive filter，不在消费仓库复制 package filter。`build` script 本身不代表 source
consumer 需要产物：CLI 只选择 live manifest 引用顶层标准构建目录或暴露 executable bin 的 package，
直接导出 `src` 的 package 保持零构建；上游任务图仍拥有目标内部的 artifact prerequisites。非标准 artifact contract
可用 package manifest 的 `pluxel.sourceBuild` 明确覆盖推断。
CLI 已经为 checkout 选择并启动 pnpm，因此调用 Turbo 时关闭它重复执行的 package-manager 检查；这只避免
Turbo 把合法的 `devEngines` pnpm range 当成无效精确版本，不绕过 CLI 的 pnpm 校验或 checkout 自己的 lockfile。
CLI 同时移除 consumer 进程的 `COREPACK_ROOT` 标记，让独立 checkout 及其 nested workspace 能按最近的精确
`packageManager` 自行切换 pnpm，而不是错误继承 consumer 的版本。

该能力不改变 pnpm workspace membership，也不合并独立仓库 lockfile/release。现有 `pluxel workspace`
仍只管理一个仓库内部的 workspace patterns。它同样不复用 dynamic source producer：后者拥有 runtime
file entry publication，`pluxel source` 只发生在开发期 package resolution/build。

## 实现与验证

入口位于 `packages/cli/src/`，starter 位于 `packages/create/`。CLI 测试保护命令无副作用加载、owner 解析与版本拒绝、模板 plan 的路径/bytes 校验和 source overlay 闭包；create/CLI 的 packed smoke 分别验证完整 workspace 与独立 Plugin 模板。

验证跨仓库场景时覆盖独立 lockfile/packageManager、checkout 移动、package collision/cycle、首次安装无本地 CLI、精确 `--package` bootstrap 与空构建闭包。生成 manifest/exports 仍由各 package build 拥有，不在编排器中复制。
