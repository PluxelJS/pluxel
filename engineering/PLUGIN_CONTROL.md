# 插件控制材料与实例调用

公开用法由[插件控制指南](../docs/development/plugin-control.md)维护。控制链路复用原 Plugin identity、Host catalog、配置事务、provider generation 和脚本执行器。生成器提供标准地址方法与声明，Host 决定这些材料对应哪一个已接纳实现。

## 所有者与输入

| 所有者           | 入口                                                                                                                                       | 职责                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Host             | [`control-manifest.ts`](../packages/host/src/control-manifest.ts)                                                                          | 格式、规范编码、文件验证和标准地址提供者渲染的唯一协议实现      |
| Rolldown         | [`control/`](../packages/rolldown/src/control/index.ts)                                                                                    | 原 semantic facts、固定 TypeScript 程序、声明闭包与配置源码描述 |
| Host catalog     | [`catalog.ts`](../packages/host/src/catalog.ts)                                                                                            | 随候选接纳不可变的 control 附件，区分 available 和 unavailable  |
| Native loader    | [`control-material.node.ts`](../packages/host/src/control-material.node.ts)、[`loaded-modules.ts`](../packages/host/src/loaded-modules.ts) | 从实际加载的 owner/root 绑定材料，保持 constructor 的第一次记录 |
| Vite             | [`control.ts`](../packages/host-vite/src/control.ts)、[`host-vite.ts`](../packages/host-vite/src/host-vite.ts)                             | 比对真实求值输入、参与原更新批次与 type-only 依赖失效           |
| Script SDK       | [`control.ts`](../packages/host/src/agent/control.ts)、[`sdk.ts`](../packages/host/src/agent/sdk.ts)                                       | typed target、事务内配置检查和同进程实例视图                    |
| 材料读取         | [`materials.ts`](../packages/host/src/agent/materials.ts)                                                                                  | 从 committed catalog 取得有界快照，通过原认证连接提供分块读取   |
| Agent SDK 客户端 | [`materials.ts`](../packages/agent-sdk/src/client/materials.ts)                                                                            | 完整下载、验证和工具目录的原子发布                              |

Core 拥有规范身份和与精确地址值绑定的通用证据注册，不解释 Host 控制格式。class 与生成入口都提供 `definitionAddress()`、`nodeAddress()` 和 `nodeAddress(forkId)`。SDK 只接收完整 node address；调用证据不进入 equality、route 或持久化 key。

## 生成与声明

`createPluginControlPlugin` 是正式 Rolldown 插件，接入 `createPluginBuildPipeline`。它读取本次 `PluginSemanticsCollector` 的 `sourceDefinitions()` 与 `sourceContents()`，在 generateBundle 的 pre 阶段输出 `control/`，并把声明依赖加入原构建 watch。插件包在 tsdown 的原生 exports 钩子中组合作者的 customExports，同次生成开发和发布的 `./control` 导出；finalization 维护 `pluxel.control`，保留作者的字段顺序。modules 应用 metadata 与 standalone bootstrap 使用同一材料格式。

`generatePluginControl` 不求值插件。它固定 native TypeScript 程序读取的源码、声明和编译设置，在镜像文件系统中执行 declaration-only emit。Schema 表达式在镜像内生成导出的类型见证，便于 native emitter 表达大型 Schema，运行代码不会交付这些见证。

分析和镜像 emit 继承作者的 `target`、`lib` 及类型解析配置，镜像配置保持原配置的路径基址。tsdown 的原生 `tsdownConfigResolved` 提供最终配置路径或 `false`；直接调用接受同名 `tsconfig` 选项，省略时从 `root` 查找。整批程序由构建所有者确定，首个插件所在的包不能改变它。没有项目配置时才使用生成器默认环境。Node 项目不会额外获得 DOM globals，显式 `types` 和默认类型指令解析也不会被临时目录改变。

