# Toolchain Architecture

Workbench UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。

## CLI distribution and capability ownership

`@pluxel/cli` 是静态命令目录与用户交互 adapter，不是 runtime、构建、HMR 或发行协议的所有者。
`@pluxel/create` 是独立的 workspace initializer：它发布一个固定、无插值的 example monorepo，并把发布时的
`docs/` 静态快照原字节复制到新项目 `docs/pluxel/`。create 不加载 CLI、不解释 plugin template contract，也不从
Git/registry 获取 starter。create 自身使用 TypeScript entry；tsdown 的 `exports.bin` 显式生成 npm
`create-pluxel` executable、保留 shebang 并输出单个 Node 24 ESM chunk，同时用标准 `copy` 配置把 `template/` 与仓库
`docs/` 物化到发布 `dist/`。这里不使用 `exe`：该选项是实验性的 Node SEA，不是 npm CLI contract。目标必须不存在
或为空；生成先在同级临时目录完成，再原子落到最终目录。

固定 starter 是 create package 的产品资产，不是 CLI template。它使用中性的 `@example/*` workspace package、无
`name` 的 private root、默认 static mode、alternative dynamic mode、React Todo client、普通 domain package、三种
Plugin 依赖/config 范式、core/runtime Vitest、Turbo、Oxlint/Oxfmt、CI 和 governance。starter workspace 仍安装
`@pluxel/cli`，用于后续 `pluxel new` 与 build 命令；这不形成 create package 对 CLI 的实现依赖。
starter 的 `host/web/` 是独立 private workspace package，只拥有纯 React source 与前端直接依赖，不 import Pluxel；
`host/` application package 把 Web package 声明为 build input，直接依赖 React singleton、runtime 与 workspace Plugins，
并维护唯一指向 `web/` 的 Vite config，以及 static/dynamic route entry、catalog、config 与 runtime state。starter
root 预装 `pncat`，`pncat.config.ts` 是 catalog 分组策略，所有 catalog 增删、迁移与清理由 pncat 完成；package manifest
仍逐包声明直接依赖，不把 root hoist 当成 Plugin 的隐式依赖来源。static
application 的 package root 是
`host/`，所以 `host/tsdown.config.ts` 是唯一 freezer authority；monorepo root 只通过 Turbo 编排。

`@example/host` build 先用同一 config 完成 `host/web/dist` browser build，再运行 freezer；tsdown 在 host build 末尾把 Web
输出复制到 `host/dist/public`。由于 static assembly 已在 Rolldown `writeBundle` finalization，package script 随后必须
调用同一个 `pluxel distribution create` finalizer，确保最终 manifest 覆盖 browser assets。任何后续写入仍然非法。

`pluxel new` 把 bundled/local template 统一处理为
`parse source -> acquire root -> validate manifest -> collect answers -> compile byte plan -> materialize -> optional install`。
CLI 只维护 `plugin` bundled template；bare name 只解析 bundled plugin template，local template 必须使用 `./`、
`../`、absolute path 或 `file:`，当前不支持 remote source 或 registry fallback。每个 root 只有一个严格校验的
`pluxel-template.jsonc`，只声明 id、package-manager policy 与 prompts；所有 identity 都按 plugin package 规则解析。

只有 `.tpl` 文件执行 `{{ key }}` 与 `{{ json key }}` 插值并在输出时去掉扩展名；其他 regular file 按字节复制。
模板不支持 block、loop、condition、partial、动态 helper、symlink 或任意 code/command。plan 在首次目标写入前完成
UTF-8、未知 token、path containment、portable collision、目标 parent 和 existing file 检查，并持有最终
`Uint8Array`；materializer 不重新读取 template。`--force` 只授权 plan 编译时发现的精确 existing file，
单文件通过同目录 temporary file + rename 替换，整个目录不承诺事务回滚。

bundled template 默认安装依赖；local template 默认不执行 package manager，只有显式 `--install` 才提升信任。
CLI packed smoke 只验证 plugin scaffold 的 install、lint、typecheck、test、build 和 pack。create packed smoke 独立验证
starter inventory、docs 字节、完整 workspace verify、static distribution 和 unified Vite 的 static/dynamic mode；两种输出有意不同，
不建立 parity contract。

