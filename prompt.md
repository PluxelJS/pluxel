# Composable Plugin Host 后续接手

你接手的是已经实现、验证并推送的重构，后续目标是提高可读性和维护性。先复查事实，再选一个有明确收益的事项完成，不要重做架构或把下面所有建议当成必须实现的功能。

后续用户已确定「Core 加服务包、Host 创建前静态安装、普通管理 Plugin 复用 Workbench，服务采用单入口，Runtime 收敛为 Services 根入口的默认 Host」的设计方向。设计见
[可组合服务、Host 管理面与共享 Workbench](engineering/proposals/COMPOSABLE_RUNTIME_SERVICES.md)。
本轮交付范围为提案整理、文档提交与推送，尚未实现；后续实施应先读该提案的顺序、待验证问题和验收门槛。
下文维护建议不覆盖这项新目标，也不能据此把提案入口当成已可用 API。

## 基线与约束

- 分支：`refactor/composable-plugin-host`。
- 已推送实现：`21655fa2`，`refactor!: unify plugin hosts and runtime applications`。
- 用户允许破坏性重构，不要求兼容旧配置；优先优雅、清晰、高效，测试在精不在多。
- 首先检查当前分支、工作区和后续提交，不覆盖别人新写的改动。本文件是交接记录，当前代码及正式工程文档优先。
- 阅读 `AGENTS.md`、`.agents/rules/library-api-design.md`、`engineering/DESIGN_PRINCIPLES.md`、`engineering/PLUGIN_SYSTEM.md`，再按 `engineering/README.md` 阅读 HMR、Runtime、Toolchain 等领域文档。修改插件还要读 `plugins/AGENTS.md` 和包内文档。
- 用户行为变更同步更新 `docs/`；公开包变更补 Tegami 记录，不手工修改版本或 publish-lock。

## 已确定的架构

| 层                     | 职责                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `@pluxel/core`         | Plugin graph、DI、generation、effects                                      |
| `@pluxel/host`         | 统一 catalog、运行意图、协调器、来源契约；不依赖 Runtime                   |
| `@pluxel/host-dynamic` | 无启动副作用的 file/directory 来源声明、发现、监听、撤回                   |
| `@pluxel/host-dev`     | 共享 ModuleRunner、模块身份与失效、候选提交、恢复及串行开发队列            |
| `@pluxel/runtime`      | 在相同 Host 协调器上安装官方服务和持久化策略                               |
| `@pluxel/runtime/vite` | 官方开发组合，接入 Runtime、HTTP、Workbench/Node artifacts、可选开发控制台 |

固定插件直接声明在 `plugins`；可选 `sources` 增加动态来源。没有必要恢复单独的 static Runtime 包。
`host-dynamic` 不依赖 `host-dev`；来源发现与模块求值分离。Package Manager 是普通插件及来源生产者，不拥有第二套 graph。

官方应用默认导出普通对象，使用 `satisfies RuntimeApplication`，配置在加载/启动边界验证。
Vite 只写 `runtime({ entry: './src/app.ts' })`；无需根据 static/dynamic 叠加不同插件。
生产使用 `application()` from `@pluxel/rolldown/build`。官方示例和 create monorepo 已完成迁移。

## 建议下一轮按顺序审查

### 1. 命名及内部转发收尾

`packages/runtime/src/application/vite.ts` 还存在 `StaticVite*`、`PreparedStaticArtifacts`、旧 route 文案；
`packages/runtime/src/internal/reconciliation/` 有转发到 Host 并保留旧名字的薄文件。
逐一确认调用点后统一适合当前职责的名字，删除没有独立责任的转发层。
不要盲目替换所有 `static`：静态发行产物和 execution 协议字段仍可能有真实语义，修改协议需要同步生产者、消费者和文档。

### 2. 收紧开发层的公开接口

检查 `packages/host-dev/src/vite.ts` 与 package exports。目前 `host()` 与 runner、candidate、recovery 等框架集成 helper 共用入口。
判断哪些是真实的用户扩展契约，哪些仅由 Runtime/工具链消费；必要时把后者移到明确的 internal subpath，直接迁移调用方。
不要为了每个 helper 新建包，也不要删除真正有消费方的底层能力。每次调整都检查打包后的 imports 和类型入口。

### 3. Package Manager 的状态可见性

当前安装结果表达包安装和 entry 发布；catalog 接纳与运行状态要另行查询。这是有意的所有权边界。
检查实际 Workbench 操作能否让用户找到拒绝原因，以及生产 `PLUGIN_SOURCE_RESTART_REQUIRED` 的处理方式。
只有发现展示缺口才补 UI/诊断，复用现有 Host 状态；不要把 graph 或生命周期状态复制进安装器。