实例类型 S 使用完整 class 声明，保留继承、private nominal identity、重载、显式 this、泛型与递归关系。`typeImports: 'package'` 用于独立插件包，引用原公开包类型；默认 `closure` 用于应用/Vite，携带本地声明闭包和显式 ambient roots，保留公开外部包引用，作者仍需提供这些类型依赖。模式由构建所有者选择，不能由地址的 package-root 形式猜测包是否可安装。业务成员的手工 Pick 会使 `same(other: OriginalClass)` 与 `self()` 产生互不相容的身份，因此这里保持完整 class。闭包内的私有关系完整，另行安装的原实现声明属于另一个物理模块身份。可见性和权限仍由 TypeScript、Host 以及执行授权各自处理。

控制声明 emit 显式使用 `removeComments: false`，保留原生 emitter 可关联的公共 class、成员、继承及关联类型 JSDoc，`stripInternal` 沿用作者配置。入口的 descriptor 和 Instance alias 从原生 `Node.jsDoc` 取得原 class 说明，装饰器前的注释仍属于原 class；字符串里的伪注释不会被采纳。package 模式保持 canonical import，成员提示仍由原公开包的声明提供，材料内本地声明继续携带源文档供阅读。

配置 input/output 从原 Standard Schema 类型及 Part 树组合。输入保留默认值前的可选字段，输出保留校验和变换后的结果。无配置使用 `never`。`ConfigDeclaration` 类型及 JSDoc 记录 schema 表达式、节点路径和引用的本地源码声明，原配置字段 JSDoc 通过可选 `documentation` 字段交付。Input/Output alias 说明验证阶段并关联原源码描述。环境变量保持源码表达式，不在生成时读取环境。注释更新改变材料 snapshot，本地配置和实例的结构摘要继续排除文档差异。

JSON 不属于共享 ambient 声明。仅公开类型实际引用的 JSON 才进入声明材料，配置表达式引用的 JSON 原文进入源码描述与配置摘要；只在实现体中使用的数据保留在编译读集中。消费 JSON 类型依赖的作者项目需要启用 `resolveJsonModule`。

不能分析、无法 emit 或输入在生成期间变化时明确失败。构建因此失败；Vite 将候选的控制状态标为 unavailable，并保留它原有的应用更新语义。Host 的 status/list issues 显示 `control_analysis_failed` 或 `control_source_changed` 及原原因文本，修复并接纳后清除。原生 emit 检查完整相关模块的公开声明，同文件的应用工厂若推导出无法命名的匿名服务类型，应在源回调标注 `HostApplication` 返回值；生成器不会把错误声明改成 any/unknown 或删去公共导出来伪装成功。

上游声明通过原生 `@ts-ignore` / `@ts-expect-error` 明确允许的可选外部类型引用沿用原契约。生成器核对真实注释与作用行，保留原声明；未抑制的缺失引用仍失败，安装可选依赖后的真实声明闭包会改变对应摘要。

实际 ambient module 由 native symbol 和原始 ambient roots 提供。`skipLibCheck` 下缺少上游类型提供者而未出现诊断，不代表引用已经解析；例如 Elysia 将 `@types/bun` 标为 optional peer，但其公开声明仍直接引用 `bun`，独立构建作者需安装这个类型包。生成器不合成声明来填补缺失提供者。

## 文件与摘要

材料由 `index.mjs`、`index.d.mts`、声明闭包和 `manifest.json` 组成。format 2 的 JavaScript 使用确定性标准模板，从 `@pluxel/host/internal/control-reference` 创建冻结的地址提供者。上传加载器只为已验证的生成模块绑定这一框架入口。清单的每个 definition 明确记录 `module`，导出名在模块内唯一；验证器逐字核对所有可执行模块及对应声明，原 Plugin 代码不进入材料。文件路径必须是安全的相对路径，清单记录 UTF-8 字节数与 SHA-256。快照摘要取自规范编码后的 unsigned manifest。