全局 `pluxel` launcher 在加载命令框架前，从启动 `cwd` 向上查找最近一个直接声明 `@pluxel/cli` 的
`package.json`。找到且已安装时委托该项目 executable；声明存在但安装不完整时，只有 `source` 命令族继续使用
当前独立 CLI，其他命令失败。这个窄例外让 `source register/doctor/install/build` 能建立包含项目 CLI 自身的
source overlay，不为 build、HMR、发布或 package scripts 提供全局版本回退。CI、package scripts 和生成的 workspace
仍固定项目本地 CLI，避免全局升级越过 lockfile。已安装判定只在最近的 Git、workspace 或 package-manager lockfile
边界内逐级查找 `node_modules`；合法 hoist 和 source symlink 可用，物理嵌套的独立仓库不会误用父项目依赖。

命令目录保持静态。只有用户选择命令后，CLI 才从启动 `cwd` 的 Node dependency graph 解析已知的官方 owner，
检查其版本是否满足 CLI 的 optional peer range，并 lazy import 对应 public subpath。命令的 `--root` 是领域输入，
不改变依赖解析基准。Help、version 与 completion 不扫描 `node_modules`、不 import owner、不访问 registry，也不
自动安装依赖。

optional owner 保持 external，不得被 CLI bundle 或 nested lazy chunk 内联。缺少 owner、版本不兼容、public
subpath 缺失和 owner 自身加载失败是四类不同诊断；最后一类必须保留原始 cause。当前没有第三方 CLI provider、
capability registry、动态命令发现或通用 extension contract。至少出现两个真实的仓库外 provider，并且确实需要
新增命令后，才重新设计命名冲突、版本协商、信任、取消与 cleanup。

## Independent source workspaces

`pluxel source` 是 CLI 拥有的开发期 pnpm 编排层。消费仓库只在 `pluxel.sources.jsonc` 声明稳定 Git
repository identity；机器级 registry 将 identity 映射到 checkout。CLI 扫描各 checkout 自己的
`pnpm-workspace.yaml` 和 package manifest，拒绝 package name collision 与 source dependency cycle，
再从消费方依赖递归推导需要链接和安装的 package closure。源码 package 的 devDependency 属于其自身
checkout，不进入消费方 closure。

少数外部 package 同时具有类型期 nominal/private identity 时，项目可声明 `singletons`。CLI 只接受在
本次实际选中的源码 package 中有唯一 direct dependency owner 的名称，并在该 owner checkout 安装后
解析物理实例；不得把 owner 的 `node_modules` 相对路径写进项目配置。

pnpm override 是一次安装的生成细节，不进入项目 workspace 配置。CLI 在 `.pluxel/` 原子生成 pnpmfile
和 `repository-hash/package-slug-package-hash` package link；lockfile 因而只记录可审查的稳定代理路径，保留外部依赖可复现性且不泄漏机器
目录。代理只暴露实际依赖的 package，不把整个 checkout 嵌入 consumer 文件树；移动 checkout 或 package 目录只更新
machine registry 和 package link。source package 若包含 consumer root 会被拒绝，因为这种所有权拓扑无法形成无环代理。每个 checkout 始终按自己的依赖闭包生成
overlay，并通过 Corepack 尊重精确的 `packageManager` 版本，所以被下游编排不会改写出另一份 lockfile。

首次安装由独立的全局或 `pnpm dlx` CLI 直接执行标准 `pluxel source` 命令：操作者先显式 `source register`
每个 checkout，再在 consumer 中运行 `source install`。机器路径仍只进入用户 registry，CLI 不从目录邻接、父仓库
或同机其他 checkout 猜测 repository identity。不得把首次 bootstrap 放进 consumer 的 pnpm script：pnpm 可能在
执行 script 前先做 dependency-status install，此时 source overlay 尚未生成，会把私有 source package 错误解析到
registry。package closure、overlay、构建与 lockfile 始终由唯一的 `pluxel source` 实现拥有。
`pluxel source build --package <name>` 可以重复传入 source closure 内确实需要 artifact 的精确 target；它只用于需要先使一个
package export 可执行的窄 bootstrap，例如 Vitest config 的 `@pluxel/test`。不带 `--package` 才构建整个 selected artifact closure。
上游构建优先把精确目标交给其 Turbo task graph，不用 `package...` filter 强制扩张依赖；无 Turbo 时
回落到 pnpm recursive filter，不在消费仓库复制 package filter。`build` script 本身不代表 source
consumer 需要产物：CLI 只选择 live manifest 引用顶层标准构建目录或暴露 executable bin 的 package，
直接导出 `src` 的 package 保持零构建；上游任务图仍拥有目标内部的 artifact prerequisites。
CLI 已经为 checkout 选择并启动 pnpm，因此调用 Turbo 时关闭它重复执行的 package-manager 检查；这只避免
Turbo 把合法的 `devEngines` pnpm range 当成无效精确版本，不绕过 CLI 的 pnpm 校验或 checkout 自己的 lockfile。
CLI 同时移除 consumer 进程的 `COREPACK_ROOT` 标记，让独立 checkout 及其 nested workspace 能按最近的精确
`packageManager` 自行切换 pnpm，而不是错误继承 consumer 的版本。

