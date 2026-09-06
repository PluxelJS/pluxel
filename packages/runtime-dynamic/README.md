# @pluxel/runtime-dynamic

Dynamic route 把一组可变文件入口接入 OXC resolution、module execution、core graph transaction 和 HMR。它只拥有
文件级 source lifecycle；package 下载、market、安装状态、管理 RPC 和管理页面不属于本包。Vite server 仍由 host
application 持有。

## Host entry

```ts
// vite.config.ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [dynamicRuntimeVitePlugin({ entry: './src/pluxel.dynamic.ts' })],
})
```

```ts
// src/pluxel.dynamic.ts
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { defineProduct } from '@pluxel/runtime/product'
import { HostOperationsPlugin } from './HostOperationsPlugin'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
})

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	plugins: [HostOperationsPlugin],
	runtimeState: { snapshot: { autoStart: [pluginNodeAddressOf(HostOperationsPlugin)] } },
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'dev',
	sources: [
		{ kind: 'file', path: 'plugins/local.ts' },
		{ kind: 'directory', path: '.pluxel/generated-entries', include: ['*.mjs'] },
	],
	logsDir: 'logs',
	workbench: {
		enabled: true,
	},
})
```

可选 named export `product` 与 static route 使用完全相同的 contract 和 reader。它不属于
`defineDynamicRuntimeConfig()`；缺失时为 `null`，非法值使 canonical module 加载失败。产品定义可以从普通 browser-safe
module 标准 re-export，不需要 JSON 或独立 watcher。

React 和业务 alias 属于 host `vite.config.ts`；loader/runtime 配置属于 dynamic config。不要用 raw TypeScript
runner 绕开 route plugin，也不要复制 Pluxel 的 resolve、SSR、optimizer 或 host-module 配置。static/dynamic route 使用同一个
package classifier，让 CommonJS 与 native package 自动留在 Node host 执行；项目不维护 package 名单。

`sources` 是 dynamic 特有的最小扩展点：

- `file` 表示一个精确入口；文件暂时不存在时仍监听其父目录；
- `directory` 表示一个可变入口目录，必须给出相对该目录的正向 `include` glob；目录暂时不存在时仍作为 watch root；
- 启动时存在的匹配文件必须完成初始 graph commit 后 runtime 才报告 ready，之后的 add/change/unlink 进入同一 HMR batch；
- source producer 只需原子发布或删除普通 ESM 文件，不需要调用 loader、RPC 或 package API。

Vite 主 watcher 继续全局忽略 `.pluxel`。对于声明后确实落在 `.pluxel` 下的 source watch root，dynamic route 创建并拥有一个
补充 watcher；它的事件仍须通过声明生成的精确 file 或正向 include filter，其他持久状态、安装目录和缓存文件不会进入
Plugin batch。补充 watcher 与 host 一起关闭，不把 generated-file 监听变成通用 Vite 能力。

`plugins` 是宿主显式 import 的固定 catalog；省略时为空。它只声明代码 availability，不会写入 `autoStart` 或创建本次进程的
`run` intent。固定插件和
mutable source 插件都由同一个 Vite SSR ModuleRunner 求值，并统一读取 RuntimeState、constructor dependency、graph commit
和 effects lifecycle。固定插件 import graph 变化会重建整个 dynamic host；mutable source 变化只处理受影响的 entry。

Management diagnostics 将 fixed plugin 标为 `dynamic-fixed / host-reload`。Mutable entry 只有在 semantic facts 能证明它属于
当前 source graph 时才标为 `source-module / source-graph`；只有 active closure 内的 exact built semantic fact 才标为
`built-module / entry-only`，证据缺失或冲突时是 `unreported / entry-only`。`.ts`/`.mjs` 扩展名、package 路径和未命中 source
transform 都不是分类依据。Entry-only route 仍会在 producer 原子替换 entry 时执行 definition HMR，但不会监视已安装 package 的
内部源码。这个状态是当前 execution 事实，不是 source/built 在线切换开关；package identity 始终来自 definition address，browser
DTO 也不携带 module ID、file URL 或 absolute path。

每个 mutable batch 在独立 artifact generation 中收集 semantic facts；candidate 成功接纳才 commit，失败则 rollback。更新成功且没有
结构化异常时报告 `applied`；旧 catalog 仍为 authority 时报告 `retained-previous`；catalog 已发布后出现 commit-path rejection，或新 generation lifecycle 有 issue
时分别报告 `applied-with-issues / commit|lifecycle`。失败 Plugin generation 的 partial effects 仍清理，但不会因此把已发布 catalog
写成已回滚。`restored-previous / application-reload` 专属于 full application replacement 的 fresh-host compensation，不是 entry
HMR outcome。

