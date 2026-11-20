# CLI、模板与源码工作区

CLI 拥有命令加载、项目生成、跨仓库 source overlay 和开发资源。编译归 [Toolchain](TOOLCHAIN.md)，包政策归 [Governance](GOVERNANCE.md)，脚本客户端/终端归 [Agent Workflow](AGENT_WORKFLOW.md)。

## CLI 与 scaffold 所有权

CLI 是静态目录和交互 adapter。可选领域工具从启动 cwd 的依赖图解析官方 owner、验证 optional peer 后 lazy import public subpath；`--root` 是领域输入，不改变解析基准。help/version/completion 不扫描依赖或加载领域主体。owner 保持 external，缺包、版本、subpath、加载失败分开诊断，最后保留 cause。agent 命令从必需直接依赖的 SDK internal/cli 挂载。

全局发行 launcher 委托最近直接声明 CLI 的项目 executable；Git CLI 固定自身 checkout，已绑定 workspace 拒绝不同 checkout。source 命令在委托前运行，以便建立含本地 CLI 的 overlay。依赖查找止于最近 Git/workspace/lockfile，声明但安装不全则失败；package scripts/CI 固定本地 CLI。

Git launcher 加载 dist 前核对 src/bin/scripts/manifest/构建配置内容指纹，构建成功才写 fingerprint；mtime、缓存恢复和 checkout 搬移不改变判定。缺失/过期时提示精确重建，不自动 build，也不判断其他框架产物。npm launcher 无源码指纹。仓库 pluxel/dev scripts 直接运行 launcher，显式 compile，避免在线操作恢复制品触发 HMR。

create 独立交付固定 starter，不加载 CLI/远程模板/registry。目标为空，staging 后原子落盘；tsdown exports.bin 产出带 shebang 的 Node ESM，copy 交付模板。CLI 的 docs/skill 只从权威正文打包，构建输入包含 docs 和 pluxel-development skill，setup 再建立忽略提交的资源入口。

new 流程为 source→acquire→validate→answers→byte plan→materialize→可选 install。bare name 仅 bundled plugin，local source 必须显式路径；`pluxel-template.jsonc` 只含 identity/包管理器/prompts，只有 .tpl 支持固定插值，其他按 bytes 复制。拒绝任意执行、循环和 symlink。

byte plan 在写前固定最终 bytes，并验证 UTF-8/token/path/portable collision/目标。materializer 不重读模板；force 仅覆盖已确认文件，以 temp+rename 写入，目录整体不回滚。bundled 默认 vp install，local 需 `--install`；Vite+ 选择包管理器，模板约束或 `--pm` 通过原生 `VP_PACKAGE_MANAGER` 传入，相同种类保留完整版本声明。