该能力不改变 pnpm workspace membership，也不合并独立仓库 lockfile/release。现有 `pluxel workspace`
仍只管理一个仓库内部的 workspace patterns。它同样不复用 dynamic source producer：后者拥有 runtime
file entry publication，`pluxel source` 只发生在开发期 package resolution/build。

## Database migrations

`pluxel database generate` 从当前 package 唯一的 `defineDatabase()` schema module 调用 Drizzle Kit，生成 PostgreSQL
`drizzle/*.sql` 与 `drizzle/meta/`，并维护带 immutable `lineage` 的 checksum manifest。`pluxel database check` 同时运行
Drizzle history 一致性检查、manifest rewrite 检查，并在临时副本中重新 generate 以拒绝 schema drift。普通变更只能追加
migration；插件明确放弃原 lineage 时运行 `pluxel database rebase --lineage <new-id>`，工具先在 staging 生成全新 baseline，
校验成功后再原子替换 `drizzle/`。这是同步更新 lineage、SQL、Drizzle meta 与 checksum manifest 的标准入口。

共享 production compiler 会识别从 `@pluxel/runtime/database` 导入的 module-level `defineDatabase()`；显式 evolution 必须在
direct object 中使用 literal，未声明时保持默认 `migrations` 并从最近 package 的 `drizzle/` 读取、校验 artifact；
`reset-on-schema-change` 在 `.pluxel/` staging 中从空 history 生成 baseline，以去除随机 identity 后的规范化 Drizzle snapshot
计算稳定 lineage，并删除无需部署的 meta。两种策略都把内部 artifact 参数注入 server output；独立插件 package 同时发布
SQL 与 manifest 到 `dist/database/migrations/`。browser source graph 不包含 schema、Drizzle 或 SQL。
Vite source adapter 在 server environment 使用相同 declaration 与 artifact 规则，并在 schema module transform 时注入当前
artifact；reset baseline staging 在注入后立即清理，因此 HMR schema 变化会得到新 lineage，browser environment 不运行生成器。

## Versioned Plugin lowering ABI

Plugin semantic output 是已构建 Plugin 与 Core/runtime 之间的发布契约。generated module 只从
`@pluxel/core/toolchain`（或显式转发它的 `@pluxel/runtime/toolchain`）导入 ABI v2 helper；默认 root 和 `/internal`
不提供 setter alias。canonical helpers 是 `__setPluginDefinition`、`__setPluginConfig`、`__setPluginParts`、
`__setPluginPartConfig`、`__setPluginPartRequires` 与 `__setPluginPartOptional`，每个 payload 都携带同一个 numeric
`abiVersion`。v1 artifact 没有 Part constructor requirement facts，当前 Core 不提供隐式兼容窗口；Core、Runtime 与 Rolldown
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
Rolldown。`pluginPackage()` 与 `staticApplication()` 都组合唯一的 `createPluginBuildPipeline()`：preprocessor、macro、
legacy decorator、Plugin/PluginPart semantic facts、lint、owner-scoped object config metadata、Workbench semantic lowering 和 decorator
output guard。`pluginPackage()` 自己组合单次 semantic pass 与 metadata transaction；CLI 不追加 compiler plugins。
`runWithTsdown()` 按基础 hook、preset metadata hook、用户 hook 的顺序组合 `onSuccess`，overlay 不覆盖用户行为。

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

