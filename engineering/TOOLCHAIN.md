# 工具链：声明分析与 Plugin 构建

Rolldown 拥有 Plugin 源码分析、lowering ABI、静态查询和插件包构建。应用装配见 [Application Build](APPLICATION_BUILD.md)，Workbench/Node 制品见 [Artifact Build](ARTIFACT_BUILD.md)，CLI/跨仓库编排见 [CLI Workspaces](CLI_WORKSPACES.md)。

## Offline plugin inspection

`@pluxel/agent-sdk/source` 发布 `inspectPlugin`、`listPlugins`、`inspectFile`、`inspectProject` 普通函数，实现与类型由 Rolldown `inspect/` 拥有。每次调用建立有界读取快照，复核文件后返回冻结结果，并在调用内释放资源；查询间无共享 watcher、队列或索引，取消统一为 `InspectionError`。公开用法见[源码查询](../docs/development/inspection.md)。

源码发现沿显式 source-spaces 中的静态 import 图查定义，动态来源保留 gaps。结果注明 current-disk/query-process/runtimeMatch: unverified；Host 的 committed catalog 和生成控制材料各由运行面维护。

构建与查询共用以下分析入口：

- `pluginSemanticsPlugin.ts`：`analyzeSemanticModule` 生成 definition、direct dependency、Part/mount 和源码范围，`lowerModule` 生成注入代码。
- `configSourcePlugin.ts`：`extractConfigDeclarationFacts` 校验声明并确定 field/schema 范围，构建再 render/normalize。
- `staticConfigEnvironment.ts` 解析 application factory、shadowing、binding helper 和 mapping。构建以原始表达式及引用出处解析目标路径，再用 `projectRawInput` 投影 transport。
- Workbench 源码查询沿当前插件的 `publish` 追踪定义与条目。查询结果属于作者源码，实际被绑定的节点由 Workbench 在消费方发布时校验。见[查询 Workbench 入口](../docs/development/inspection.md#workbench-entries)。

有 application 的查询在单次调用中固定 root/entry/sourceSpaces。package target 按该 entry 的上下文解析；source target 按正式 package、最具体 source root、native realpath/containment 选择。无 application 时 workspace 包优先。同 canonical definition 的物理来源冲突使查询失败；离线 resolver 不运行 Vite/custom hooks，定向 source-entry 查询也不扩张 plugins/file 的 workspace 发现范围。

inputs 返回 Plugin 的 env/file bindings 和应用配置表达式位置，不读取部署值或执行工厂。可静态确认的 fork 记录 forkId，其他关系保留诊断及源码位置。configPath 表达 input mapping，root 是 []，Part 按 occurrence path 展开；dependency aggregate 与 inputs 属于整个 Plugin，partPath 仅筛选 parts/config/dependency origins。未知关系保留 gap，schema 符号也不能替代 Host 的运行时同对象检查。

离线 config/Vault 投影沿原始表达式追踪 Valibot 工厂、真实重导出和目标字段。能覆盖目标的动态 spread、字段赋值和传给未知函数的可变对象，均在无法证明输入形状的位置报告。生成器复用 `projectRawInput` 的输入类型和失败分类，并把诊断关联到声明的源码位置和 binding 使用处。静态读取的文件进入 watch，修改依赖会更新 `.env.example`。可证明的封闭 Vault record 键在构建期核对，带业务 check 或 fallback 的键由 Host 验证。Control SDK 从原声明取得 input/output 类型。

供离线部署使用的 schema 在构造后应保持不变。解析器检查所追踪模块中针对字段表及别名的操作，其他模块运行时对已构造 schema 的改写超出了构建时可观察的范围。

同次查询共享已读文件和总预算，返回前复核成功读取内容。revision 标记观察内容与显式解析选择；它不是 Host revision，也不覆盖原子文件系统状态或全部负向候选。分页 cursor 绑定查询/结果。预算、取消、source_changed 穿过 resolver 恢复路径，以查询级失败结束。可选 sections 见[源码查询](../docs/development/inspection.md#结构与依赖)，Vault 用法、RPC 类型展开和运行时影响分析另有边界。

验证需要同源码/同解析上下文的构建与查询一致，另保留已知独立预期；覆盖多 entry、实际 package、symlink/source-space、动态 gap、重复 Part 和无求值。构建后的入口还须在普通 Node 中查真实源码，确认位置可用于下一步修改。

## Package source inference

package provenance 来自显式 exports 和唯一根 named export。推断 package plan 与读取 public entries 共用 source selector，优先 `@pluxel/hmr`、`@pluxel/source`、development；plain/import/default 仅在指向可执行 TypeScript 时成为 source entry，显式 source condition 可指 JavaScript。built JS、types 和声明文件不触发源码推断。

自动 plan 仅覆盖根导出 marked Plugin 的包，普通源码库的本地 Plugin 仍按 source-space 定位；显式 package build 要求至少一个 marked Plugin。已建 plan 仍检查无条件 JS 导出，嵌套条件适用相同规则。Plugin-bearing subpath、重复根导出、跨包 re-export 的规则见 [Identity](PLUGIN_IDENTITY.md)。

OXC 对未安装包/相对文件返回正常未命中；已发现物理包时，坏 manifest、exports 拒绝、缺入口附 importer/specifier/conditions/清单路径/cause 报错，最近损坏清单也不会被父包替代。OXC 的部分失败没有稳定错误码，无物理目录时 alias/tsconfig 失败仍可能与未命中混淆，空值不能直接推断为缺安装。

细分 alias/tsconfig 失败需要稳定的上游错误类型，或能用输入事实区分两种结果的回归样本。诊断保留原始 cause，错误文案的措辞不能作为分类依据。

## Database migrations

`pluxel database generate` 从 `defineDatabase` 的导入来源确定 `postgresql` 或 `sqlite`，在临时目录运行对应的 Drizzle Kit。SQL、journal 和 snapshots 属于 Drizzle，Pluxel 清单只记录 lineage。校验器检查 journal 方言、SQL 文件覆盖和时间戳顺序。PG 根据 snapshot 调整生成的外键、枚举和序列的默认 schema 限定名，保留字面量、注释与已发布历史。SQLite 保留 Kit 输出。

追加迁移和 `rebase --lineage <id>` 都在新历史通过校验后更新源文件。rebase 只替换迁移文件，保留同目录的其他内容。`check` 在隔离副本重新生成以检测 schema drift，`check --against <上一版迁移目录>` 核对同 lineage 已发布前缀的 tag、时间戳、breakpoints 和 SQL 原文哈希。

Vite 和生产 compiler 都从声明所在包读取迁移，将 `readMigrationFiles()` 的结果嵌入服务端的 `defineDatabase` 调用。独立包从这次读取的数据生成 `dist/database/migrations`，保留 journal 和 SQL 原文及已捕获的 snapshots。插件代码和发布目录对应同一份历史。浏览器图不携带 SQL 或 Drizzle。开发服务器跟踪声明使用的 journal、lineage 清单与 SQL 文件。

`reset-on-schema-change` 从空历史生成一个 baseline，以除去随机 identity 的规范化 Drizzle snapshot 计算 lineage。发布制品包含 SQL 和单条时间戳为 0 的原生 journal。临时目录在读取后释放。[服务端迁移](DATABASE.md#schema-evolution)

## Versioned Plugin lowering ABI

生成模块只从 `@pluxel/core/toolchain` 导入 ABI v2：`__setPluginDefinition`、`__setPluginConfig`、`__setPluginParts`、`__setPluginPartConfig`、`__setPluginPartRequires`、`__setPluginPartOptional`，payload 均携带相同 numeric `abiVersion`。Core/Host/Rolldown 需成套升级并重构 Plugin；v1 缺 Part constructor facts，按不支持版本拒绝。

helper 将 sealed immutable facts 放入求值期 WeakMap staging。canonical namespace 求值后，route 调 `consumePluginDefinitionCandidate`，一次合并 marker/definition/config/reachable Part，验证、删除 staging 并缓存唯一 frozen candidate。后续读取返回同对象，HMR 由新 constructor 创建新 candidate。Part facts 可跨 definition 复用，候选接纳后不可再修改。

ABI v2 分开 constructor 顺序与 graph：root `constructorRequires` 只含 direct ordered 参数，`candidate.requires` 是 root 后接 Part depth-first first-seen 的 definition 去重全集，每个 `PartNode.requires` 保留该 Part direct order。Part 参与 occurrence 构造与诊断，共用 owning Plugin 的图和 override。

| 诊断                                          | 拒绝条件                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| plugin_lowering_abi_unsupported               | ABI 不支持                                                                 |
| plugin_declaration_missing / invalid          | 声明缺失，或 payload/identity/Part 不一致                                  |
| plugin_caller_view_private_brand_unsupported  | Plugin 继承链含 ECMAScript instance #private 成员                          |
| plugin_caller_view_callable_field_unsupported | 跨节点 callable 是 arrow/function/bind 实例 field；应使用 prototype method |
| plugin_caller_view_declared_field_unsupported | type-only declare field 无 construction-time descriptor                    |

accessor 可返回普通数据或有独立 receiver/撤回规则的 handle；无法静态判断的 callable field/accessor-returned function 仍由 Core 运行时拒绝。

## Plugin package build

`pluxel build` 编排本地 `vite-plus/pack` tsdown API，公开 preset 是 `@pluxel/rolldown/build` 的 `pluginPackage`。`tsdown.config.ts` 保留字段/hooks，普通包由 `vite.config.ts.pack` 引入同一配置供 vp pack 使用；独立配置的选择由 runner 拥有。lint guard 使用本包 `vite-plus/bin` 的 lint -c，读取 `oxlint.build.config.ts` 的 lint 块，缺专用配置则使用 Vite+ 原生发现。

pluginPackage/pluxel 共用 `createPluginBuildPipeline`：preprocessor、macro、legacy decorator、Plugin/Part semantics、lint、owner-scoped config metadata、Workbench lowering 和 output guard。CLI 从 internal/cli allowlist 取 resolveBuildContext/pluginPackage/runWithTsdown，不另加 compiler plugins。runner 的 onSuccess 顺序为基础→preset metadata→用户；非 watch 等待 hooks 后逐 bundles 清理，聚合原错/清理错，watch 的 watcher/config restart/stdin 由 tsdown 管理。程序工具使用公开 preset 和自己的构建宿主。

semantic pass 在 TS 擦除前建立 root named export table并提取：

- concrete Plugin 地址、displayName/startTimeoutMs marker、literal forkable（与 runtime marker 交叉验证）；
- root/Part constructor direct value-import 的 ordered required，以及 module-level non-exported definePluginRef 的 direct type-import；
- init 内 direct plugins.use 的 optional edges；field 内 direct parts.use 的 ordered containment；
- 唯一 object config/source、Part config path、abstract token/provider 关系。

同一 pass 服务插件包、静态应用和 Vite。Part 参数采用与 Plugin 相同的 simple type/direct import/order/duplicate 规则，多个 occurrence 请求同 definition 合法。无法证明 provenance、多根名称、非法 subpath/re-export、间接或异步 optional setup、动态/abstract/inherited Part、@Plugin Part 和 containment cycle 在构建时拒绝。普通 dynamic import 不建立 Plugin 语义；Part 变化沿静态图失效全部 owner，不独立 replacement。

package plan 将可信根映为 package entry，其余源码用 native realpath、最具体 containing source root 和 POSIX 相对路径。越界、symlink escape、重复 physical root、缺 mapping 失败；Core codec 仅解析身份，见 [Entry canonicalization](PLUGIN_IDENTITY.md#entry-canonicalization)。

provider 按同次 facts 保持 external peer。optional type import 不生成实现 import，缺 provider 的 catalog 仍可加载 consumer。生成 `pluxel.pluginPackages` mapping 只遍历具体 Plugin 可达的本地 Part：多个来源去重、required 优先；外部/预编译 Part 的 peers 由它自己的包拥有。runtime optional facts 仍保留 callback/context/cleanup 所需信息。

作者维护 peer 范围和 optional 标记；build 验证 required/optional facts 与 peerDependencies 角色一致，不搬移依赖或猜版本。源码移除关系只清理旧生成 mapping，作者 peer 留待审查。多格式输出共用一次 facts snapshot，buildStart 才重置；连续构建与 ESM/CJS 保持幂等，metadata transaction 失败则整次失败。

交付 owner 决定拓扑：插件包保留 runtime peer/dts/exports，modules 保留包 imports 并导出应用工厂，standalone 添加 runtime closure、residual tracing 和部署装配。共享 source pipeline 只处理声明与编译，装配见 [Application Build](APPLICATION_BUILD.md)。

### Vite 与 TypeScript 配置

Host-vite 自动组合 `@pluxel/rolldown/vite` adapter。preprocessor 参与 client 与选定 Host environment，semantic/lint/config 仅参与 Host server，legacy decorators 由 Vite/OXC 转换。`configResolved` 在顶层注册，transform 用 `applyToEnvironment` 布尔过滤，读取 Vite 已解析 mode/env。

source conditions 添加 @pluxel/hmr/@pluxel/source，其余遵循 Vite client/server 默认与实际 development/production。`resolve.tsconfigPaths` 默认开、保留显式 false；浏览器 builtin guard 使用 Vite 的解析结果，允许用户提供浏览器实现，其他被 Vite externalize 的 builtin 附 import/importer 报错。Host 专用 pluxel environment、singleton/classifier、观察和关闭由 [HMR](HMR.md#canonical-vite-module-graph)拥有；默认 SSR 与第三方环境保持自己的配置/缓存。

production macro evaluator 只用于 Rolldown。当前 unplugin-macros serve adapter 安装进程级 sourcemap handler，会覆盖 `ModuleRunner` 映射；evaluator 隔离或上游有 cleanup 前，不装入开发服务。

根 tsconfig 维护共用 noEmit 选项；包配置包含 src/tests/benchmark/config，工作区 vite 配置/helper 由 scripts/tsconfig 检查。框架实现以 `@pluxel/source` 检查源码，具体插件默认 `@pluxel/hmr`，仅将其他插件切到源码，Core/Host/toolchain 用公开 dist 声明。不同环境、严格度或声明输入才拆包内配置；CLI 内联 pncat、Rolldown 内联 Workbench transport 与 Host shared-runtime 时，native 声明编译器以配置目录为 rootDir，各用仓库根的 tsconfig.cli-build.json 和 tsconfig.rolldown-build.json。构建顺序归 Vite Task。

tsdown entry 是 subpath 的作者输入。framework 的 exports.devExports 为 `@pluxel/source`，`pluginPackage` 为 `@pluxel/hmr`，框架无关源码库用 development。成功构建生成 main/module/types/exports 与无源码条件的 publishConfig.exports，提交可审查生成物。开发解析顺序为 `@pluxel/hmr`、development、`@pluxel/source`；production external resolution 保留发布入口。

## 实现与验证

[`packages/rolldown/src/rolldown/plugins/`](../packages/rolldown/src/rolldown/plugins/) 拥有共享 pass，[`inspect/`](../packages/rolldown/src/inspect/) 拥有查询。控制声明和材料见 [Plugin Control](PLUGIN_CONTROL.md)。验证合法/非法声明、构建与查询一致、ABI 缺失/冲突、真实 Vite namespace 及构建后的公开入口；metadata 还验证移除关系、连续构建和多格式幂等。
