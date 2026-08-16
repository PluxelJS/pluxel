# Toolchain Architecture

Workbench UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。

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

Pluxel checkout 内的 `local-projects/*` 使用仓库拥有的 `scripts/source-local-project.mjs` 作为首次安装入口。
launcher 在 consumer pnpm 生命周期之外运行，必要时先安装并构建当前 checkout 的 CLI，再登记同一开发树中的
Pluxel 与 local repository checkout，最后委托正常的 `pluxel source install`。不得把首次 bootstrap 放进
consumer 的 pnpm script：pnpm 可能在执行 script 前先做 dependency-status install，此时 source overlay 尚未生成，
会把私有 source package 错误解析到 registry。launcher 只解决 in-tree 开发 checkout 的可达性；package closure、
overlay、构建与 lockfile 仍由唯一的 `pluxel source` 实现拥有。
不声明 `pluxel.sources.jsonc` 的 registry-managed local project 也使用同一 launcher；该分支直接在项目根目录
运行 pnpm install，不生成 source registry、overlay 或链接。source install options 只接受于声明了 source
配置的项目，避免同一个 flag 在两条安装路径上产生模糊语义。
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

## Plugin package build

`pluxel build` 只负责编排，实际构建由 `@pluxel/rolldown/build` 的 `pluginPackage()` preset 通过 tsdown 驱动
Rolldown。`pluginPackage()` 与 `staticApplication()` 都组合唯一的 `createPluginBuildPipeline()`：preprocessor、macro、
legacy decorator、Plugin semantic facts、lint、single-object config metadata、Workbench declaration extraction 和 decorator
output guard。`pluginPackage()` 自己组合单次 semantic pass 与 metadata transaction；CLI 不追加 compiler plugins。
`runWithTsdown()` 按基础 hook、preset metadata hook、用户 hook 的顺序组合 `onSuccess`，overlay 不覆盖用户行为。

Plugin semantic pass 在 TypeScript 擦除前建立 package/source root named export table，并 lower：

- concrete `@Plugin` definition address 与 `displayName`/`startTimeoutMs` marker facts；
- constructor parameter 的 direct root value-import provenance 与 ordered required edges；
- non-exported module-level `definePluginRef<T>()` 的 direct root type-import provenance；
- `init()` 中 direct `plugins.use(Ref, callback)` 的 optional restart edges；
- abstract token/provider relation。

同一 pass 由 plugin package、static application 和 Vite source route 复用。未能证明 root provenance、同一 constructor
经多个根名称导出、plugin-bearing subpath、跨包 Plugin re-export、async/间接 optional setup 都在 build 时失败。普通
dynamic import 不获得 Plugin 语义。

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

constructor concrete package usage 是 `required`，`definePluginRef<T>()` 的 direct type import 是 `optional`，required 胜出。
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
static/dynamic 对配置 import graph 的收集与失效复用同一个 runtime-dev helper；artifact compiler 的 worker 数、
缓存保留和 Federation shared package 集合属于内核不变量，不进入 Context 或 route config。
Workbench browser entry 在 route `config` hook 进入 Vite optimizer；插件 UI 的 watch graph 则通过 SSR environment
收集，不能为了编译元数据调用 client transform 并向 optimizer 注入不完整依赖批次。
Dynamic host 显式使用 `mode: 'distribution'` 时仍保留 source transform/HMR pipeline，但 package resolution 不启用
`@pluxel/hmr`、`development` 或 `@pluxel/source`，Workbench 改由 `@pluxel/runtime/dist/public` 提供，HTML 也不注入
Vite client。该模式把 bare SSR package import 留给 Node host，避免已经物化的 CommonJS/native package 被 Vite Module
Runner 当作 ESM source 内联；显式 source entry 仍经过 Pluxel transform pipeline。该模式用于 host-owned 可搬运 source
distribution；目录 closure、inventory 与签名不由 route plugin 猜测。
static/dynamic route 分别使用 `.pluxel/vite/static-runtime-v2` 和 `.pluxel/vite/dynamic-runtime-v2` 作为当前
optimizer contract 的默认 Vite cache，
避免与相同 root 下的业务前端 optimizer 互相替换；host 显式提供 `cacheDir` 时始终优先。reset baseline 的内部
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

Node target 用 `nf3` externalize 并追踪 native/non-bundleable 或无法安全跨 CommonJS/ESM 边界内联的 residual packages，
复制到 distribution 自己的 `node_modules`。PostgreSQL `pg` 属于后一类：freezer 保留它的 Node package boundary，避免改变
`pg-pool` 的 CommonJS 构造器语义。这只是 bundler 无法安全内联部分的 fallback，不是部署端 package install 模式。当前
freezer 只发布 Node application；在提供真正 platform-neutral 的 runtime/service closure 前，不生成伪 neutral Worker bundle。

应用自己的 Node package 若通过 `createRequire()`、原生 binding loader 或运行时资源路径加载，可以在
`residualDependencies.packages` 中声明；freezer 会从 application root 预解析并交给 NFT 追踪，即使它不在 ESM module graph
中也会进入 distribution。无法由 NFT 静态发现的 package 内动态资源使用 `residualDependencies.fullTrace`，该列表自动隐含
`packages`。显式声明但无法解析的 package 必须使构建失败；最终实际闭包仍以 `pluxel-deployment.json` 为准。