Vite route 使用 `@pluxel/rolldown/vite` 的 source adapter，复用 preprocessor、plugin semantics、lint、config metadata
以及 React/Mantine UI singleton dedupe 语义，并由 Vite/OXC 提供 legacy decorator transform。source preset 同时识别
框架 package 的 `@pluxel/source` 与插件 package 的 `@pluxel/hmr` dev export；static/dynamic route plugin
会自动组合这套配置，项目不应重复配置 Pluxel core/runtime/UI 的 resolve conditions、dedupe 或插件 source alias。
preprocessor 作为顶层 Vite plugin 参与完整 transform 生命周期，
同时用于 Workbench UI production build；plugin semantics、lint 和 config metadata 只应用于 server environment。
runtime-dev 只增加 ModuleRunner、watcher 和 Workbench UI compiler，不维护另一份安全可复用的 source transform 列表。
static/dynamic 对配置 import graph 的收集与失效复用同一个 runtime-dev helper；Node artifact build slot、缓存保留、
Federation application-root coordinator 和 shared package 集合属于内核不变量，不进入 Context 或 route config。
Workbench browser entry 在 route `config` hook 进入 Vite optimizer；插件 UI 的 watch graph 则通过 SSR environment
收集，不能为了编译元数据调用 client transform 并向 optimizer 注入不完整依赖批次。
Dynamic host 显式使用 `mode: 'distribution'` 时仍保留 source transform/HMR pipeline，但 package resolution 不启用
`@pluxel/hmr`、`development` 或 `@pluxel/source`，Workbench 改由 `@pluxel/runtime/dist/public` 提供，HTML 也不注入
Vite client。该模式把 bare SSR package import 留给 Node host，避免已经物化的 CommonJS/native package 被 Vite Module
Runner 当作 ESM source 内联；显式 source entry 仍经过 Pluxel transform pipeline。该模式用于 host-owned 可搬运 source
distribution；目录 closure、inventory 与签名不由 route plugin 猜测。
static/dynamic route 分别使用 `.pluxel/vite/static-runtime-v2` 和 `.pluxel/vite/dynamic-runtime-v2` 作为当前
optimizer contract 的默认 Vite cache。同一 host Vite 可以同时拥有业务前端 client graph 与 Pluxel SSR graph；默认目录
避免它与不包含相同 runtime optimizer contract 的其他 Vite 进程互相替换。host 显式提供 `cacheDir` 时始终优先。reset baseline 的内部
Drizzle generate 成功输出被捕获，失败时才附回完整诊断。dynamic route 的 watcher 默认忽略原生构建 `target/`
目录与 Turborepo `.turbo/` 缓存，不把 Rust/N-API 编译或任务缓存纳入插件源码 HMR。两条 route 的 Vite watcher
都忽略生成态 `.pluxel/`。package-level source proxy、optimizer cache 与 artifact output 本来就不属于应用源码 HMR；
这一排除也是对损坏、旧版或用户手工创建的递归链接的纵深防御。

开发期 Node module externalization 由 runtime-dev 的单一 host-module classifier 决定。它从 importer 所在位置按 Node
规则解析 bare specifier，找到最近的 `package.json`，并结合 `.node`/`.cjs`/`.cts` 扩展名、package `type`、require-only
root export 与 `napi`/`binary`/`gypfile` metadata 区分 host CommonJS/native module 和可变换的 ESM source；package、文件和
specifier 结果使用有界缓存。static/config ModuleRunner 通过 server-only Vite adapter 使用该判断，dynamic HMR runner
在 fetch boundary 直接使用同一判断并携带明确 module format。项目不得再用 `ssr.external` 或 runtime package 名单复制
这项策略。该开发期执行边界与 production freezer 的 residual tracing 是两个契约：后者仍负责生成可搬运部署闭包。

仓库 source checkout 中，static/dynamic Vite adapter 通过 relative source bridge 组合当前 Rolldown source preset，
不能回落到上一次构建的 `dist/vite.mjs`；各 runtime package 的 production build 用 pre-resolve externalizer 把这条
bridge 精确改写为 `@pluxel/rolldown/vite` 公共入口。这样修改内核 Vite 默认后无需先手工 build 才能启动项目，也不会
把 Rolldown 工具链内联进 runtime 发布物或增加 dev-only package export。
配置加载期的 runtime-dev Node carrier 同样直接桥接当前 runtime-node source；runtime-dev 自身发布构建把它精确改写回
`@pluxel/runtime-node`，而 static/dynamic route build 继续按各自 package closure 内联 carrier。开发启动因此不读取旧 dist，
发布边界也不残留 monorepo 相对路径。

仓库内 TypeScript 解析分成两个边界：框架实现 package 通过 `tsconfig.workspace.json` 的
`@pluxel/source` 检查当前源码；具体插件通过 `tsconfig.plugin.json` 的
`@pluxel/hmr` 只把其他插件解析到源码，Pluxel core/runtime/toolchain 本身消费已构建的公开声明。
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

static application 的 build preset 归属 `@pluxel/rolldown/build`：

```ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	target: 'node',
})
```

freezer 只接受直接默认导出的 `defineStaticRuntime(...)`。它在同一 graph 中执行 macro、config metadata、lint、Workbench
remote extraction 和 production preprocessing，然后生成以 canonical entry 为 namespace import 的 platform bootstrap。Wrapper
从 module namespace 消费 default application，并用 runtime shared reader 消费可选 `product` named export；它不按 identifier
猜测 export、不静态求值 product，也不把产品字段复制进 deployment metadata。direct export、local export 与标准 re-export
因此具有相同语义。fixed plugins、runtime-static 和可达的
runtime/core 默认属于 application bundle closure；code splitting 允许，但输出不得残留 `@pluxel/*` deployment import。
optional ref 不产生实现 import；只有 host fixed catalog 或其他可达代码显式引入的 provider 才进入 application closure。
缺席的 optional provider 不产生 chunk、virtual absent module、nf3 residual 或 deployment external。

bootstrap 在 host namespace 求值前先加载 static Elysia wiring。freezer 从 Runtime-owned Elysia manifest 读取全部显式 public
exports，并把 Elysia subpath、TypeBox 的 type/system/value/schema/compile namespace 与 `exact-mirror` 固定到同一 bundle identity；
随后调用 Elysia 公开 `setupTypebox()`。因此 source-linked Plugin 不能带入第二份 Elysia，搬离 workspace 的 schema-backed
distribution 也不依赖相对生成 chunk 的同步 module lookup。resolve hook 使用原生 id filter，非相关 graph import 不进入该插件。

同一个 static entry validator 还 lower optional `configEnvironmentBootstrap`。该字段只能是 direct array literal；每项必须是
direct `bindConfigEnvironment()` call，mapping 只能由 direct string literal 或 direct object tree 组成。Identifier indirection、
spread、computed/duplicate property、runtime branch、非 portable/reserved name 在 Vite 与 production 使用同一 diagnostic 拒绝。
Lowering 只产生 Plugin/schema export、raw path 和 environment name facts；startup decoder 仍读取 runtime canonical candidate。

Production projector 复用 config source resolver，把 exported schema 还原为封闭的 Valibot schema DSL，再调用
`valibot-form` 的同一个 raw-input projector；它不执行 canonical application、`configure()`、Plugin module side effect、validation、
transform 或 default getter。无法安全静态还原或无法推导 transport 的 target 使 build 失败，不回退 string/JSON heuristic。

Plugin semantics、config source 与 route-specific validator 都只读 AST，并通过 `pluginUtils` 的 exact-source 有界缓存复用同一
module parse。Vite/watch source bytes 变化会自然替换该 id 的缓存项；各 pass 仍独立拥有自己的 semantic facts，不能修改共享 AST。

Binding 非空时 assembly 在 distribution finalization 前写 root `.env.example`。Environment name 按 UTF-8 bytes 排序并去重，
fan-out target 的 description/input facts 稳定聚合；placeholder 保持注释状态。文件编码为 UTF-8 + LF，不读取 build environment，
不输出 schema default/secret，不生成或加载 `.env`。该路径是 generated asset 保留路径；已有 assembly input 冲突时失败，文件作为
普通 asset 自然进入 distribution inventory，不修改 deployment/distribution manifest schema。

Node target 用 `nf3` externalize 并追踪 native/non-bundleable 或无法安全跨 CommonJS/ESM 边界内联的 residual packages，
复制到 distribution 自己的 `node_modules`。PostgreSQL `pg` 属于后一类：freezer 保留它的 Node package boundary，避免改变
`pg-pool` 的 CommonJS 构造器语义。这只是 bundler 无法安全内联部分的 fallback，不是部署端 package install 模式。当前
freezer 只发布 Node application；在提供真正 platform-neutral 的 runtime/service closure 前，不生成伪 neutral Worker bundle。
Managed database driver 默认同时追踪 PGlite 与 `pg`；`managedDatabaseDrivers` 可以按 deployment 收窄实际复制的 driver。
未选择的 driver 被 lowering 成明确 absent module，使 dead runtime branch 不会反向进入 bundle 或留下 unresolved external；
选择与 startup config 不一致会在真正加载 driver 时明确失败，而不是从 build config 猜测或改写 canonical `configure()`。
Production source map 可用 `sourcemapExcludeSources` 省略重复的 `sourcesContent`，仍保留 Node stack mapping 所需的
source path、name 和 mapping；是否另存完整源码归档由 deployment/release policy 决定。

