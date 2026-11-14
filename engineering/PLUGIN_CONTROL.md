# 插件控制材料与实例调用

公开用法由[插件控制指南](../docs/development/plugin-control.md)维护。控制链路复用原 Plugin identity、Host catalog、配置事务、provider generation 和脚本执行器。生成器提供数据与声明，Host 决定这些材料对应哪一个已接纳实现。

## 所有者与输入

| 所有者        | 入口                                                                                                                                       | 职责                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Host          | [`control-manifest.ts`](../packages/host/src/control-manifest.ts)                                                                          | 格式、规范编码、文件验证和纯描述符渲染的唯一协议实现            |
| Rolldown      | [`control/`](../packages/rolldown/src/control/index.ts)                                                                                    | 原 semantic facts、固定 TypeScript 程序、声明闭包与配置源码描述 |
| Host catalog  | [`catalog.ts`](../packages/host/src/catalog.ts)                                                                                            | 随候选接纳不可变的 control 附件，区分 available 和 unavailable  |
| Native loader | [`control-material.node.ts`](../packages/host/src/control-material.node.ts)、[`loaded-modules.ts`](../packages/host/src/loaded-modules.ts) | 从实际加载的 owner/root 绑定材料，保持 constructor 的第一次记录 |
| Vite          | [`control.ts`](../packages/host-vite/src/control.ts)、[`host-vite.ts`](../packages/host-vite/src/host-vite.ts)                             | 比对真实求值输入、参与原更新批次与 type-only 依赖失效           |
| Script SDK    | [`control.ts`](../packages/host/src/agent/control.ts)、[`sdk.ts`](../packages/host/src/agent/sdk.ts)                                       | typed target、事务内配置检查和同进程实例视图                    |
| 材料读取      | [`materials.ts`](../packages/host/src/agent/materials.ts)                                                                                  | 从 committed catalog 取得有界快照，通过原认证连接提供分块读取   |
| CLI           | [`sync.ts`](../packages/cli/src/script/sync.ts)                                                                                            | 完整下载、验证和工具目录的原子发布                              |

Core 不解释控制格式，也不生成第二种插件身份。描述符里的 `definition` 始终是原 `PluginDefinitionAddress`；fork 在使用点增加 `forkId`。

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

材料由 `index.mjs`、`index.d.mts`、声明闭包和 `manifest.json` 组成。JavaScript 仅包含确定性渲染的冻结描述符；验证器逐字核对渲染结果，禁止伪装成控制入口的额外 JavaScript。文件路径必须是安全的相对路径，清单记录 UTF-8 字节数与 SHA-256。快照摘要取自规范编码后的 unsigned manifest。

每个定义有独立的 config、instance 摘要；配置的 `null` 明确表示无配置。摘要输入包括格式、编译器版本、strictNullChecks 以及实际生成的规范化声明与依赖。配置摘要还包含 Schema 表达式和本地依赖，校验器/default 改变会失配。本地生成声明的注释、位置和展示空白经过规范化，原始材料变化仍会改变文件与快照摘要；未携带的外部声明按原文计算，注释变化也可能保守失配。保守的类型等价改写可以改变摘要。

生成器共用一次 native emit，按各定义的可达声明闭包计算实例摘要，配置类型与源码依赖单独追踪。实现体专用 import 不会让独立插件的摘要一起变化。`definitionInputs` 将这些依赖映回原 watcher 的 owner 索引；共享 ambient、编译 metadata 与同一文件内的多个 class 允许保守联动。

生成摘要描述声明兼容性，不能替代 owner 绑定。Native 对实际加载的 constructor 固定首次模块、包 facts 和材料；后续磁盘新文件不能给 ESM 缓存里的旧 constructor 换标签，也不能取消其原有的产物完整性校验。新求值的构造器才能绑定新输出。Standalone 由实际 bootstrap URL 显式登记控制清单。

Vite 在候选准备时核对 `ModuleRunner.evaluatedModules` 中实际缓存代码附带的 source map 原始输入，与生成程序的输入逐项比较。磁盘已经是 B 而缓存仍为 A 时，B 的声明不能贴到 A 的实现上。type-only 依赖进入原 route 的 owner 反向索引，更新通过原 watcher/driver 使相应 owner 失效。控制材料随候选 provenance 一起提交，读取只看 committed catalog。

## typed 配置与实例

`PluginDescriptor<I, O, S>` 的类型关联包含不变标记；JavaScript 不携带类型标记或逻辑。`sdk.plugin(target)` 同步验证并保存不可变目标快照，返回 `ScriptPlugin<T>`。引用持有地址和描述符摘要，各次操作仍通过原 Host coordinator 读取当前状态。`fork(id)` 选择同一定义的另一个 fork，保留原引用，不物化节点或启动实例。