### 按证据再决定的优化

- 开发队列目前为 FIFO。一次多包安装可能产生多个有效来源事件；先测量求值次数与耗时，再考虑事件合并，不新增平行调度器。
- Runtime Vite 组合文件较大。若实际修改反复跨越职责，可拆成有明确所有权的私有函数/模块，保持一条更新队列和一个接受边界。
- 自定义轻量 Host 任意装配 Workbench/Node artifact 能力尚无稳定公开契约。这是提案中保留的未来工作，等待具体消费者，不预先设计通用 hook 框架。

## 必须保持的行为与明确限制

- 固定插件和动态来源共享模块身份、catalog 和生命周期语义；安装不等于自动启动。
- 新增/升级来源只更新受影响闭包，不穿过 Core/Runtime/native 单例去重启无关固定插件。
- 候选求值或结构校验失败保留已接受状态；图已跨接受点后的 lifecycle failure 不伪装成回滚。
- 显式停止不会被后续源码修复覆盖；关闭后不再发布新候选，资源由所属会话排空和释放。
- Workbench 按 publication/producer epoch 撤回旧会话并完整刷新页面，不承诺页内 remote 热替换。
- 生产原生 ESM 支持初始加载、新入口及撤回。修改或重新发布已加载入口要求重启进程；不能用 query 参数声称刷新了传递依赖。
- 开发期 ESM 可以更新；Node 持有的 CommonJS/native 文件原地覆盖仍需重启。正常升级应使用新的不可变安装路径。
- 冻结产物通过 framework facade 和限定来源图的 Node resolve hook 共享框架身份。新增作者入口时核对该映射，不能让插件加载另一份 Core/Runtime。
- `PLUXEL_DATA_ROOT` 的可写数据目录应在不可变 dist 之外。

## 验证基线及最小复查

基线已通过以下验证。这是历史证据，不代表后续修改自动通过，也不等于声称完整 `pnpm verify` 已无条件通过。

- 全仓 34 个 typecheck task。
- Runtime 621 项测试；Host、Host-dev、Host-dynamic、CLI、Package Manager 的相关测试。
- Host-dev 真实 Vite 安装场景：空来源 → 安装 → 失败候选 → 升级 → 卸载；固定插件仅初始化一次。
- 全新 Node 进程运行冻结应用，安装插件旁放置会抛错的另一份 Runtime，仍正确共享发行包的框架身份。
- pnpm 原生引擎实际 registry 安装、entry 发布和删除。
- 官方宿主：27 个插件状态无遗留 issue；动态入口发现、显式启动、v1→v2 HMR、停止后更新仍停止、撤回均在同一 host epoch 验证。
- 官方生产包：预期插件运行，HTTP/Workbench、PNG 生成与 S3 存取通过；运行时写入不改变发行文件 hash。
- create 真实 tarball → 外部工作区安装 → 类型检查/测试/构建 → 生产与 Vite/React/Workbench smoke。
- 格式、改动范围 lint、治理、迁移门禁、源码声明检查通过。全仓 lint 曾遇到已跟踪的 `.outline-check` 演示文件问题及一个无关 warning；后续 CI 收尾修复了该演示的无效 tabindex、通知字段解构和已有格式问题。

优先复用现有测试：

- `packages/host-dev/tests/installed-plugin.smoke.mjs`
- `packages/runtime/tests/vite-runtime.test.ts`、`vite-recovery.test.ts`、`vite-workbench-hmr.test.ts`
- `packages/runtime/tests/production-dynamic-source.test.ts`
- `packages/rolldown/tests/production-framework.test.ts`
- `packages/create/scripts/smoke-starter.ts`（包内 `test:starter`）

先运行改动直接所属边界。只有改了构建、包边界或模板才扩大到打包 smoke；不要为命名整理新增实现镜像测试。
工具链重编译并发过高曾造成 5/15 秒测试超时，低并发复查通过；不要用增加测试数量或一律增大超时来掩盖资源竞争。
官方 Plugin 构建必须使用其声明的 `pluxel build`，直接运行裸 tsdown 会缺失 semantic lowering。
共享包构建会清理 dist，避免与依赖这些产物的运行实例检查并发执行。

## 在线操作与交付

检查运行中的宿主前读 `docs/development/dev-console.md`，发现当前实例并固定 `--root`、`--instance`，通过普通 TypeScript 导出函数检查真实状态。
不要复用旧实例 ID，也不要用测试宿主代替当前应用。此前任务启动的临时 Vite 进程和诊断源码已清理。

每次交付说明具体改了什么、验证了什么、仍有哪些限制；保留精简有效的回归证据，删除临时探针。
这份交接文件完成使命后可删除；不要把它发展成第二份架构权威文档。
