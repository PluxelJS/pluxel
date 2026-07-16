# Toolchain Architecture

Workbench UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。

## Plugin package build

`pluxel build` 只负责编排，实际构建由 `@pluxel/rolldown/build` 的 `pluginPackage()` preset 通过 tsdown 驱动
Rolldown。`pluginPackage()` 与 `staticApplication()` 都组合唯一的 `createPluginBuildPipeline()`：preprocessor、macro、
legacy decorator、`design:paramtypes`、lint、config metadata、Workbench declaration extraction 和 decorator output
guard。`pluginPackage()` 自己组合单次 semantic pass 与 metadata transaction；CLI 不追加 compiler plugins。
`runWithTsdown()` 按基础 hook、preset metadata hook、用户 hook 的顺序组合 `onSuccess`，overlay 不覆盖用户行为。

optional plugin source transform 只接受 module-level `const optionalPlugin(() =>
import(<literal>).then(<export selection>))`。Rolldown 和 Vite 使用同一个 semantic pass 完成声明校验、依赖事实收集和
route-specific import policy；普通 dynamic import 不获得 plugin 语义。

`pluginPackage()` 从 semantic facts 直接把 detected required provider 和 optional provider 保持为 external peer，
不依赖 metadata transaction 完成后的下一次构建；optional loader 还会注入仅供运行时区分 direct absent 与
transitive broken 的目标 package 注记。`staticApplication()` 与 Vite source route 采用 bundle-or-absent：可解析
candidate 进入 module graph，不可解析 candidate 变成显式 absent virtual module。两种策略共享语义分析，但不混淆
发布包与固定应用的产物边界。

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

constructor concrete package usage 是 `required`，optional ref literal import 是 `optional`，required 胜出。
版本范围只来自 peer/dev/dependency authoring metadata；发布边界统一写入 `peerDependencies`，optional 同步
`peerDependenciesMeta.optional = true`。同一 build 的多格式 output 读取同一 facts snapshot，下一次 `buildStart` 才重置；
连续构建与 ESM/CJS 双输出都保持幂等。源码删除依赖时，上一版生成的 peer、optional peer metadata 与 legacy
`dependOn` 会一并清理；devDependencies 保留供作者工具使用。metadata transaction 任何失败都会使 build 失败。

两条 production route 只在输出拓扑处分叉：plugin package 保留 runtime peer boundary、dts 和 package exports；static
application 追加全量 runtime closure、nf3 residual tracing、platform bootstrap 与 deployment assembly。不要把 static
assembly 塞进 source pipeline，也不要在 CLI 复制 pipeline plugin 列表。

Vite route 使用 `@pluxel/rolldown/vite` 的 source adapter，复用 preprocessor、plugin semantics、lint 和 config metadata
语义，并由 Vite/OXC 提供 legacy decorator transform。preprocessor 作为顶层 Vite plugin 参与完整 transform 生命周期，
同时用于 Workbench UI production build；plugin semantics、lint 和 config metadata 只应用于 server environment。
runtime-dev 只增加 ModuleRunner、watcher 和 Workbench UI compiler，不维护另一份安全可复用的 source transform 列表。

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
remote extraction 和 production preprocessing，然后生成 platform bootstrap。fixed plugins、runtime-static 和可达的
runtime/core 默认属于 application bundle closure；code splitting 允许，但输出不得残留 `@pluxel/*` deployment import。
可解析 optional candidate 形成内部 chunk；不可解析 optional candidate 形成带结构化 absent code 的 virtual chunk，
不得进入 nf3 residual 或 deployment external。

Node target 用 `nf3` externalize 并追踪 native/non-bundleable residual packages，复制到 distribution 自己的
`node_modules`。这只是 bundler 无法安全内联部分的 fallback，不是部署端 package install 模式。当前 freezer 只发布
Node application；在提供真正 platform-neutral 的 runtime/service closure 前，不生成伪 neutral Worker bundle。

`pluxel-deployment.json` 记录 server entry、catalog hash、target、variant、Workbench artifacts 与 residual package facts。
runtime 以 bootstrap 注入的 deployment root 读取产物，不从 workspace package root 或 `process.cwd()` 推断。

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
作者不声明 plugin ID。artifact 按 key 内容寻址，committed mount 时才关联 Context owner。

UI entry 不进入 server bundle。反向边界同样成立：UI source graph 只能引用 browser-safe contract、
`@pluxel/runtime/workbench/contract`、`@pluxel/runtime/workbench/ui` 和公开 UI peers，不得包含 server Workbench
entry、Plugin、Context 或 Node API。

额外 Node entry 使用 module-level declaration：

```ts
const taskModule = defineNodeModule(import.meta.url, './task.ts')
```

唯一的 `pluginArtifactBuildPlugin` 在同一次 server transform 中提取 Workbench 与 Node declaration，并注入由
package identity/version、package-relative declaration path 和 literal entry 生成的 stable key。Node branch 输出
`dist/artifacts/node/<artifact-key>.mjs`；它与 UI branch 共享 declaration identity、source/build hash、缓存、去重与
原子发布，但使用独立 Node graph、validator 和 Vite target config。`workbench: false` 只关闭 UI branch。

Node artifact 必须是自包含单文件 ESM（Node builtins 除外），不得 value-import Pluxel runtime/core、CSS/browser
asset 或嵌套 Pluxel declaration。它不定义 external escape hatch、worker protocol 或 inline fallback。

## Development compiler

runtime-dev artifact compiler：

1. 按 target + declaration key 去重 UI/Node source declaration；
2. 收集各自 Vite module graph 与相关源文件；
3. 计算 target-specific source/build hash；
4. 构建 Federation remote 或单文件 Node ESM 到 content-addressed cache；
5. generation guard 后原子提交 artifact state；
6. 最后一个 owner lease unload 时停止 watcher，并有界保留历史 artifact。

compiler 在绑定 declaration 时立即发布 `building`；ready/error revision 驱动 Workbench，不使用客户端轮询猜测。

## Production build

生产构建按 artifact key 输出 `dist/workbench/<artifact>/`。缓存 key 包含源码图、依赖 lockfile、shared version、
compiler version 和显式 Vite cache key。UI Contract 和 UI runtime 都是 singleton Federation shared package。
production remote 不输出内嵌源码的 sourcemap；runtime-dev remote 保留 sourcemap 供开发调试。

static freezer 无论 headless/workbench variant 都收集可达 Node artifacts，并在 `pluxel-deployment.json` 记录 key、
relative file 与 sha256；variant 只改变 browser Workbench closure。

`@pluxel/core/federation` 是唯一 dependency-neutral build contract。runtime-dev、Rolldown 和 host 直接依赖该
contract，不通过 runtime 转手 re-export，也不引入反向 build dependency。