引用统一提供 status、start、stop、restart。typed descriptor 提供 instance；已声明配置时还提供 `ScriptPluginConfig<I, O>`。配置参数不再重复目标，也不重新推导输入类型。配置函数使用 readonly 函数属性，提取、赋值或注解后仍保持输入约束。配置不同的联合只开放 get，无配置或已擦除类型关联的描述符不开放 config；动态地址保留原未知配置操作且不开放业务 instance。已知调用方、public exports、文档及生成项目入口统一使用这一形态。

工厂、fork、引用和配置方法均由闭包持有目标，不依赖调用 receiver。选择和派生先检查 scope；异步操作继续走原 run/queued 准入和排空。引用可以在 restart 后重新取得当前 generation 的实例，旧业务 view 仍然失效。全局 plugins.list、policy、updates 和 logs 保持各自职责，日志可用引用的 address 作为原生过滤条件。Node/Vite describe 声明 plugin、plugin.config 和 plugin.instance 能力。

配置摘要在原 lookup/transaction 内检查，保留原 CAS 的错误顺序，并在 Schema 执行和持久化之前拒绝失配。没有先检查、再第二次排队写入的窗口。配置成功与失败继续返回原领域报告，preview 不保存。

实例获取通过 committed read，核对 descriptor、当前实现和真实 generation。`{ instance }` 外层避免 Promise 同化读取作者的 then。内层为本次 scope 缓存的成员视图，每次方法/get/set 进入原 owner invocation，原 provider 作为调用 receiver；方法提取及显式 call 保留 JavaScript 的 this 行为，已识别的同 scope 直接实例参数可解包。

标准 native Promise 保持原返回对象，由旁路 reaction 跟踪至结算；同步调用保持同步。scope 和 generation 等待已接纳工作。自定义 thenable、流、迭代器与嵌套返回资源遵守业务协议，视图不递归改写它们。本 realm 可识别的 native Promise 若 species 异常，明确抛出原异常；无法识别的自定义协议不提供自动跟踪保证。

同 scope 的 provider 异步工作与 coordinator 操作互相等待会死锁。SDK 从两个方向检查准入：活跃 provider 调用期间拒绝需要 coordinator 的操作；已有排队 Host 工作时拒绝新的业务调用，错误为 `borrowed_generation_conflict`。日志保持可用。调用方先 await 业务方法，再进行配置或生命周期操作。

视图不能跨 run 使用，也不把所有原始资源转成可撤回能力。同步 self 返回会映回当前视图；嵌套对象与异步返回继续保持业务值。对象重定义、删除、冻结和原型替换不属于成员视图支持的操作。

## 同步与脚本输入

Management major 10 的 `plugins.control-materials` 与 Vite 本地控制 target 复用原连接。材料读取独立于脚本执行开关，`scripts: false` 不初始化执行器。一次读取固定 committed catalog 及被选中的 definitions；CLI 保留已验证的原始材料和声明闭包，聚合入口只导出被选中且已接纳的定义。

每连接缓存最长 5 分钟、128 份材料、总量 64 MiB。索引分页列出定义，文件以 32 KiB UTF-8/base64 分块，保持现有 DTO/frame 预算。过期读取返回 `control_snapshot_expired`，由调用方重新开始同步。

CLI 的 `script sync` 和 `dev sync` 使用同一实现。完整验证后写入 `.snapshots/<digest>`，再原子切换 `current` symlink。聚合入口使用地址摘要后缀避免来源重名；它也有同格式清单。工具检查 owner marker、文件内容和锁，拒绝覆盖作者文件或被修改的旧快照。已发布快照保留供原有导入使用，清理由显式维护完成。

材料完整性不证明作者安装的外部类型与生成环境相同。package 模式引用原包的公共声明，closure 模式保留公开外部包引用；这些本地声明会固定为本次脚本输入，但不与生成时的依赖声明逐项比对。作者须提供匹配版本；Host 的摘要检查只核对描述符与已接纳实现，不核验作者侧这些外部声明。

