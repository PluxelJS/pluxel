# HMR

HMR 是 `@pluxel/runtime-dynamic` 的 HMR mode，不是独立包。它把 Vite、源码执行、watch、moduleGraph 和插件 UI 编译接到 loader route 上，并通过 loader batch 提交 runtime module replacement。

## 设计边界

Loader HMR mode 拥有：

- loader HMR config diagnose
- Vite HMR server
- SSR runner
- watcher 和 moduleGraph traversal
- runner singleton bridge
- HMR batch orchestration
- 通过 `ctx.loader.beginBatch()` 做 runtime module replacement
- HMR 期插件 UI 源码编译

Loader HMR mode 不拥有：

- 生产 runtime 服务
- runtime 协议定义
- core 生命周期算法
- 正式运行时 UI 注册语义

一句话边界：loader HMR mode 负责“源码如何变成可运行模块/remote”，runtime 负责“可运行 artifact 如何注册和消费”。

## 当前 HMR 流程

```text
file change
-> Vite moduleGraph affected ids
-> runner import
-> loader batch replaceModule
-> runtime affected module sync
-> core registry commit
```

HMR summary 需要解释：

- changed/target modules
- runtime affected modules
- synced modules
- auto-disabled missing dependencies
- enabled-but-stopped plugins
- commit failures

## Workspace Path Model

loader HMR 里有三种 `roots`，不要混用：

- `pluxel.loader.hmr.jsonc` 的 `roots`：workspace discovery scope，只决定哪些 package 会被扫描出来。
- `LoaderHmrWorkspace.enabledEntries`：真正提交给 loader/HMR 的入口，只来自 profile enabled package 和显式 include。
- `LoaderHmrWorkspace.watchRoots`：HMR/Vite 的 watch 和 `server.fs.allow` scope，不会自动启用插件。

诊断阶段统一把路径输出成 root-relative snapshot；host 启动阶段再以 `root/cwd` 解析成绝对路径。这样 CLI、TUI、host script 和测试 fixture 都使用同一套路径模型。

monorepo 下 `watchRoots` 会包含 enabled workspace package 的 workspace dependency closure。这个 closure 的语义只限于 HMR 观察范围：

- 不修改 `pluxel.loader.hmr.jsonc`。
- 不扩大 discovery roots。
- 不把 dependency package 加进 `enabledEntries`。
- 不自动启用另一个插件。
- 遵守 `omitPackages`，避免 builtin/double-load 包被拉回 source watch。

这样做是为了让被启用插件 import 的 workspace shared package 能被 Vite 访问和监听。若 dependency package 本身也是插件但没有被 profile enabled，diagnose 会给 warning；HMR 可以看到源码变化，但 runtime 是否启用该插件仍由 profile/config 决定。

## 插件 UI HMR

作者侧可以写：

```ts
ui('./ui/index.tsx').bind(ctx)
```

开发期由 runtime-dynamic HMR bridge 消费源码入口并编译 remote；build 期由 build plugin 改写；runtime 最终只消费：

```ts
ctx.ext.ui.remote.packaged()
```

runtime 永远不应该回头理解 source `entryPath`。

## Vite 配置

Loader HMR 的 programmatic 入口直接接收 Vite `InlineConfig`。这让 GQLens、React、macro、GraphQL codegen 这类已有 Vite 插件可以按用户熟悉的方式接入：

```ts
import react from '@vitejs/plugin-react'
import { gqlens } from '@gqlens/vite'
import { defineLoaderHmrConfig } from '@pluxel/runtime-dynamic/hmr'

export default defineLoaderHmrConfig({
	root: import.meta.dirname,
	configPath: 'pluxel.loader.hmr.jsonc',
	vite: {
		plugins: [
			gqlens({
				entry: '/src/graphql-entry.ts',
				output: 'src/gqlens',
				endpoint: '/graphql',
				framework: 'react',
			}),
			react(),
		],
		resolve: {
			alias: {
				'@generated/graphql': '/absolute/path/to/generated/graphql.ts',
			},
		},
	},
})
```

这份 `vite` 配置会合并进 dynamic HMR server；插件 UI remote build 也会复用同一份配置。Pluxel 先生成 runner、config-source、HTTP bridge、Paraglide、Module Federation remote 和 remote output 等内部基线，再把用户 Vite config 作为最后一层 merge。

需要谨慎对待的字段：

- `plugins`：可以正常追加；如果插件假设自己运行在普通 app dev server，要确认它不会拦截 Pluxel HMR 内部请求。
- `server` / `preview` / `appType`：会影响 HMR server 行为，改错会直接破坏开发宿主。
- `resolve` / `ssr` / `environments`：会影响 runner singleton、workspace source condition 和 linked package 去重。
- `build` / `worker`：会影响插件 UI remote build；覆盖 `outDir`、`rollupOptions.input`、MF remote 相关输出会导致 runtime 找不到 remote artifact。