starter 的 Host package 拥有唯一 Vite/app/build，Web package 只含浏览器。README/AGENTS/安装/完成提示遵循[统一命令](../docs/development/workspace-toolchain.md#统一命令入口)：Vite+ 执行和任务缓存，hk 检查，Pitchfork 进程/端口/反代，mise 安装/pin。create packed smoke 覆盖完整 workspace/Vite/distribution，CLI packed smoke 覆盖独立 Plugin，各验证真实产物。

### 项目 profiles

`package.json` 的 `pluxel.dev` 按名称声明 profile，root 默认为声明目录，显式 root 须在该目录内真实存在；command/pitchfork 二选一。选择顺序是显式 profile→default 指名→唯一 profile；default 为保留字段，须引用已有名称。

command 在声明目录前台继承终端/退出码，CLI 注入 `PLUXEL_DEV_PROJECT/PROFILE`。控制台捕获 canonical declaring package、profile、root；Pitchfork profile 先按原生 daemon 短服务名筛选，启动再核对完整 ID。同 root/短服务的不同 namespace 多实例仍须 `--instance`，不能越过归属检查。

配置发现止于最近 Git/pnpm workspace；`--root` 选择起点，不绕过已发现配置。无配置时用最近 package root，显式 `--root` 用该目录；此时 `--profile` 失败。普通 dev status/run/hmr/instances 只读实例描述和握手，不启动服务。多个匹配实例再明确选择。

scripts 默认 true。仅 Pitchfork profile 可设 false（如 docs），启动等待原生 readiness 后重读状态/URL，status 查 Pitchfork；run/instances/--instance 在副作用前报 `unsupported_scripts`，不伪造 Host console。create 只声明真实默认 app/前台 local。

Vite presenter 拥有控制台 URL，runtime environment 解析公开 origin。启动不新增 supervisor/就绪轮询，复用实例时读取当前地址；Pitchfork 始终为可选启动集成。细节见[项目入口](../docs/development/dev-console.md#项目入口与启动方式)。script/dev run、统一 receipt/输出/退出码归 [Agent Workflow](AGENT_WORKFLOW.md#运行身份失败和预算)，材料 module/exportName 与快照归 [Plugin Control](PLUGIN_CONTROL.md#同步与脚本输入)。

## Independent source workspaces

pluxel source 是开发期 pnpm 编排。consumer 的 `pluxel.sources.jsonc` 声明稳定 Git identity，机器 registry 映到 checkout；扫描每个来源自己的 workspace/manifest，拒绝名称冲突/cycle，从 consumer dependency 递归选择 package closure。源码 devDependencies 留在其 checkout。

源码 CLI 从自身 module realpath、最近 CLI package 和 workspace/Git 标记发现核心 checkout，优先同 identity 的 registry，不落盘，list 展示，unregister 仅删显式项。独立 provider 也加入隐式核心边，参与安装顺序，但不扩张最终 consumer package closure。

singletons 仅用于外部 nominal/private 类型身份：实际选中源码包必须有唯一 direct dependency owner，安装该 owner 后解析物理 copy，项目不记录机器 node_modules 路径。

机器本地 pnpmfile/代理原子生成在 .pluxel，代理名为 repository-hash/package-slug-package-hash；lockfile 保留稳定可审查路径和外部依赖，不泄露 checkout。代理只暴露所选 package，移动目录只更新 registry/link，包含 consumer root 的 source package 拒绝。每 checkout 按自己的闭包、Corepack 精确 packageManager 生成 overlay，不合并 lockfile。bootstrap 与 .pluxel 由 CLI 管理并 ignore，存在时才检查 canonical 内容。

首次由全局或 vp dlx CLI 执行 register/install；不能放在 consumer pnpm script，避免脚本前隐式 install 先将私有包发往 registry。source build 的重复 `--package` 指定精确 artifact bootstrap（如 Vitest preset），省略才构建整个 selected artifact closure。只选 manifest 引用标准构建目录或 bin 的包，纯 src export 零构建；非标准产物用 `pluxel.sourceBuild` 覆盖。

source install/build 按 canonical checkout 路径排序锁住整个来源图，共享 provider 串行、独立图可并行。install 持同锁调用内部 build，失败也等待各层已启动操作 settle 后释放；install marker 仅表示未完成。坏锁/无活持有者不自动接管，防止仍在写的子进程失去所有权。操作者显式处理。直接上游 vp/verify 和 source 返回后的 consumer task 不在锁内。

执行层级来自 package/nested source edges，同层独立 checkout 并行。优先交精确目标给 provider 的 Vite+ graph/cache；force 才 `--no-cache`。根声明 vite-plus 时用 Node 执行根本地 vp run package#build，避免 pnpm exec 的隐式安装，其他 provider 用通用 pnpm recursive filter。子进程移除继承 `COREPACK_ROOT`，并把 `PNPM_CONFIG_WORKSPACE_DIR` 设为自身根，保留各仓精确 pnpm 和 catalog。

source 不改变 workspace membership/release。单仓 workspace 命令只写 pnpm-workspace patterns；单包无文件时仅 root，添加成员前创建 workspace 文件。发现按正向 glob 固定前缀裁无关树，坏 manifest/读目录失败中止，scan 候选仍需显式加入。runtime 动态来源只发布 file entry，和开发 package overlay 分属两条生命周期。

## 实现与验证

实现位于 [`packages/cli/src/`](../packages/cli/src/)，starter 位于 [`packages/create/`](../packages/create/)。CLI tests 覆盖无副作用帮助、owner/version、byte plan、overlay；packed smoke 分别走真实 create workspace 与 CLI Plugin。

source 场景覆盖独立 lockfile/packageManager、checkout 移动、collision/cycle、无本地 CLI 首次安装、精确 bootstrap 和空构建闭包。manifest/exports 由各包 build 生成。

## 开发资源接入

CLI workspace/setup.ts 拥有资源来源、`.pluxel/development.json` 状态、docs/skill 链接、精确 ignore 和 AGENTS marker。Git source install 安装前预检占用/来源，安装构建后物化；workspace setup 可独立修复，npm 用相同入口。原文件/未知链接冲突显式失败，不自动移除 Git 跟踪。

source doctor 检查 overlay+资源，workspace doctor 检查资源+治理。Host-vite 在 configureServer 开始为已声明 CLI 或有 source/setup 状态的 workspace 调项目 CLI doctor；临时独立 fixture 不自动接入，生产不加载。开发脚本顺序为 doctor→cache build→Vite。

Host-vite 沿 root 父链到项目边界，取最近显式 source/setup 根；无显式根则用声明触发的项目边界。成员声明只决定最近安装 owner，不能改变 workspace root。安装查找不跨 Git/workspace/lockfile，显式子根错误交 CLI 原样诊断。Host-vite 只定位输入/executable，资源、YAML、成员规则由唯一 doctor 验证。

docs 从当前 owning checkout（Git）或 dist/resources（npm）读取，拒绝路径逃逸；离线 setup 不联网，升级后重新 setup。用法见[源码工作区](../docs/development/source-workspaces.md)。

## 外部依赖政策

根 pnpm-workspace 拥有安装范围；CLI workspace/dependencies.ts 读取、报告并调内联 pncat/sync plan/apply，不复制 writer。Git 读 owning checkout，npm 读构建的 dependency-policy.json。peer catalog 不作安装版本政策，其他同名冲突拒绝。

workspace sync 显式写，check/doctor 只读；source install 在锁内复用同步，重读后再 overlay/install。只更新已有 catalog 版本，裸声明迁移归 pncat；peer-only catalog 保留，共享 peer 引用变更报冲突，不暗改 manifest。CLI fingerprint/build inputs 包括权威 catalog 和 pncat 源码。

pluxel pncat 在 launcher 来源校验后委托内联 CAC parser，临时恢复 upstream argv；原生命令保持 writer/选项/输出，embedding context 只给 init import 和提示。`@pluxel/cli/pncat` 发布 runtime/自包含声明，根声明构建覆盖 CLI/vendor 两处源码，产物不写 vendor。packed CLI 不需另装 pncat/源码。回归验证 sync 不改 `package.json` bytes，覆盖 migrate→sync、peer 冲突及 Git/npm 来源。

### 工作区任务图

根 vite.config 声明聚合边，包级配置拥有命令、依赖、input/output，scripts/vite-tasks 只给共用默认。标准 package scripts 委托原生任务；发布依赖可有环，聚合显式使用 package#compile 而不依赖递归包拓扑。vp run build/test/typecheck/verify 为整仓入口，定向用 vp run package#compile，CI 运行 vp run --concurrency-limit=2 `workspace:ci`，实际 graph/cache 负责调度。

CI native consumer 集合同时拥有任务选择/typed lint 排除，用短场景替代本地 native/Electron 完整验收，见[GitHub Actions](../docs/development/workspace-toolchain.md#github-actions)。workspace/ci build 在依赖完成后查源码声明污染。cache 位于 `node_modules/.vite/task-cache`，mise、共享任务策略、延迟 pack 为显式 inputs；应用 lazyPlugins 使任务扫描不启动服务或要求暖制品。服务归 Pitchfork，缓存和验证边界见 [Testing](TESTING.md#ci-scheduling-and-cache)。
