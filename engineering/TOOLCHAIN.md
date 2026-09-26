# 工具链：声明事实与 Plugin 构建

本页拥有 Plugin 源码语义、lowering ABI、查询与 package build。静态应用装配见 [APPLICATION_BUILD](APPLICATION_BUILD.md)，Workbench/Node 制品编译见 [ARTIFACT_BUILD](ARTIFACT_BUILD.md)。

| 任务                            | 本页入口                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 查询源码与 bindings，保持无求值 | [Offline plugin inspection](#offline-plugin-inspection)                                                                |
| CLI 路由或生成项目              | [CLI 与 scaffold 所有权](#cli-与-scaffold-所有权)                                                                      |
| 源码包解析与跨仓库开发          | [Package source inference](#package-source-inference)、[Independent source workspaces](#independent-source-workspaces) |
| 数据库 migration lowering       | [Database migrations](#database-migrations)                                                                            |
| 修改 Plugin/Part 声明或构建 ABI | [Versioned Plugin lowering ABI](#versioned-plugin-lowering-abi)、[Plugin package build](#plugin-package-build)         |

## Offline plugin inspection

`@pluxel/rolldown/inspect` 的 `openProject()` 提供源码查询作用域：`overview()`、`plugins()`、`plugin()` 和 `file()` 返回冻结的普通数据、规范 definition identity 与源码位置。用户用法见[查询插件源码](../docs/development/inspection.md)。它不启动 Host、不求值项目模块、不执行 schema 或 package scripts；在线操作继续由 devconsole 拥有。

构建与查询共享同一套声明事实：`pluginSemanticsPlugin.ts` 的 `analyzeSemanticModule()` 生成 definition、direct dependency、
Part target/mount 与源码范围，`lowerModule()` 单独生成注入代码；inspection 不执行 lowering 来取得信息。
`configSourcePlugin.ts` 的 `extractConfigDeclarationFacts()` 统一声明校验和 field/schema 范围，构建再 render/normalize；
`staticConfigEnvironment.ts` 统一 application factory、shadowing、对象字段、binding helper 和 mapping 规则，构建再执行 schema 还原与 transport 投影。
这些是包内共享函数，不是新的 public analyzer 或持久化索引。

`plugin(target, { application, include: ['config', 'inputs'] })` 在一次查询内固定 application root/entry/sourceSpaces。
package target 从 entry 的解析上下文解析，source target 按正式 package 优先、最具体 source root、native realpath 和 containment 规则确认。
没有 application 时继续保留 workspace 包优先的既有语义；有 application 时不能按包名改用另一份 workspace 源码。
本次观察到同一 canonical definition 的冲突物理来源使查询失败。离线 resolver 不执行 Vite/custom hooks，不声称得到运行时 catalog。
source-entry 支持定向查询，`plugins/file` 的 workspace 发现范围不隐式扩大。

`inputs` 投影目标 Plugin 的 config env/file bindings 与应用级 configRecords 表达式位置，不执行工厂、不读取部署值。
configPath 描述 schema input mapping，不是 normalized output；Part 按 occurrence 展开，config root 为 []，Part config path 为 occurrence path。
依赖 aggregate 与 inputs 始终属于整个 Plugin，partPath 只缩小 parts/config/dependency origins。schema 符号证据不替代 Host 的运行期同对象校验。
未解析的关系保留具名诊断与可用的源码位置；不能以空列表或 configRecords:null 代替未知。

每次查询创建新的 resolver 与观察集合，同次查询共用已读取源码和总预算，不保留 watcher 或跨查询索引。
返回前复核成功读取的文件；revision 标识观察内容及显式应用解析选择，不能作为文件系统原子快照、负向解析候选的完整证明或 Host revision。
分页 cursor 绑定查询与结果。读取预算、取消和 source_changed 必须穿过内部 resolver 的恢复路径，以查询级失败结束，不能降为缺失源码的 gap。
当前查询覆盖 parts/config/dependencies/checks/inputs；Vault 业务用法、RPC 类型展开、运行时影响范围不在这个合同内。

修改这些共享函数时，验证同源码/相同解析上下文的构建与查询事实一致，同时保留独立的已知预期，避免两个消费者重复同一错误。
公开入口测试覆盖多 entry、实际 package 来源、source-space/symlink、动态缺口、重复 Part 和无求值。
交付还需用构建后的 `/inspect` 入口在普通 Node 脚本中查询真实源码，检查返回位置能否支持下一步修改。

## CLI 与 scaffold 所有权

命令加载、模板 byte plan、starter 和 packed smoke 见 [CLI 与源码工作区](CLI_WORKSPACES.md#cli-与-scaffold-所有权)。

## Package source inference

Plugin package provenance 要求显式 `exports` 子路径映射与根 named exports，不以 `@pluxel/hmr` 作为身份标记。
推断 package plan 与读取其 public entries 使用同一个 source selector：优先 `@pluxel/hmr`、`@pluxel/source`、
`development`；plain target 或 `import` / `default` 只有指向可执行 TypeScript 时才是 source entry。
显式 source condition 可指向 JavaScript；普通 built JavaScript、`types` 和 declaration files 不触发源码推断。
已建立的 Plugin package plan 仍扫描无条件 JavaScript 导出，不能借此绕过 Plugin-bearing subpath 校验。
自动推断只为实际根导出 marked Plugin 的包建立 plan；普通源码库中的本地 Plugin 仍按 source-space 定位。
显式 package build 继续要求至少一个 marked Plugin。嵌套条件按同一规则读取；Plugin-bearing subpath、重复 root export 与跨包 re-export 的拒绝规则不变。

## Independent source workspaces

跨仓库 source registry、pnpm overlay、构建闭包与 bootstrap 见 [CLI 与源码工作区](CLI_WORKSPACES.md#independent-source-workspaces)。

## Database migrations

`evolution: 'migrations'` 的 `pluxel database generate` 从当前 package 唯一的 `defineDatabase()` schema module 调用 Drizzle Kit，生成 PostgreSQL
`drizzle/*.sql` 与 `drizzle/meta/`，并维护带 immutable `lineage` 的 checksum manifest。`pluxel database check` 同时运行
Drizzle history 一致性检查、manifest rewrite 检查，并在临时副本中重新 generate 以拒绝 schema drift。普通变更只能追加
migration；插件明确放弃原 lineage 时运行 `pluxel database rebase --lineage <new-id>`，工具先在 staging 生成全新 baseline，
校验成功后再原子替换 `drizzle/`。这是同步更新 lineage、SQL、Drizzle meta 与 checksum manifest 的标准入口。

共享 production compiler 会识别从 `@pluxel/services/database` 导入的 module-level `defineDatabase()`；显式 evolution 必须在
direct object 中使用 literal，未声明时保持默认 `migrations` 并从最近 package 的 `drizzle/` 读取、校验 artifact；
`reset-on-schema-change` 没有 checked-in history；`generate`、`check`、`rebase` 会明确拒绝它，唯一作者路径是 compiler 从当前 schema 生成 baseline。它在 `.pluxel/` staging 中从空 history 生成 baseline，以去除随机 identity 后的规范化 Drizzle snapshot
计算稳定 lineage，并删除无需部署的 meta。两种策略都把内部 artifact 参数注入 server output；独立插件 package 同时发布
SQL 与 manifest 到 `dist/database/migrations/`。browser source graph 不包含 schema、Drizzle 或 SQL。
Vite source adapter 在 server environment 使用相同 declaration 与 artifact 规则，并在 schema module transform 时注入当前
artifact；reset baseline staging 在注入后立即清理，因此 HMR schema 变化会得到新 lineage，browser environment 不运行生成器。

## Versioned Plugin lowering ABI

Plugin semantic output 是已构建 Plugin 与 Core/runtime 之间的发布契约。generated module 只从
`@pluxel/core/toolchain`导入 ABI v2 helper；默认 root 和 `/internal`
不提供 setter alias。canonical helpers 是 `__setPluginDefinition`、`__setPluginConfig`、`__setPluginParts`、
`__setPluginPartConfig`、`__setPluginPartRequires` 与 `__setPluginPartOptional`，每个 payload 都携带同一个 numeric
`abiVersion`。v1 artifact 没有 Part constructor requirement facts，当前 Core 不提供隐式兼容窗口；Core、Host 与 Rolldown
必须成套升级并重新构建 Plugin，版本不匹配以 `plugin_lowering_abi_unsupported` fail-fast。

helper 只把 sealed immutable facts 写入 module-evaluation scoped `WeakMap` staging。canonical namespace 完成求值后，route 对每个 root
constructor 调用 `consumePluginDefinitionCandidate()`；首次读取原子组合 decorator marker、definition、config 与 reachable Part facts，
验证后删除 staging 并缓存唯一 frozen candidate object，同一 evaluated constructor 的后续 host/route 读取严格返回该对象。HMR 通过新 constructor
产生新 candidate，不做 cache invalidation。Part facts 可跨多个 definition 复用，但没有 global facts revision、metadata clone、双读或
candidate ingestion 后的 setter mutation。

lowering trust boundary 使用三个稳定 code：ABI 不支持为 `plugin_lowering_abi_unsupported`，declaration 缺失为
`plugin_declaration_missing`，payload/identity/Part tree 不一致为 `plugin_declaration_invalid`。Plugin inheritance chain 中的
ECMAScript instance `#private` field/method/accessor 在 semantic pass 以
`plugin_caller_view_private_brand_unsupported` hard diagnostic 拒绝，避免 caller facade 在运行时才触发 private brand 错误。
Plugin inheritance chain 的 function-valued instance field（arrow、function expression、`.bind()`）同样以
`plugin_caller_view_callable_field_unsupported` hard diagnostic 拒绝；跨节点 callable surface 必须是 prototype method，accessor 只返回
普通数据或有独立 receiver/withdrawal 契约的对象 handle。Core 仍对无法静态证明的动态 callable field 和 accessor-returned function
保留 runtime fail-fast 防线。type-only `declare` instance field 不产生 caller facade 的 construction-time descriptor，以
`plugin_caller_view_declared_field_unsupported` hard diagnostic 拒绝。

ABI v2 把 root constructor injection order 与 owner graph requirements 分开：definition payload 的 `constructorRequires` 只保存
owning Plugin constructor 的 direct ordered 参数；candidate 的 `requires` 是 root 后接 reachable Part tree depth-first first-seen、按
definition identity 去重的 graph 全集；每个 `PluginPartDefinitionNode.requires` 保存该 Part constructor 的 direct ordered 参数。
Part facts 服务 occurrence construction 与来源诊断，不建立第二张 graph，也不产生 per-Part override。

## Plugin package build

`pluxel build` 只负责编排，实际构建由 `@pluxel/rolldown/build` 的 `pluginPackage()` preset 通过 tsdown 驱动
Rolldown。`pluginPackage()` 与 `pluxel()` 都组合唯一的 `createPluginBuildPipeline()`：preprocessor、macro、
legacy decorator、Plugin/PluginPart semantic facts、lint、owner-scoped object config metadata、Workbench semantic lowering 和 decorator
output guard。`pluginPackage()` 自己组合单次 semantic pass 与 metadata transaction；CLI 不追加 compiler plugins。
官方 CLI 从 `@pluxel/rolldown/internal/cli` 按 allowlist 加载 `resolveBuildContext`、`pluginPackage` 与 `runWithTsdown`。
Runner 按基础 hook、preset metadata hook、用户 hook 的顺序组合 `onSuccess`，overlay 不覆盖用户行为。
非 watch 等待 success hooks 并清理 bundles，失败保留原错与清理失败。Watch 的 watcher、配置重启及 stdin 属于命令进程，
不是可独立 dispose 的程序式 session；因此 runner 不属于公开 `/build`。自定义工具使用公开 `pluginPackage` preset 与自己选择的构建宿主。

Plugin semantic pass 在 TypeScript 擦除前建立 package/source root named export table，并 lower：

- concrete `@Plugin` definition address 与 `displayName`/`startTimeoutMs` marker facts；
- literal `forkable: true` concrete definition fact，并与 decorator runtime marker 交叉校验；
- Plugin 与 concrete direct PluginPart constructor parameter 的 direct root value-import provenance 与 ordered required facts；
- non-exported module-level `definePluginRef<T>()` 的 direct root type-import provenance；
- `init()` 中 direct `plugins.use(Ref, callback)` 的 optional restart edges；
- concrete Plugin/PluginPart 普通 field 中 direct `parts.use(PartClass)` 的 ordered containment facts；
- Part direct required 与 `init()` optional facts，并将完整 reachable Part tree 的 edges 合并到 owning Plugin definition；
- Plugin 与 Part 各自唯一的 object config declaration/source，以及 Part config path；
- abstract token/provider relation。

同一 pass 由 plugin package、static application 和 Vite source route 复用。Part constructor 使用与 Plugin constructor 相同的
simple Plugin type reference、package-root value import、参数顺序和 duplicate definition 规则；root 与不同 Part constructor 或多个
Part occurrence 请求同一 definition 则是合法共享。未能证明 root provenance、同一 constructor 经多个根名称导出、plugin-bearing
subpath、跨包 Plugin re-export、async/间接 optional setup、动态 Part occurrence、abstract/inherited Part、`@Plugin` Part 与 local
containment cycle 都在 build 时失败。普通 dynamic import 不获得 Plugin 语义。
Part source/HMR 仍通过普通静态 import graph 使所有 owner module generation 失效；Part 不是独立 replacement unit。

package plan 先把可信 package root 映射为 package entry；其余 source entry 对 source-space root 和 existing file 使用 native
`realpath()`，选择最具体的 containing root，再生成 canonical POSIX relative path。symlink escape、root 外路径、重复 physical root
和无 source-space mapping 均失败。Core parser 不执行 filesystem I/O；纯 AST diagnostics 的 lexical address 不是 build/runtime
identity producer。完整规则见 [`PLUGIN_IDENTITY.md`](PLUGIN_IDENTITY.md#entry-canonicalization)。

`pluginPackage()` 从 semantic facts 直接把 detected required provider 和 optional provider 保持为 external peer，
不依赖 metadata transaction 完成后的下一次构建。required edge 锚定 value import；optional ref 的实现 import 在发布 JS
中不存在，因此 host closure 未包含 provider 时 consumer 仍可加载。static application 和 Vite source route 只从各自
显式 catalog/module graph 提供 candidate，不生成 absent virtual module 或 runtime loader annotation。

独立插件包从同一 semantic facts 生成：

```json
{
	"pluxel": {
		"pluginPackages": {
			"pluxel-plugin-database": "required",
			"pluxel-plugin-audit": "optional"
		}
	}
}
```

root 或 reachable Part constructor 的 concrete package usage 是 `required`，`definePluginRef<T>()` 的 direct type import 是
`optional`；同一 provider package 被多个 occurrence 请求时只输出一次，任一 required 来源都会让 required 胜出。runtime lowering
facts 仍保留 optional request，以便对应 callback、caller Context 与 cleanup 正常运行。package inventory 从 concrete Plugin root
沿本地 containment edge 遍历；被构建模块加载但不被任何 owner containment 使用的 Part 不进入 metadata。外部/预构建 Part 的
provider peers 由定义该 Part 的 package 持有，consumer package 不反射其 runtime facts，也不重复传递 inventory。
版本范围只来自 peer/dev/dependency authoring metadata；发布边界统一写入 `peerDependencies`，optional 同步
`peerDependenciesMeta.optional = true`。同一 build 的多格式 output 读取同一 facts snapshot，下一次 `buildStart` 才重置；
连续构建与 ESM/CJS 双输出都保持幂等。源码删除依赖时，上一版生成的 peer、optional peer metadata 与 manifest
mapping 会一并清理；devDependencies 保留供作者工具使用。metadata transaction 任何失败都会使 build 失败。

两条 production route 只在输出拓扑处分叉：plugin package 保留 runtime peer boundary、dts 和 package exports；static
application 追加全量 runtime closure、nf3 residual tracing、platform bootstrap 与 deployment assembly。不要把 static
assembly 塞进 source pipeline，也不要在 CLI 复制 pipeline plugin 列表。

Vite route 使用 `@pluxel/rolldown/vite` 的 source adapter，复用 preprocessor、plugin semantics、lint 和 config metadata，
并由 Vite/OXC 提供 legacy decorator transform。Host-dev 自动组合该 pipeline；preprocessor 参与所有 environment，
Plugin semantics、lint 和 config metadata 仅作用于 server environment。Workbench 单独拥有 browser compiler 与 UI singleton 策略。
源码解析添加 `@pluxel/hmr`、`@pluxel/source`，其余条件遵循 Vite 的 client/server 默认值：浏览器不启用 `node`，
`development` / `production` 按 Vite 的实际环境选择，不能同时启用。默认启用 Vite 自身的 `resolve.tsconfigPaths`，
显式 `false` 保持关闭。项目无需再注册路径解析插件。浏览器直接引入 Node builtin 时，adapter 复用 Vite 解析结果：
没有用户提供的浏览器实现而被 Vite externalize 的 builtin 立即报错，包含 import 与 importer；SSR 不受此 guard 影响。

Host-dev 拥有专用 `pluxel` Vite environment、source watcher 和更新队列，应用声明、fixed imports、动态来源和
开发控制台都在该 environment 的单一 runner / evaluated namespace 求值。其 runner 禁用自动 HMR 求值，所有
Host 更新由候选提交队列管理，并使用 source-aware stack mapping。Vite 自身负责 runner 与 environment 的关闭。
Services 提供 HTTP carrier，Workbench 通过开发附件接入 artifact compiler。生产启动使用构建产物与生产来源加载器，
不以另一个 Vite mode 充当生产 launcher。Vite 默认忽略生成态 `.pluxel`、日志与数据库目录。

Host 的 source conditions、noExternal、singleton 与语义 collector 只作用于 `pluxel` environment。
默认 `ssr` 和第三方 `ssrLoadModule` 保留 Vite 自己的环境工厂、解析策略和执行缓存；它们不加载 Host 的 Plugin 实例。
第三方应提交普通数据，或使用已运行 Host 的服务 API；不能把另一 environment 求值出的 Plugin constructor 当作
Host 同一 evaluated namespace。用户自定义 SSR factory 与 Host 专用 environment 可以共存。

专用 environment 在其工厂返回前装配唯一的 fetchModule 策略：Vite 先解析，再对物理文件分类；
CommonJS/native 与显式 singleton 交给 Node，其余交给 Vite。Singleton 只登记 canonical 物理身份，
不维护请求 URL 拼写白名单，不修改 server.close 或私有 runner transport。Vite 只公开 runnable 工厂而不公开构造器，
因此在工厂中装配公开方法；不借助私有构造器反射。只有 `pluxel` 名称的环境工厂属于 Host，调用方不能替换它。
文件分类器不另建 bare specifier resolver；production freezer 的 residual tracing 和部署闭包契约不受影响。

浏览器 Node builtin guard 与 preprocessor 仍按原语法职责参与 client 编译；Host pipeline 的 preprocessor
只参与 client 与所选 Host environment，不处理默认 SSR 或其他 server environment。Vite 的 tsconfigPaths 与 OXC
选项均为项目级，因此保留显式 tsconfigPaths 选择和 legacy decorator 语法配置；不为声称完全隔离而引入额外解析器
或一次额外 TypeScript/OXC parse。

Host-dev 直接依赖 `@pluxel/rolldown/vite` 公共入口；workspace source conditions 选择当前源码，发布产物保留工具链外部依赖。
Services 拥有 Node HTTP carrier，Host-dev 不复制 carrier 实现或维护另一套 source transform。

仓库内 TypeScript 解析分成两个边界：框架实现 package 通过 `tsconfig.workspace.json` 的
`@pluxel/source` 检查当前源码；具体插件通过 `tsconfig.plugin.json` 的
`@pluxel/hmr` 只把其他插件解析到源码，Pluxel Core/Host/toolchain 本身消费已构建的公开声明。
因此单个插件 typecheck 不会把整个框架源码并入同一个 TypeScript program，也不会用插件编译选项重新检查内部实现。

tsdown `entry` 是 build package subpath 的唯一作者事实源。framework package 配置
`exports.devExports: "@pluxel/source"`；`pluginPackage()` preset 统一配置
`exports.devExports: "@pluxel/hmr"`；框架无关的开发源码包使用社区 `development` condition。tsdown 在成功构建后
生成 `main/module/types/exports` 和无源码 condition 的 `publishConfig.exports`，这些 manifest 字段是应提交、可审查的
生成物，不在 package.json 手工维护。开发解析按 `@pluxel/hmr`、`development`、`@pluxel/source` 顺序选择，
production external resolution 不启用这些源码入口。

production macro evaluator 仍只属于 Rolldown build pipeline。当前 `unplugin-macros` 的 Vite serve adapter 会安装进程级
sourcemap handler，覆盖 ModuleRunner 的 source-aware stack mapping；在 evaluator 隔离或上游提供 cleanup 前，不得把它
装入 HMR dev server。该限制不影响 plugin package 与 static application production build 的 macro 等价性。

## Static application freezer

静态入口、环境绑定、bundle closure、residual packages 与 finalization 见 [应用构建](APPLICATION_BUILD.md)。

## Workbench source declaration

Content/renderer lowering、Node declarations 与浏览器边界见 [制品编译](ARTIFACT_BUILD.md#workbench-source-declaration)。

## Development compiler

候选构建、缓存、迟到结果与 publication 见 [开发制品编译](ARTIFACT_BUILD.md#development-compiler)。

## Production build

Manifest/types、fixed shared、Node residual 和生产 inventory 见 [生产制品编译](ARTIFACT_BUILD.md#production-build)。

## 实现与验证

共享 pass 位于 `packages/rolldown/src/rolldown/plugins/`，inspection 位于 `packages/rolldown/src/inspect/`。先验证声明合法/非法输入、同源码构建与查询一致、ABI version/缺失/冲突诊断，再验证真实 Vite namespace 与构建后的公开入口。Package metadata 变更还需检查连续构建幂等、移除 peer 清理与 ESM/CJS 输出一致。