Runtime shared resolver 只在真正执行 module resolution 时通过 `createRequire()` 加载 OXC native binding。普通 static
application 虽然会从 runtime root 消费作者 API，但 tree-shake 后不得残留无调用者的 `oxc-resolver` side-effect import，
也不得让 NF3 把其 native binding 复制进发行物。

应用自己的 Node package 若通过 `createRequire()`、原生 binding loader 或运行时资源路径加载，可以在
`residualDependencies.packages` 中声明；freezer 会从 application root 预解析并交给 NFT 追踪，即使它不在 ESM module graph
中也会进入 distribution。无法由 NFT 静态发现的 package 内动态资源使用 `residualDependencies.fullTrace`，该列表自动隐含
`packages`。显式声明但无法解析的 package 必须使构建失败；最终实际闭包仍以 `pluxel-deployment.json` 为准。

`pluxel-deployment.json` 记录 server entry、catalog hash、target、variant、Workbench MF producer/Content inventory 与 residual package facts。
runtime 以 bootstrap 注入的 deployment root 读取产物，不从 workspace package root 或 `process.cwd()` 推断。

同一 final assembly 的最后一步调用 `@pluxel/rolldown/distribution` 生成确定性 `pluxel-distribution.json`。如果外部任务之后继续写入
目录，必须用 `pluxel distribution create` 调用同一 finalizer。完整 inventory、DSSE、offline verification 和 marker 不变量见
[`DISTRIBUTION.md`](DISTRIBUTION.md)。

Workbench Shell、producer 和 Content plan 是 browser-facing outputs，不内联进 server chunk。Shell 使用
`workbench/public/`，producer 使用 `workbench/<producer>/<revision>/`，Content 使用
`workbench/content/<definition-digest>/<content-set-digest>/content-plan.json`；Workbench root 分别写唯一
`pluxel-workbench-producers.json` 与 `pluxel-workbench-content.json`。业务 SPA 可以独立输出到 `public/`，不会覆盖这些 inventory。
`variant: 'workbench'`
表示产物具备能力；是否在某次启动安装 Workbench 仍由 application `configure()` 返回值决定。
headless 与 workbench 使用分离的 internal Node adapter；headless dependency graph 不解析 Workbench installer/backend，
不是只依赖 minifier 删除未用分支。

## Workbench source declaration

Browser-safe declaration 使用：

```ts
export const ExampleWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './guide.md'),
		placement: workbench.tab({ label: 'Guide' }),
	}),
	settings: workbench.view<SettingsApi>({
		renderer: workbench.entry(import.meta.url, './ui/settings.tsx'),
		placement: workbench.tab({ label: 'Settings' }),
	}),
})
```

Semantic pass 在 TypeScript 擦除前解析 `workbench.define()`、entry key、Content/View/Attachment kind，以及 literal
`workbench.markdown(import.meta.url, relativePath, slots?)` / `workbench.entry(import.meta.url, relativePath)`，再与 owning
canonical `PluginDefinitionAddress` 合成 declaration identity。
Markdown 由 build-time CommonMark/GFM + directive compiler 降为有界 portable AST；HTML、图片、相对/不安全链接、task list、
frontmatter、错误 slot topology 和不支持的语法 fail-fast。`data()`/`action()` 的静态 declaration 被 lower 为 slot metadata；真实
schema 只保留在 server module，不求值、不序列化。Markdown source 进入 watch graph，但不进入 server bundle 或 browser parser。
同一 Plugin definition 的全部 renderers 被 lower 成一个 `WorkbenchFederationProducerPlan`；每个 declaration 生成一个
stable `./views/<key>` expose 和 generated React Bridge entry。作者不声明 owner、remote name、expose、public path、
manifest URL、shared 或 Bridge wrapper。Content 独立编译为一个 definition-scoped immutable Content set；Content-only definition 的
producer 数为零，不启动 Federation builder，也不做 React/Mantine compatibility 检查。

Mixed Content/View 的 generated Bridge 只导入 renderer descriptor 的 identity projection，不导入完整 definition。Renderer 若直接
静态 import definition，toolchain 将该 import 改写到同一 projection；dynamic/indirect definition import 直接拒绝。Packaging sentinel
检查 JS、source map 与 dynamic types，确保 Content schema/handler 不进入 browser outputs，而不是依赖普通 tree-shaking。