上传编译和 Vite 项目检查使用 native TypeScript 的固定输入读取器。读取器固定文件内容、缺失结果与目录 realpath，原子切换 current 后同一次编译仍读取原快照。纯控制入口必须通过完整清单和内容验证才允许进入上传工厂，并在检查结束后核对 TypeScript 实际使用了对应的声明文件；package exports 在两阶段切换会明确失败。原框架运行时 import 继续拒绝。Vite 在原源码屏障后检查类型，加载仍由原 ModuleRunner 完成，并将实际缓存输入与受检输入比较；失败不会调用脚本导出函数。请求身份与 receipt 继续使用原协议，检查所得读集属于本次加载证据。

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
| 同步导出稳定性、完整验证与作者目录冲突                      | [`script-sync.test.ts`](../packages/cli/tests/script-sync.test.ts)                                                                                                                     |
| 开发和发布导出、作者定制与连续构建幂等                      | [`plugin-build.test.ts`](../packages/rolldown/tests/plugin-build.test.ts)                                                                                                              |
| 真实 HMR、独立插件摘要、相同源码与全部 generation 释放      | [`hmr-control.test.ts`](../packages/host-vite/tests/hmr-control.test.ts)、[`module-bytes.test.ts`](../packages/host-vite/tests/module-bytes.test.ts)                                   |

### 2026-11-14 落地验证

插件引用重构使用实际构建入口和隔离的 Node/Vite 应用完成验证：

- 最终 `mise exec -- vp run --concurrency-limit=2 workspace:verify`：136/136 项任务成功，73/121 项可缓存任务命中；2726 个文件格式正确，1905 个文件没有 lint 警告、错误或类型错误。仓库治理、源码声明和文档站构建通过，生成 664 个文件。
- `mise exec -- vp run --concurrency-limit=2 workspace:build`：48/48 项任务成功；正式插件包、modules 应用和文档站均完成构建。
- 完整包测试通过：Host 37 文件 / 285 项、Rolldown 51 / 556、host-vite 28 / 142、Services 62 / 384、CLI 21 / 236。生成器的 18 项用例包含原生声明消费、配置源码、包身份、编译环境及 ambient 提供者缺失，并覆盖作者启用 `removeComments` 时的原始 JSDoc、继承声明、关联类型和注释变化后的摘要稳定性。Host 的独立严格类型检查覆盖提取方法、配置输入约束、fork、异构联合及无配置描述符。
- 18 个包的正式控制入口共交付 23 个定义、102 个清单列出的材料文件，另有 18 份清单；实际 plugin-host 应用交付 5 个定义、9 个材料文件和 1 份清单。使用公开验证器核对清单摘要、文件字节、纯 JavaScript 渲染及开发/发布 exports。
- 独立作者从真实 tarball 安装 CLI/SDK，通过 TLS 管理认证同步材料、编译和提交脚本；接收端删除源码且不安装编译器。配置实际完成 2→4→8，每次通过插件引用调用原插件的异步方法并读取属性；重复同步保持相同快照。独立安装回归、4 项 CLI 同步回归和 TLS 脚本执行通过。Node/Workerd 回归保留原有调用与资源释放检查，控制方法提取后继续服从 run 和 generation 寿命。
- 真实 Vite watcher 覆盖配置与类型依赖变化、暂停和 apply、独立定义摘要、相同源码、失败修复、Host replacement 和 generation 释放。测试继续核对业务结果及原 receipt，不通过重启代替更新。

前一轮交付验证中曾分别遇到嵌套 `vp run` fixture 的 30 秒超时，以及 HMR 失败修复后一次脚本结果缺失。已补充子进程退出信息和完整 receipt、Host 状态、generation 诊断；直接用例、包测试、对应 Vite Task 与后续完整门禁中的相应用例均已通过。这两次瞬态失败尚未定位独立根因，没有增加重试或放宽断言，也没有据此推测并修改生产行为。

额外运行 Services 的可选独立安装检查 `mise exec -- vp test run --config tests/installed.config.mts`：3 项通过、1 项失败。实际可选服务运行及插件引用调用通过，最后的严格声明检查在 Elysia `2.0.0-rc.0` 的上游泛型声明中失败。使用 TypeScript `7.0.2`、`@types/bun` `1.3.14`、`@types/node` `26.6.6`，仅写 `import type { Elysia } from 'elysia'; export type Baseline = Elysia` 的独立项目同样产生 30 条 TS2536 和 35 条 TS2344。该基线未导入 Pluxel；它的 `exact-mirror` 为 `1.2.6`，安装检查解析为 `1.2.7`。原可选声明示例与重构前的 `cd4c370f` 完全一致，未扩大诊断允许列表或关闭 library checking；该检查继续记为失败。

跨 isolate 的业务调用投影、持久化任务和离线 Schema validator 是各自独立的后续能力。普通 class 声明与同进程实例视图不提供这些后端。