发布 `./control` 的包显式维护兼容的 `@pluxel/host` peer；仅该入口需要 Host 时使用 optional peer，其他运行入口也使用 Host 时保留 required。`control-exports` 的共享检查在 tsdown exports 写回及 finalization 前校验，不推断版本或修补依赖声明。Host 不放入 dependencies/optionalDependencies，避免嵌套框架副本。

每个定义有独立的 config、instance 摘要；配置的 `null` 明确表示无配置。摘要输入包括格式、编译器版本、strictNullChecks 以及实际生成的规范化声明与依赖。配置摘要还包含 Schema 表达式和本地依赖，校验器/default 改变会失配。本地生成声明的注释、位置和展示空白经过规范化，原始材料变化仍会改变文件与快照摘要；未携带的外部声明按原文计算，注释变化也可能保守失配。保守的类型等价改写可以改变摘要。

生成器共用一次 native emit，按各定义的可达声明闭包计算实例摘要，配置类型与源码依赖单独追踪。实现体专用 import 不会让独立插件的摘要一起变化。`definitionInputs` 将这些依赖映回原 watcher 的 owner 索引；共享 ambient、编译 metadata 与同一文件内的多个 class 允许保守联动。

生成摘要描述声明兼容性，不能替代 owner 绑定。Native 对实际加载的 constructor 固定首次模块、包 facts 和材料；后续磁盘新文件不能给 ESM 缓存里的旧 constructor 换标签，也不能取消其原有的产物完整性校验。新求值的构造器才能绑定新输出。Standalone 由实际 bootstrap URL 显式登记控制清单。

Vite 在候选准备时核对 `ModuleRunner.evaluatedModules` 中实际缓存代码附带的 source map 原始输入，与生成程序的输入逐项比较。磁盘已经是 B 而缓存仍为 A 时，B 的声明不能贴到 A 的实现上。type-only 依赖进入原 route 的 owner 反向索引，更新通过原 watcher/driver 使相应 owner 失效。控制材料随候选 provenance 一起提交，读取只看 committed catalog。

## typed 配置与实例

`PluginDescriptor<I, O, S>` 的 `nodeAddress()` 返回带不变类型关联的 `PluginControlNodeAddress<I, O, S>`。标准工厂深度冻结身份，并通过 Core 的弱注册表将摘要绑定到这一个值。class 地址持有精确 constructor，生成地址持有原声明摘要；同地址的新版本不会覆盖旧证据。

SDK 在地址规范化之前读取并固定证据，然后交给原 Host coordinator。普通地址只提供动态管理。枚举 symbol 中的 opaque token 用于检测 spread / Object.assign 后的副本，只有弱注册表里的原对象有效；JSON 或显式 parse 得到纯身份，实例访问返回 `control_evidence_missing`。地址与提供者可以跨 run 保存，SDK 引用和实例视图仍受本次 run 限制。

引用统一提供 status、start、stop、restart。生成地址提供 instance；已声明配置时还提供 `ScriptPluginConfig<I, O>`。配置参数不再重复目标，也不重新推导输入类型。配置函数使用 readonly 函数属性，提取、赋值或注解后仍保持输入约束。配置不同的联合只开放 get，无配置或已擦除类型关联的描述符不开放 config；源码 class 地址提供原实例类型与未知字段的动态配置；普通动态地址提供动态配置而不开放业务 instance。引用的 address 保留输入地址的类型与证据，跨引用或 run 重新选择仍执行原检查。已知调用方、public exports、文档及生成项目入口统一使用这一形态。