UI entry 不进入 server bundle。反向边界同样成立：UI source graph 只能引用 browser-safe Workbench definition、
`@pluxel/runtime/capnweb` 类型、`@pluxel/runtime/workbench/react` 和公开 UI peers，不得包含 Plugin implementation、
Context、database handle 或 Node API。

额外 Node entry 使用 module-level declaration：

```ts
const taskModule = defineNodeModule(import.meta.url, './task.ts')
```

共享 worker task 使用相同 artifact pipeline，但声明同时携带 input/output 类型：

```ts
const resizeTask = defineWorkerTask<ResizeInput, ResizeOutput>(
	import.meta.url,
	'./resize-worker.ts',
)
```

唯一的 `pluginArtifactBuildPlugin` 在同一次 server transform 中收集已 lower 的 Workbench producer/Content plans 与 Node
declarations。Node branch 输出 `dist/artifacts/node/<artifact-key>.mjs`；Workbench 和 Node 使用独立 identity、
source/build revision、validator 和 target config，只共享 build orchestration 与 bounded admission。`workbench: false`
完全跳过 renderer 与 Markdown compiler/accessor。

Production lowering、`pluginArtifactBuildPlugin` coordinator 与 Node artifact compiler 位于
`packages/rolldown/src/plugin-artifact/`。Workbench semantic lowering、MF validation/build primitive 位于
`src/workbench/` 与 `src/vite/`；Node 和 browser output 不共用运行时 identity。

Node artifact 必须是单文件 ESM，不得 value-import Pluxel runtime/core、CSS/browser asset 或嵌套 Pluxel declaration。
普通 JS/TS dependency 继续内联。唯一受控 residual 是 source graph 中某个 package 自己 direct
`dependencies` / `optionalDependencies` 声明，且 metadata 明确含 `napi`、`binary`、`gypfile` 或入口解析为 `.node` 的 native
package。所有权按发出该 import 的文件最近 package root 校验，而不是要求最外层插件重复声明传递依赖；未声明 native import
与同名多 entry 解析都会失败。构建器把静态 default/named native import 编译成 package-owner-aware bridge：产物先定位 entry
package，再沿 source graph 的 package chain 定位真正 owner，最后从 owner manifest 用 `createRequire` 加载 binding。这样 pnpm
strict layout 下也不会错误地从最外层 artifact 解析 Canvas 的私有依赖；dynamic/namespace/`export *` native import 会被明确拒绝。
artifact 的静态 import 仍只剩 Node builtins，`onNativeResidual` 继续报告 binding 给部署追踪。workspace build 优先使用
`@pluxel/hmr` source condition，发布包使用 `publishConfig` 的 default entry，两条图应用相同 validator。`defineNodeModule`
本身不定义 worker protocol；`defineWorkerTask` 的 default export contract 与调度生命周期由 runtime 统一拥有。

## Development compiler

Runtime-dev compiler 对 Workbench 只接受 shared semantic pass 产生的完整 producer/Content plan：

1. 按 definition + build revision + build root 去重 task；
2. 收集 renderer 与 Markdown source graph，并把 graph/hash 与 plan 的 build revision 交叉验证；
3. 同步 materialize Content set，并快速复用内存或磁盘上已验证的 producer candidate；
4. 先提交 definition topology、Content 与已可用 producer；缺失 producer 会撤掉该 definition 的当前 federation
   pointer，但对应 View/Attachment placement 仍保留在 layout 中并显示 building 状态；
5. 缺失 producer 进入后台 build queue，使用持久 Vite/cache root；同一 cache root 的访问串行化，避免 DTS/Vite
   临时文件竞争；
6. 后台完成后确认该 plan 仍是最新 desired revision，再把 producer 与同一轮 Content candidate 作为完整 tuple 原子提交；
7. 后台失败时不提交 producer inventory，而是把对应 layout entry 更新为 failed 状态和安全错误 message；
8. 验证 Manifest/Snapshot、exact exposes/shared/runtime assets，以及 Content definition/content digest 和 portable plan；
9. 有界保留 disk cache，stale/superseded candidate 不再获得 commit authority。

Node module 继续拥有独立 watcher、content-addressed build、staged setup 和 last-known-good。Workbench producer 成功 commit
通过 session epoch invalidation 驱动 full document reload；producer-status-only 的 building/failed 展示可在同一 session
轻量刷新，但不做 Content-local reconnect 或页内 remote replacement。