关闭会先停止 watcher 与 direct API 准入，再等待 in-flight startup，并排空 active batch、`executeFiles()`、`warmup()` 和
Workbench Content refresh 共用的 execution lane，最后才删除 route-owned semantic/recent facts 并关闭 carrier/server。关闭前已接纳
的 Content refresh 可以完成发布，但不会再触发 browser reload；尚在排队的 direct call 会以 `HmrClosedError` 失败。

outer config 与 loader HMR 共用一个 host-owned ModuleRunner namespace。Elysia root、WebSocket 和其他公开 package subpath 先经
host package exports 校验，再以精确 canonical ESM URL externalize；即使 Vite root 没有安装 Elysia、Plugin 有自己的 nested
dependency 路径，Plugin import 仍与 `ctx.elysia` 保持引用相等。private `elysia/dist/*` 和带语义 query 的 URL 不进入该桥接。

`path` 相对 `root` 解析，也可以显式使用绝对路径。`include` 不接受 absolute、negation、`.` 或 `..` segment，避免 watcher
越过声明目录。一次配置最多解析 10,000 个 entry；达到上限应收窄 glob，而不是把源码仓库或 `node_modules` 整体当作 entry
目录。source entry 的普通 import dependency 不受 entry glob 限制：已进入 Vite graph 后，它的变化会沿 importer graph 回到
对应 entry。

`root` 不会修改宿主进程的 working directory；Vite config reload 始终保留 launcher cwd。Plugin 自己声明为相对 cwd 的文件配置
不随 dynamic `root` 隐式重定位；当两者不同时，宿主应给这类配置传绝对路径。

需要 registry package 安装时，装配官方 [`@pluxel/package-manager`](../../plugins/package-manager/README.md)。该插件把
受管 package 发布成 `.mjs` source entry，dynamic core 不知道 package manager 的存在。

## Internal entry

`@pluxel/runtime-dynamic/hmr` 是 `/vite` 与 route tests 使用的 host bridge；workspace diagnostics 只从
`@pluxel/runtime-dynamic/hmr/diagnose` 导出。应用宿主优先使用 `/vite`，根入口只公开 config、direct launcher 和
`DynamicPluginSource`；direct launcher 接收 config module path，并在启动时才加载 Vite/route internals。factory resolve 时
Vite listener、initial reconciliation 与 HMR 已 ready；返回资源拥有 listener、Runtime effects 与 watcher：

```ts
await using runtime = await startDynamicDevRuntime({
	entry: new URL('./src/pluxel.dynamic.ts', import.meta.url),
})

const response = await fetch(new URL('/health', runtime.origin))
```

相对 string `entry` 在 Vite plugin 中相对最终 `root`，在 direct launcher 中相对调用 factory 时捕获的 cwd；跨 cwd
脚本优先传 `file:` URL。可选 `signal` 只取消 startup，reject 前会关闭已取得的资源；factory 成功后由幂等
`dispose()` / `[Symbol.asyncDispose]()` 管理 lifetime。

source update 必须进入 core runtime update/replacement/commit；dynamic route 不直接修改 running Plugin instance，也不复制 lifecycle。
成功的 mutable source batch 更新正常 catalog slots；provider generation 变化由 core optional restart plan 处理，不存在 runtime
optional request、loader retry 或隐式 package installation。

可搬运的 source-based host 使用显式 distribution 模式：

```ts
dynamicRuntimeVitePlugin({
	entry: './src/pluxel.dynamic.ts',
	mode: 'distribution',
})
```

该模式仍通过 OXC/Vite 执行宿主与 mutable plugin source，但 bare package import 只选择 built/default export，Workbench
使用 `@pluxel/runtime` 自带的 `dist/public` bundle，也不会向 HTML 注入 Vite client。默认 `development` 模式保持框架
`@pluxel/source`、plugin `@pluxel/hmr`、Workbench source graph 与浏览器 HMR。distribution 模式只定义执行拓扑；完整目录
closure、inventory、签名和发布原子性仍由 host-owned distribution 工具负责。该模式的 Workbench remote cache 位于 runtime
persistence 的兄弟 `workbench-artifacts/`，宿主自己的 Vite `cacheDir` 也应显式指向可写 state，而不是不可变 artifact root。

用户配置路径见 [`../../docs/getting-started/host-setup.md`](../../docs/getting-started/host-setup.md)，内部边界见 [`../../engineering/HMR.md`](../../engineering/HMR.md)。
