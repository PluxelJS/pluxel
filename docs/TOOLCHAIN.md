# Toolchain Architecture

Workbench UI build primitive 位于 `@pluxel/rolldown/vite/workbench-ui`。

## Plugin package build

`pluxel build` 只负责编排，实际构建由 `@pluxel/rolldown/build` 的 `pluginPackage()` preset 通过 tsdown 驱动
Rolldown。`pluginPackage()` 与 `staticApplication()` 都组合唯一的 `createPluginBuildPipeline()`：preprocessor、macro、
legacy decorator、`design:paramtypes`、lint、config metadata、Workbench declaration extraction 和 decorator output
guard。CLI 只追加 import tracker，不重新列举这些 compiler plugins。

两条 production route 只在输出拓扑处分叉：plugin package 保留 runtime peer boundary、dts 和 package exports；static
application 追加全量 runtime closure、nf3 residual tracing、platform bootstrap 与 deployment assembly。不要把 static
assembly 塞进 source pipeline，也不要在 CLI 复制 pipeline plugin 列表。

Vite route 使用 `@pluxel/rolldown/vite` 的 source adapter，复用 preprocessor、lint 和 config metadata 语义，并由
Vite/OXC 提供 legacy decorator transform。preprocessor 作为顶层 Vite plugin 参与完整 transform 生命周期，同时用于
Workbench UI production build；lint/config metadata 只应用于 server environment。runtime-dev 只增加 ModuleRunner、
watcher 和 Workbench UI compiler，不维护另一份安全可复用的 source transform 列表。

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

## Development compiler

runtime-dev compiler：

1. 将 Extension source declaration 绑定到 mount owner；
2. 收集 Vite module graph 与相关源文件；
3. 计算 source/build hash；
4. 构建 Federation remote 到 `.pluxel/workbench`；
5. 原子提交 artifact state；
6. owner unload 时停止 watcher 并移除 artifact。

compiler 在绑定 declaration 时立即发布 `building`；ready/error revision 驱动 Workbench，不使用客户端轮询猜测。

## Production build

生产构建按 artifact key 输出 `dist/workbench/<artifact>/`。缓存 key 包含源码图、依赖 lockfile、shared version、
compiler version 和显式 Vite cache key。UI Contract 和 UI runtime 都是 singleton Federation shared package。

`@pluxel/core/federation` 是唯一 dependency-neutral build contract。runtime-dev、Rolldown 和 host 直接依赖该
contract，不通过 runtime 转手 re-export，也不引入反向 build dependency。