SDK 工厂、引用和配置方法均由闭包持有目标，不依赖调用 receiver。选择先检查 scope；异步操作统一返回 `Promise<Result<T, E>>`，继续走原 run/queued 准入和排空。已知失败在被跟踪的 Promise 结算前转换为 Err，避免排空时误记 cleanup failure。未知异常继续 reject。配置、策略和日志结果在 `sdk-results.ts` 去除原 `ok` 后分流，保持所有来源、修订、持久化和采用信息；start/stop/restart 报告含协调或 lifecycle 问题时返回携带 report 的 Err。引用可以在 restart 后重新取得当前 generation 的实例，旧业务 view 仍然失效。Node/Vite describe 声明 plugin、plugin.config 和 plugin.instance 能力。

配置摘要在原 lookup/transaction 内检查，保留原 CAS 的错误顺序，并在 Schema 执行和持久化之前拒绝失配。没有先检查、再第二次排队写入的窗口。原 Host/Workbench 协议继续使用其领域结果，Script SDK 只在自己的返回边界投影；preview 不保存。公开错误按操作区分，持久化失败的 unknown 和保存后未采用的 application 状态保持原义。

实例获取通过 committed read，核对 descriptor、当前实现和真实 generation。回调在任何 Promise 接触业务实例之前创建 `Result.ok(view)`，以 Result 的成功值直接交付实例，避免 Promise 同化读取作者的 then。成员视图在本次 scope 缓存，每次方法/get/set 进入原 owner invocation，原 provider 作为调用 receiver；方法提取及显式 call 保留 JavaScript 的 this 行为，已识别的同 scope 直接实例参数可解包。当前 constructor 地址通过同一 scope 接入，规则见 [Dev Console](DEV_CONSOLE.md#操作-api-与资源)。

调用方用提供者的 nodeAddress 选定 default 或 fork，再使用一个 SDK 操作入口；控制方法可以直接提取，已有 SDK Result 可以直接返回。多步任务使用普通 async/await，检查 `isErr()` 并提前返回；需要构造或组合结果时从 `@pluxel/core/better-result` 导入。类型和原始 JSDoc 继续提供配置与业务信息。上传共享绑定和结果交付由 [Agent workflow](AGENT_WORKFLOW.md)维护。

标准 native Promise 保持原返回对象，由旁路 reaction 跟踪至结算；同步调用保持同步。scope 和 generation 等待已接纳工作。自定义 thenable、流、迭代器与嵌套返回资源遵守业务协议，视图不递归改写它们。本 realm 可识别的 native Promise 若 species 异常，明确抛出原异常；无法识别的自定义协议不提供自动跟踪保证。

同 scope 的 provider 异步工作与 coordinator 操作互相等待会死锁。SDK 从两个方向检查准入：活跃 provider 调用期间拒绝需要 coordinator 的操作；已有排队 Host 工作时拒绝新的业务调用，错误为 `borrowed_generation_conflict`。日志保持可用。调用方先 await 业务方法，再进行配置或生命周期操作。

视图不能跨 run 使用，也不把所有原始资源转成可撤回能力。同步 self 返回会映回当前视图；嵌套对象与异步返回继续保持业务值。对象重定义、删除、冻结和原型替换不属于成员视图支持的操作。

## 同步与脚本输入

Management major 13 的 `plugins.control-materials` 与 Vite 本地控制 target 复用原连接。材料读取独立于脚本执行开关，`scripts: false` 不初始化执行器。一次读取固定 committed catalog 及被选中的 definitions；CLI 保留已验证的原始材料和声明闭包，按 canonical entry 分组的同步模块只导出被选中且已接纳的定义。

每连接缓存最长 5 分钟、128 份材料、总量 64 MiB。索引分页列出定义，文件以 32 KiB UTF-8/base64 分块，保持现有 DTO/frame 预算。过期读取返回 `control_snapshot_expired`，由调用方重新开始同步。

CLI 的 `script sync` 和 `dev sync` 使用同一实现。完整验证后写入 `.snapshots/<digest>`，再原子切换 `current` symlink。模块路径按 canonical entry 的规范编码确定，具名导出沿用原名；特殊名称冲突在生成边界处理。同步输出准确 module/exportName，作者无需复现路径算法。原始材料只保留已验证的声明闭包与数据，运行模块由同一标准模板产生，并由同格式清单固定。工具检查 owner marker、文件内容和锁，拒绝覆盖作者文件或被修改的旧快照。已发布快照保留供原有导入使用，清理由显式维护完成。

材料完整性不证明作者安装的外部类型与生成环境相同。package 模式引用原包的公共声明，closure 模式保留公开外部包引用；这些本地声明会固定为本次脚本输入，但不与生成时的依赖声明逐项比对。作者须提供匹配版本；Host 的摘要检查只核对描述符与已接纳实现，不核验作者侧这些外部声明。

上传编译和 Vite 项目检查使用 native TypeScript 的固定输入读取器。读取器固定文件内容、缺失结果与目录 realpath，原子切换 current 后同一次编译仍读取原快照。纯控制入口必须通过完整清单和内容验证才允许进入上传工厂，并在检查结束后核对 TypeScript 实际使用了对应的声明文件；package exports 在两阶段切换会明确失败。上传格式 `pluxel-js-factory/3` 为 Core Better Result 和已验证控制模板提供两个固定共享绑定，其余框架运行时 import 继续拒绝。Vite 在原源码屏障后检查类型，加载仍由原 ModuleRunner 完成，并将实际缓存输入与受检输入比较；失败不会调用脚本导出函数。请求身份与 receipt 继续使用原协议，检查所得读集属于本次加载证据。

## 验证入口

| 边界                                                        | 测试                                                                                                                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 native emit、Part、源码表达式、名义类型与独立 consumer | [`control.test.ts`](../packages/rolldown/tests/control.test.ts)                                                                                                                        |
| 公共 typed API、无配置与联合关系                            | [`agent-control.typecheck.ts`](../packages/host/tests/agent-control.typecheck.ts)、`tsconfig.control.json`                                                                             |
| 实例、CAS/摘要顺序、取消与 generation 并发                  | [`agent-control.test.ts`](../packages/host/tests/agent-control.test.ts)                                                                                                                |
| 生成→编译→Node submit/receipt→业务与配置实际改变            | [`agent-control-delivery.test.ts`](../packages/host/tests/agent-control-delivery.test.ts)                                                                                              |
| Native 原 owner 材料与第一次 constructor 绑定               | [`control-material.node.test.ts`](../packages/host/tests/control-material.node.test.ts)                                                                                                |
| 受检输入与真实 Vite 缓存版本                                | [`environment-inputs.test.ts`](../packages/host-vite/tests/environment-inputs.test.ts)、[`dev-console-attachment.test.ts`](../packages/host-vite/tests/dev-console-attachment.test.ts) |
| 独立安装作者、TLS 管理认证、无源码接收端、同步与调用        | [`agent-installed.smoke.mjs`](../packages/services/tests/agent-installed.smoke.mjs)                                                                                                    |
| 类型入口、原子快照切换与 package exports 竞争               | [`script-inputs.test.ts`](../packages/rolldown/tests/script-inputs.test.ts)                                                                                                            |
| 同步导出稳定性、完整验证与作者目录冲突                      | [`script-sync.test.ts`](../packages/agent-sdk/tests/script-sync.test.ts)                                                                                                               |
| 开发和发布导出、作者定制与连续构建幂等                      | [`plugin-build.test.ts`](../packages/rolldown/tests/plugin-build.test.ts)                                                                                                              |
| 真实 HMR、独立插件摘要、相同源码与全部 generation 释放      | [`hmr-control.test.ts`](../packages/host-vite/tests/hmr-control.test.ts)、[`module-bytes.test.ts`](../packages/host-vite/tests/module-bytes.test.ts)                                   |
| Result 编码、预期失败、未知异常与取消排空                   | [`agent-runtime.test.ts`](../packages/host/tests/agent-runtime.test.ts)、[`agent-sdk.test.ts`](../packages/host/tests/agent-sdk.test.ts)                                               |
| 生成项目的正式安装、部署与项目脚本                          | [`smoke-starter.ts`](../packages/create/scripts/smoke-starter.ts)                                                                                                                      |

### 2026-11-15 落地验证

统一节点地址与精确证据、材料 format 2、工厂 format 3 和维护入口的完整工作区门禁通过：`workspace:verify` 136/136，包含全部 48 项构建任务。2745 个文件格式正确，1918 个文件的 lint 与类型检查零错误、零警告；文档生成 664 个文件。Core 407、Host 320、Rolldown 566、Host-vite 143、Services 384、CLI 278、Workbench 213 和 Shell 419 项测试通过。

正式材料校验覆盖 18 个包的 23 个定义、102 份材料，以及应用聚合的 5 个定义、9 份材料。CLI 内置的三份指南和开发 skill 与源码逐字一致。Create 完整安装 smoke 通过，生成项目门禁 14/14，部署完整性报告为 `INTACT`，57 项无差异；native、Vite 与项目脚本均实际执行。独立 CLI 插件模板 smoke 的生成项目门禁 4/4，通过正式 tarball 安装，在未安装可选 Commands 包时也能使用空服务测试宿主。

[`check-production.mjs`](experiments/tsgo-plugin-inputs/check-production.mjs) 通过真实 Core / Host 公开 exports 消费 dist 声明，不使用源码路径或自定义 conditions。TypeScript 7.0.2 的严格检查保留 `skipLibCheck: false`、ES2022 target 及公开声明需要的 `ESNext.Temporal` 标准库，10 条负例全部生效；配置、嵌套字段、Vault 和文件输入的五组 LSP 补全，以及错误字段的 TS2353 诊断通过。

交付验收沿用上表入口，关键检查包括：

- native 声明真实消费、配置表达式与 Part、JSDoc、名义关系、泛型、联合和无配置输入约束；注释变化更新材料快照，兼容性摘要保持对应规则。
- Result 的短路、JSON 编码及完整字节预算，未知异常与预期 Err 的区分，带业务 `then` 的实例交付，以及取消、队列和 generation 工作的真实排空。
- 编译器与真实 workerd 的共享 namespace 身份；标准 ESM 转工厂后的严格模式、同名变量隔离、特殊导出与重导出，以及原文件、原行号的错误定位。旧工厂格式明确拒绝。
- 独立 tarball 作者通过 TLS 认证同步并提交脚本，接收端无源码和编译器；核对 CAS、配置实际采用、业务方法与属性、原 receipt 和资源释放。
- 正式 exports 与材料完整性、连续构建和重复同步稳定性；真实 watcher 的暂停、apply、失败修复与 Host replacement；Create 生成项目的 native、Vite 与部署交付。

### 已知限制

Services 可选独立安装检查的严格声明部分有 Elysia `2.0.0-rc.0` 上游泛型声明的已知失败，本轮未重复此额外检查。仅导入 Elysia 的独立 TypeScript `7.0.2` 项目也能复现 TS2536 / TS2344；保留原 library checking 和诊断约束。

嵌套缓存 fixture 曾在 30 秒内无输出而超时；本轮进程与异步资源诊断捕获到 Vite+ CLI 的 native `run()` 等待，尚未进入 fixture 构建命令，具体根因未定位。后续默认环境的完整门禁通过，未增加自动重试、延长超时或放宽断言。此前记录的 Typst 首次启动与一次 HMR 结果缺失也没有根因修复证据。模型 token 消耗与任务成功率对照实验尚未开展，见[统一维护路径的独立研究](proposals/UNIFIED_API_AND_MAINTENANCE.md#尚待独立研究)。

跨 isolate 的业务调用投影、持久化任务和离线 Schema validator 是各自独立的后续能力。普通 class 声明与同进程实例视图不提供这些后端。
