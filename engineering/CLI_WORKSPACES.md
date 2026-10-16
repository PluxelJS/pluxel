# CLI、模板与源码工作区

修改命令 owner 加载、项目生成、跨仓库源码链接或窄 bootstrap 时读本页。这些是开发期编排，不进入 Host runtime graph。Plugin 编译规则见 [TOOLCHAIN](TOOLCHAIN.md)，包依赖政策见 [GOVERNANCE](GOVERNANCE.md)。

## CLI 与 scaffold 所有权

CLI 是静态命令目录和交互 adapter，按所选命令从启动 cwd 的依赖图解析官方 owner、检查 optional peer range，再 lazy import public subpath。`--root` 是领域输入，不改变 owner 解析基准。Help/version/completion 不扫描依赖、不加载 owner、不访问 registry 或自动安装。Owner 保持 external；缺包、不兼容、缺 subpath 与加载异常分别诊断，最后一种保留 cause。

发行版全局 launcher 委托最近直接声明 `@pluxel/cli` 的项目 executable；Git CLI 固定自身 checkout，不委托另一份项目 CLI，已绑定工作区拒绝不同 checkout。声明但安装不完整则失败。`source` 命令族先于委托运行，允许建立包含项目 CLI 的 overlay。依赖查找止于最近 Git/workspace/lockfile 边界，不把物理父仓库当 fallback。Package scripts 与 CI 固定本地 CLI。

`@pluxel/create` 独立发布固定、无插值 starter；不加载 CLI、远程模板或 registry。目标必须不存在或为空，先 staging 再原子落盘。tsdown `exports.bin` 生成带 shebang 的 Node ESM executable，`copy` 交付 template；不使用 Node SEA `exe`。模板保留开发资源 setup 指令；CLI 构建从唯一上游正文打包 docs/skill，消费方由 setup 创建忽略提交的入口。

CLI build 的输入包含仓库 `docs/` 与 `pluxel-development` skill 正文；它们变化必须使缓存失效，不能发布旧资源后再由运行时修补。

Git launcher 加载 dist 前核对 CLI 的 src、bin、构建 scripts、manifest 与包级构建配置的内容指纹。
构建完成后才写入 dist 指纹，Vite+ 恢复或移动 checkout 不依赖 mtime；缺失或过期时拒绝执行并提示精确重建命令。
此检查不证明其他框架产物最新，也不自动构建；npm launcher 不要求源码或指纹。源码仓库的 `pluxel` / `dev` scripts 直接执行 launcher，不带构建依赖；首次准备和修改 CLI 后显式 compile，避免在线操作恢复缓存产物触发 HMR。

`pluxel new` 的唯一流程为 source → acquire → validate → answers → byte plan → materialize → optional install。Bare name 只解析 bundled plugin template，local source 须显式路径；无 remote fallback。`pluxel-template.jsonc` 只声明 identity、包管理器与 prompts。仅 `.tpl` 支持固定插值，其余文件按字节复制；不接受任意代码、命令、循环或 symlink。

Byte plan 在写入前完成 UTF-8/token/path/portable collision/目标检查，持有最终 bytes。Materializer 不重读模板；`--force` 只覆盖 plan 已确认的精确 existing files，每文件 temp+rename，不承诺整个目录 rollback。Bundled template 默认 install，local template 仅显式 `--install` 才执行包管理器。

Starter 的 Host package 拥有唯一 Vite 配置、应用与构建，独立 Web package 只拥有浏览器代码；mise 固定工具与环境，hk 拥有 Git hooks 和文件检查，Pitchfork 拥有开发进程、端口和反代，Vite+ 拥有构建、检查与包任务图和缓存。

`package.json` 的 `pluxel.dev` 直接以名称声明 profiles。每个 profile 的 `root` 默认声明目录，显式值必须解析为该目录内的真实 Vite root；`command` 与 `pitchfork` 必须且只能选择一个。一个 package 可以声明多个 profile，共用或分别使用 Vite root；显式 `--profile` 优先，其次选择 `pluxel.dev.default`，最后选择唯一 profile。`default` 是保留字段，必须引用已声明名称。