`pluxel-deployment.json` 记录 server entry、catalog hash、target、variant、Workbench artifacts 与 residual package facts。
runtime 以 bootstrap 注入的 deployment root 读取产物，不从 workspace package root 或 `process.cwd()` 推断。

同一 final assembly 的最后一步调用 `@pluxel/rolldown/distribution` 生成确定性 `pluxel-distribution.json`。如果外部任务之后继续写入
目录，必须用 `pluxel distribution create` 调用同一 finalizer。完整 inventory、DSSE、offline verification 和 marker 不变量见
[`DISTRIBUTION.md`](DISTRIBUTION.md)。

Workbench shell/remotes 是 browser artifacts，不内联进 server chunk。shell 使用 `workbench/public/`，remote 使用
`workbench/<artifact>/`；业务 SPA 可以独立输出到 `public/`，不会覆盖 Workbench manifest。`variant: 'workbench'`
表示产物具备能力；是否在某次启动安装 Workbench 仍由 application `configure()` 返回值决定。
headless 与 workbench 使用分离的 internal Node adapter；headless dependency graph 不解析 Workbench installer/backend，
不是只依赖 minifier 删除未用分支。

## Source declaration

server Extension 使用：

```ts
workbench.extension({
	contract: BrowserSafeContract,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
```

Rolldown 静态提取 literal entry，并按 declaration module、entry path、source graph、Contract/shared versions 和
compiler version 生成稳定 artifact key。构建 transform 把该 key 注入 `workbench.entry()` 的 internal 第三参数；
作者不声明 owner address。artifact 按 key 内容寻址，committed mount 时才关联 Context 的 Plugin node owner。

UI entry 不进入 server bundle。反向边界同样成立：UI source graph 只能引用 browser-safe contract、
`@pluxel/runtime/workbench/contract`、`@pluxel/runtime/workbench/ui` 和公开 UI peers，不得包含 server Workbench
entry、Plugin、Context 或 Node API。

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

唯一的 `pluginArtifactBuildPlugin` 在同一次 server transform 中提取 Workbench 与 Node declaration，并注入由
package identity/version、package-relative declaration path 和 literal entry 生成的 stable key。Node branch 输出
`dist/artifacts/node/<artifact-key>.mjs`；它与 UI branch 共享 declaration identity、source/build hash、缓存、去重与
原子发布，但使用独立 Node graph、validator 和 Vite target config。`workbench: false` 只关闭 UI branch。

production lowering 的 stable identity、`pluginArtifactBuildPlugin` coordinator 与 Node artifact compiler 共同位于
`packages/rolldown/src/plugin-artifact/`。Workbench remote validator/build primitive 仍留在 `src/workbench/` 与 `src/vite/`：
co-location 只收拢共同 declaration/build lifecycle，不把 browser artifact 实现和 Node compiler 混成一个模块。

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

runtime-dev artifact compiler：

1. 按 target + declaration key 去重 UI/Node source declaration；
2. 收集各自 Vite module graph 与相关源文件；
3. 计算 target-specific source/build hash；
4. 构建 Federation remote 或单文件 Node ESM 到 content-addressed cache；
5. generation guard 后原子提交 artifact state；
6. 最后一个 owner lease unload 时停止 watcher，并有界保留历史 artifact。

compiler 在绑定 declaration 时立即发布 `building`；ready/error revision 驱动 Workbench，不使用客户端轮询猜测。

UI build root 按显式 `pluginDirs`、absolute declaration entry 最近的 package root、runtime module、Vite root 的顺序解析。
dynamic source entry 可以只是宿主目录中的临时 re-export wrapper；absolute UI entry 仍由实际持有 browser source graph 的插件 package
构建，wrapper 只提供 runtime source anchor，不能改变 Federation shared dependency 的解析边界。relative UI entry 则继续以声明插件的
runtime module 为基准解析。

## Production build

生产构建按 artifact key 输出 `dist/workbench/<artifact>/`。缓存 key 包含源码图、依赖 lockfile、shared version 和
compiler/build-contract version。UI Contract 和 UI runtime 都是 singleton Federation shared package；shared 集合来自
`@pluxel/core/federation` 的唯一 contract，remote builder 不接受调用方 Vite、shared、并发或缓存策略覆盖。
Workbench shell 写入 contract protocol build info；static freezer 在复制 shell 前必须与当前 runtime package
metadata 核对，缺失或不一致直接使构建失败，不能生成 server/shell 跨版本的静态闭包。
production remote 不输出内嵌源码的 sourcemap；runtime-dev remote 保留 sourcemap 供开发调试。

static freezer 无论 headless/workbench variant 都收集可达 Node artifacts，并在 `pluxel-deployment.json` 记录 key、
relative file 与 sha256；artifact builder 同时把受控 native residual 的已解析 entry 交给 NF3，因此只在 worker entry 中出现的
binding 也会被复制进 deployment `node_modules`。variant 只改变 browser Workbench closure。

`@pluxel/core/federation` 是唯一 dependency-neutral build contract。runtime-dev、Rolldown 和 host 直接依赖该
contract，不通过 runtime 转手 re-export，也不引入反向 build dependency。