`workbench.entry(import.meta.url, './renderer.tsx')` 的 literal path 相对声明模块解析；lowering 从实际
definition/renderer module 收集 source graph，在 owning package root 的 `.pluxel/workbench-generated/` 生成 Bridge entry，
并把 package-relative entry 写入 producer plan。Builder 明确区分三个目录事实：producer root 解析 Bridge/source 与 producer
依赖；host application root 作为 Vite root，并决定 fixed shared winner、compatibility signature 与 MF export detection；两者的
最小公共祖先作为 TypeScript declaration `rootDir`，覆盖跨 workspace link 的 producer。这里不接受调用方目录列表、absolute
renderer declaration、runtime-module fallback、root override 或第二套 filesystem discovery。

## Production build

生产构建输出 `dist/workbench/<producer>/<revision>/mf-manifest.json`、`remoteEntry.js`、expose chunks、CSS 和 dynamic
types；Content 输出 `dist/workbench/content/<definition-digest>/<content-set-digest>/content-plan.json`。Root 分别写
`dist/workbench/pluxel-workbench-producers.json` 与 `dist/workbench/pluxel-workbench-content.json`。发布包和 static application
都消费预编译 Content inventory，因此 distribution 不要求保留原始 `src/*.md`。Cache/build revision 包含解析后的 UI 源码图、
实际命中的 package metadata 与 subpath、fixed shared compatibility set 和 compiler version；无关 workspace lockfile 内容不参与。
Builder 不接受调用方覆盖 Vite、shared、Bridge、并发或 cache policy。

固定 singleton shared 包来自 `@pluxel/core/federation`：React/ReactDOM 及实际 subpaths、`@mantine/core`、
`@mantine/hooks`、MF React Bridge、`@pluxel/runtime/workbench`、`/client`、`/react` 和 toolchain-only
`@pluxel/runtime/internal/workbench-react`。每项使用 exact version、`singleton: true`、`loaded-first`；
application root 必须能解析全部 Shell-provided package；producer 自己解析到的 React、Runtime 与可选 Mantine 也必须与 winner
一致。开发 producer 只启用 `@pluxel/hmr`/`@pluxel/source` package exports，distribution producer 只使用 built exports；调用方必须
显式选择，不能从目录或现有 dist 猜测。Manifest 缺项或版本不一致使 candidate 失败。Production builder 按同一 build contract 生成 Shell 与 producer，写入 exact
profile/build-contract producer inventory，并逐项用 canonical plan 和 compatibility set 校验 Manifest/Snapshot；任何不一致都使
application build 失败。

Mantine shared 只提供 module implementation，不提供跨 React root 的 Context。Renderer 继续创建自己的
`MantineProvider`；`@mantine/core` 基础 CSS 由 Shell 唯一加载，producer compiler 对 Core stylesheet import fail-fast，避免每个
remote 重复输出同一份 CSS。未进入固定 profile 的 UI library 不获得这种处理。

固定 shared 全部使用 `import: false`，producer 不携带 fallback。MF Vite 1.21.1 的 used-export collector 不能用公开配置表达
“完整 export surface”；builder 因此在 expose analysis 前注入带内部 marker 的 bare side-effect import，并在后置 transform 删除。
这保证传递依赖需要的 React/Mantine export 仍出现在 host-backed facade，同时 marker 和 shared implementation 都不进入产物。

Dynamic types 使用 MF 2.9 的默认 `tsc`，不再把绝对 compiler executable 交给 package manager。开发 producer 默认省略
dynamic type artifact，只校验浏览器运行时 contract；显式 required 或 production producer 仍生成并校验 `api` 与 `zip`
类型资产。required DTS build 使用 producer-scoped `tsBuildInfoFile` 与串行 cache transaction，避免并发 producer 共享
MF 默认 cache 文件；production 中类型、Manifest 或 asset 缺失都使 candidate 失败。

Production producer 不输出内嵌源码 sourcemap；runtime-dev producer 保留 sourcemap 供开发诊断。

static freezer 无论 headless/workbench variant 都收集可达 Node artifacts，并在 `pluxel-deployment.json` 记录 key、
relative file 与 sha256；artifact builder 同时把受控 native residual 的已解析 entry 交给 NF3，因此只在 worker entry 中出现的
binding 也会被复制进 deployment `node_modules`。variant 只改变 browser Workbench closure。

`@pluxel/core/federation` 是唯一 dependency-neutral build contract。runtime-dev、Rolldown 和 host 直接依赖该
contract，不通过 runtime 转手 re-export，也不引入反向 build dependency。