原则是：API 放开为标准 Vite config；配置错误导致 HMR 或 remote build 不正确，由配置方负责。

## MF2 在 Loader HMR 的角色

Loader HMR mode 不把 MF2 当 authoring API。MF2 只定义 remote artifact format 和宿主加载协议；loader HMR mode 负责发现 UI 源码变更、触发 remote build，并处理 HMR watch/rebuild/submit。

当前共享的 `@pluxel/rolldown/vite/plugin-ui` build helper 策略：

- 同一插件包根目录共享 root-scoped build scheduler。
- 同 root 多个 UI remote 串行构建。
- 每次真实 MF2/Vite build 默认在当前进程内执行。
- 每次只清理本次专属临时 cache，避免误删 root federation 临时目录。
- `@module-federation/vite` 仍会在测试环境跳过插件加载，所以测试环境只在创建 federation 插件时临时设置 `MFE_VITE_NO_TEST_ENV_CHECK=true`。

`@module-federation/vite@1.16.6` 已经不需要每次 build 新开子进程；同进程连续 build 通过回归测试。但同一 root 下并发 build 仍可能让 MF virtual module id 互相串扰，所以 root-scoped 串行队列仍是必要边界，而不是旧 workaround。这个 helper 是 route-neutral 的 Vite 工具链能力；dynamic/static route 可以在需要插件 UI 子编译时复用，但它不拥有两条 route 的 HMR 提交流程。

## 实现入口

- `packages/runtime-dynamic/src/hmr.ts`：`createLoaderHmrHost` / `installLoaderHmr` / diagnose exports。
- `packages/runtime-dynamic/src/hmr/host.ts`：loader HMR host planning/boot internals。
- `packages/runtime-dynamic/src/hmr/install-hmr-runtime.ts`：把 loader HMR 安装到已有 runtime `Context`。
- `packages/runtime-dynamic/src/hmr/engine/LoaderHmrService.ts`：HMR server、runner、watch pipeline。
- `packages/runtime-dynamic/src/hmr/engine/config.ts`：Vite config、bridge modules、dedupe、optimizeDeps。
- `packages/runtime-dynamic/src/hmr/engine/pipeline.ts`：graph processing、executor、commit scheduler。
- `packages/runtime-dynamic/src/hmr/engine/runner.ts`：SSR runner 和 bridge handling。
- `packages/runtime/src/plugin.ts`：route-neutral `ui(...)` / `worker(...)` authoring bridge。
- `packages/runtime-dynamic/src/hmr/extensions/ExtensionCompilerService.ts`：HMR 期消费 bridge、编译 UI、提交 compiled module。
- `packages/rolldown/src/vite/plugin-ui.ts`：共享的插件 UI remote build helper。
- `packages/runtime-dynamic/src/hmr/diagnose/**`：loader HMR config 和 workspace diagnose。
- `packages/runtime-dynamic/src/hmr/snapshot.ts`：`LoaderHmrWorkspace`。

## 静态插件目录的 HMR 方向

`@pluxel/runtime-static/hmr` 已实现轻量 static HMR 基线：外部 Vite SSR import 重新得到 `StaticRuntimeDefinition`，static route 只按 plugin name diff fixed catalog，并提交 affected enabled plugins。它不复用 dynamic loader replacement，也不拥有 Vite server、module graph、module id registry、package cache 或 loader batch。

两条 route 的 HMR 能力保持一致的目标是“插件代码变化后可以重新提交运行中插件”，不是共享同一个 loader。dynamic route 负责动态 module exports -> loader batch；static route 负责 definition -> catalog diff；插件 UI remote build 这类 Vite/MF 子编译能力统一在 `@pluxel/rolldown/vite/plugin-ui`。

固定插件集合可以支持开发期热替换，但语义不是“动态 loader HMR”：

- 启动时插件集合必须已知。
- HMR runner 可以重新 import static entry 或 plugin boundary。
- 替换目标必须映射回已知 plugin id/name。
- 插件集合 drift 默认报错，要求重启或显式允许。
- 不使用 workspace scan、package install、dynamic module catalog。
- 不把 loader route 的 `enabledEntries` / `watchRoots` 规则复用给 runtime-static route。

也就是说，runtime-static route 的 HMR 优势来自 fixed catalog：边界更严格、诊断更确定；代价是不能像 loader route 那样自然支持插件集合漂移和动态安装。