普通 command 在声明目录前台执行，继承终端并传递退出状态，CLI 自动注入 `PLUXEL_DEV_PROJECT` 与 `PLUXEL_DEV_PROFILE`，无须用户配置。控制台捕获 declaring package 的 canonical 目录与 profile，连接时按该目录、profile 名和 Vite root realpath 筛选。Pitchfork profile 根据控制台原生 `PITCHFORK_DAEMON_ID` 的短服务名筛选，启动时再解析并核对完整服务 ID；同 root、同短服务但不同 namespace 的多实例仍要求明确选择。前台启动不创建后台 supervisor 或轮询就绪；复用实例时读取当前地址。

向上发现配置止于最近 Git / pnpm workspace 边界；`--root` 选择发现起点，默认 cwd。没有声明时控制台采用最近 package 根目录，若显式传入 `--root` 则采用该目录本身；没有配置却指定 `--profile` 必须失败。`--root` 不绕过已发现配置。控制台 profile 的 `dev status/run/instances` 仅依赖本地实例描述与握手，不调用 Pitchfork、不自动启动；按 profile 绑定过滤后，多个候选使用 `--instance`，该选项不能越过归属检查。

`console` 默认 true。只有 Pitchfork profile 可以显式设置 false，用于文档站等没有 Pluxel Host 的服务：启动遵守 Pitchfork readiness，随后重新读取服务状态与公开 URL；status 查询 Pitchfork，run/instances/--instance 在产生效果前报 unsupported_console。此类服务不创建假控制台，也不生成 Vite Application / Workbench 输出。框架仓库的 docs script 使用该 profile；create 模板只包含真实存在的默认 app 与前台 local。

控制台地址由 Vite URL presenter 拥有，不复制反代命名、Workbench 挂载路径或日志历史。Pitchfork 是可选启动集成，不成为 runtime capability；控制台直接读取已捕获的启动归属，不调用服务管理器；公开地址由 Host 环境契约解析。配置与使用见[开发控制台](../docs/development/dev-console.md#项目入口与启动方式)。Browser assets 在应用构建后写入时，必须再次调用同一个 distribution finalizer。目录、命令和样例以 [create README](../packages/create/README.md) 为准。

`result/cancel` 只接受绑定原 root/instanceId/runId/serviceId 的 receipt，不重新解析当前项目，不转投重启后的实例；nonce 不进入 receipt 或公开诊断。执行队列、取消、资源释放与结果保留仍由控制台内核拥有，见 [DEV_CONSOLE](DEV_CONSOLE.md)。

CLI packed smoke 验证独立 Plugin scaffold，create packed smoke 验证完整 workspace、Vite 与 production distribution；两者不是输出 parity。CLI 不提供第三方 command discovery/registry，capability ID 的类型映射只用 type import，不能提前加载可选 owner。

## Independent source workspaces

`pluxel source` 是 CLI 拥有的开发期 pnpm 编排层。消费仓库只在 `pluxel.sources.jsonc` 声明稳定 Git
repository identity；机器级 registry 将 identity 映射到 checkout。CLI 扫描各 checkout 自己的
`pnpm-workspace.yaml` 和 package manifest，拒绝 package name collision 与 source dependency cycle，
再从消费方依赖递归推导需要链接和安装的 package closure。源码 package 的 devDependency 属于其自身
checkout，不进入消费方 closure。

加载独立 provider checkout 时也加入 Git CLI 的隐式 Pluxel 来源，保持直接 install 与下游编排时的 overlay 一致。
该边同时参与安装顺序；provider 自己的 workspace/devDependencies 决定其安装闭包，不扩张最终 consumer 的包闭包。

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
登记其他 checkout，再在 consumer 中运行 `source install`。源码运行的 CLI 根据自身模块 realpath、最近 CLI package 与 Pluxel workspace/Git 标记自动发现核心 checkout；CLI owning checkout 优先于同 identity 的 registry 记录，并自动进入 Pluxel 源码闭包。发现结果不落盘，`source list` 显示来源，`source unregister` 只删除显式登记。CLI 不从 cwd、目录邻接、父仓库
或同机其他 checkout 猜测 repository identity。不得把首次 bootstrap 放进 consumer 的 pnpm script：pnpm 可能在
执行 script 前先做 dependency-status install，此时 source overlay 尚未生成，会把私有 source package 错误解析到
registry。package closure、overlay、构建与 lockfile 始终由唯一的 `pluxel source` 实现拥有。
`pluxel source build --package <name>` 可以重复传入 source closure 内确实需要 artifact 的精确 target；它只用于需要先使一个
package export 可执行的窄 bootstrap，例如 Vitest config 的 `@pluxel/test`。不带 `--package` 才构建整个 selected artifact closure。
上游构建优先把精确目标交给其 Vite+ task graph，并默认尊重该 checkout 自己的 cache；显式 `--force` 才绕过。

`source build` 与 `source install` 在操作入口按 canonical checkout 路径排序获取整个来源图的 operation lock，共享 provider 串行、独立来源图可并行。安装持有同一把 operation lock 调用内部 build，不重新获取；原 install marker 仍只表示安装未完成。每层已启动的操作必须全部 settle 后才能在失败路径释放所有权。损坏或无存活持有者的锁不自动接管，因为其子进程可能仍在写产物；明确诊断后由操作者确认并清理。直接运行上游 Vite+/verify 及 source 返回后的消费者任务不属于该协调范围。
repository 执行层级从 selected package dependency edge 与 nested source edge 推导，同层独立 checkout 可以并行。无 Vite+ 时
回落到 pnpm recursive filter，不在消费仓库复制 package filter。`build` script 本身不代表 source
consumer 需要产物：CLI 只选择 live manifest 引用顶层标准构建目录或暴露 executable bin 的 package，
直接导出 `src` 的 package 保持零构建；上游任务图仍拥有目标内部的 artifact prerequisites。非标准 artifact contract
可用 package manifest 的 `pluxel.sourceBuild` 明确覆盖推断。
根 manifest 声明 `vite-plus` 的 checkout 直接以 Node 执行该根本地安装的 `vp run <name>#build`，不经 pnpm exec 触发隐式安装；多个精确目标逐一交给同一原生任务图并复用缓存，强制构建使用 `--no-cache`；其他独立来源继续使用通用 pnpm recursive build。
CLI 同时移除 consumer 进程的 `COREPACK_ROOT` 标记，让独立 checkout 及其 nested workspace 能按最近的精确
`packageManager` 自行切换 pnpm，而不是错误继承 consumer 的版本。
每次 checkout 子进程同时将 `PNPM_CONFIG_WORKSPACE_DIR` 重设为自己的根，使嵌套成员脚本仍使用所属 catalog，禁止继承 consumer 的工作区根。

该能力不改变 pnpm workspace membership，也不合并独立仓库 lockfile/release。现有 `pluxel workspace`
仍只管理一个仓库内部的 workspace patterns，成员声明只写入 `pnpm-workspace.yaml`。缺失声明的单包项目只包含根 package；添加成员前需创建 pnpm workspace 文件。发现时坏清单与目录读取错误会中止操作，`workspace scan` 记录的候选目录仍需显式加入成员清单。它同样不复用 dynamic source producer：后者拥有 runtime
file entry publication，`pluxel source` 只发生在开发期 package resolution/build。

## 实现与验证

入口位于 `packages/cli/src/`，starter 位于 `packages/create/`。CLI 测试保护命令无副作用加载、owner 解析与版本拒绝、模板 plan 的路径/bytes 校验和 source overlay 闭包；create/CLI 的 packed smoke 分别验证完整 workspace 与独立 Plugin 模板。

验证跨仓库场景时覆盖独立 lockfile/packageManager、checkout 移动、package collision/cycle、首次安装无本地 CLI、精确 `--package` bootstrap 与空构建闭包。生成 manifest/exports 仍由各 package build 拥有，不在编排器中复制。

## 开发资源接入

CLI `src/workspace/setup.ts` 拥有开发资源来源、`.pluxel/development.json` 完成状态、docs/skill 链接、精确 ignore 与 AGENTS 标记块。Git `source install` 在安装前预检占用与来源，在安装构建后物化资源；`workspace setup` 可单独修复资源，npm 用户也使用它。原文件与未知链接冲突必须显式处理，CLI 不自动移除 Git 跟踪。

`source doctor` 同时检查源码 overlay 与资源；`workspace doctor` 检查资源及工作区治理。Host-vite 在现有 Vite host configureServer 的最前面，对声明 CLI 或已有 source/setup 状态的工作区调用项目 CLI doctor，复用同一检查而不复制诊断逻辑；独立临时测试 fixture 不自动接入工作区。生产不加载此检查。开发脚本先 doctor，再缓存 build，再启动 Vite。

Host-vite 沿 Vite root 的父链、止于最近 Git/workspace/lockfile 边界，选择最近显式 source/setup 根作为 doctor 输入；没有显式根时，CLI 声明触发对项目边界的检查。成员包声明 CLI 只选择最近安装 owner，不把成员目录变成 workspace 根。CLI 安装查找可到同一项目边界，不能跨边界借用父仓库；显式子根错误仍交由 CLI 按该根诊断，不回退到父根、不自动 setup。Host-vite 只发现输入及 executable，资源、YAML 和成员治理仍由同一个 CLI doctor 验证。

`docs` 直接读取当前来源的正文，禁止路径逃逸。Git 来源是 owning checkout；发行版来源是构建打包的 `dist/resources`。npm 安装后的离线接入无需网络；资源升级后重新 setup。完整用法由[源码工作区](../docs/development/source-workspaces.md)维护。

## 外部依赖政策

核心 `pnpm-workspace.yaml` 拥有版本范围；CLI 的 `workspace/dependencies.ts` 只负责读取政策、报告差异和调用内联的
`@pluxel-internal/pncat/sync` plan/apply API，不另写 manifest/catalog writer。Git 读取 owning checkout，npm 使用构建生成的
`dist/resources/dependency-policy.json`。peer catalog 不作为安装版本政策；其他同名条目冲突必须报错。
`workspace sync` 是显式维护入口，`--check` 与两个 doctor 保持只读；`source install` 在安装锁内复用相同同步，
重读计划后才生成 overlay 和安装。同步只写已有 catalog 的版本；裸声明迁移由原生 pncat 命令拥有。Peer-only catalog 保留，共享 peer 引用在版本变化时报告冲突，不隐式改写 manifest。

CLI 指纹及 Vite+ build inputs 必须包含权威 catalog 与内联 pncat 源码；政策改动不能继续执行旧构建。
pncat 作为构建依赖内联交付，packed CLI 检验无需另装 pncat 和 Git 源码即可同步消费者。

`vp exec pluxel pncat` 在 Pluxel launcher 来源校验之后把参数交给内联 pncat 的原生 CAC parser，原生命令继续拥有 writer 和选项语义；临时恢复原生 argv 布局供 upstream add/remove/revert 使用。`@pluxel/cli/pncat` 发布配置 runtime 和自包含声明，消费方不需要独立 pncat 依赖。CLI 声明构建的根配置覆盖 CLI 与 vendor 两处实际源码，不向 vendor source 目录发射产物。

内联 pncat 的 embedding context 只提供 init 配置 import specifier 与 init/detect 命令提示；sync 的 command 参数同样由调用入口提供，原生默认 pncat。生成逻辑仍由原生命令拥有。原生入口保留自己的 pncat 输出。同步回归必须断言所有 package.json 字节不变，并覆盖 migrate → sync、peer 冲突及 Git/npm 两种政策来源。

### 工作区任务图

根 `vite.config.ts` 声明依赖聚合任务，包级 `vite.config.ts` 保留真实命令，`scripts/vite-tasks.ts` 只生成 Vite+ 原生依赖与缓存配置。标准 `build` / `test` / `typecheck` package scripts 委托对应原生任务，保留 pnpm 消费入口。发布依赖图可以有环，因此根构建不使用 `vp run -r` 的隐式包拓扑；聚合任务使用显式 `package#compile` 边。根 `vp run build` / `test` / `typecheck` / `verify` 使用原生聚合任务；定向执行使用 `vp run @package/name#compile`。CI 全量执行 `vp run verify`，由原生缓存复用未变化任务。verify 在检查、治理、构建、类型与测试依赖完成后检查源码声明污染，不维护自制 affected 选择器。

缓存位于 `node_modules/.vite/task-cache`。mise、共享任务策略和延迟 pack 执行器是显式缓存输入，包级额外输入和输出由共享任务策略声明。dev 服务仍由 Pitchfork 管理，不能套进清理环境与缓存的有限任务。应用插件用 Vite+ `lazyPlugins` 延迟加载，任务元数据扫描不启动框架服务或要求上游已有构建产物。
