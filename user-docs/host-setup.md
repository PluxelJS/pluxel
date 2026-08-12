# 配置插件宿主

插件源码必须由带 Pluxel route plugin 的 Vite host 加载。static 和 dynamic 的区别是插件来源，不是插件作者 API。

## 选择 route

- static：插件目录由应用代码固定，适合产品内置插件和可审计部署。
- dynamic：插件来自 workspace scan/loader，适合开发宿主和动态插件目录。

两者都复用同一 core lifecycle、runtime services 和 Workbench Plane。

## 应用展示信息

Static 与 dynamic 都在各自已经必需的 canonical host module 中导出同一个可选 `product` named export。它是产品展示与
法律链接的唯一事实源，不属于 runtime config，也不会从 `package.json`、application name 或其他 metadata 推导：

```ts
import { defineProduct } from '@pluxel/runtime/product'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
	copyright: '© 2026 Example Company',
	legalLinks: [
		{ label: '软件许可', href: '/legal/license' },
		{ label: '第三方声明', href: 'https://example.com/notices' },
	],
})
```

`defineProduct()` 提供类型提示，并在运行时复制、校验和深度冻结结果。`displayName` 必填；链接只接受 `http:`、`https:`
或单 `/` 开头的站内路径。未知字段、首尾空白、控制字符、Promise 和非法 URL 会使宿主加载失败，不会静默改用其他来源。

未导出 `product` 时，host meta 明确为 `null`，Workbench 显示 Pluxel 默认标识。业务 SPA 需要复用同一对象时，可以把定义放在
普通 browser-safe module 中，再从 static/dynamic canonical module 使用 `export { product } from './product'` 标准
re-export；不需要新增 JSON、路径配置或 watcher。

HTTP、config、logger、events、persistence 和 database capability 随 `@pluxel/runtime` 主入口注册。Vault
不是常驻能力；只有需要保存密钥的宿主才在 canonical runtime entry 顶部显式启用：

```ts
import '@pluxel/runtime/services/vault'
```

未导入时不会注册 Vault service 或执行 eager preflight。插件只消费 `ctx.vault`，不应在各插件内重复决定
宿主是否启用 Vault。

## Static host

`vite.config.ts`：

```ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	plugins: [
		staticRuntimeVitePlugin({
			entry: './src/pluxel.static.ts',
		}),
	],
})
```

`src/pluxel.static.ts`：

```ts
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { product } from './product.ts'
import { AccountsPlugin } from './plugins/AccountsPlugin.ts'
import { BillingPlugin } from './plugins/BillingPlugin.ts'

export { product }

export default defineStaticRuntime({
	name: 'billing-host',
	plugins: [AccountsPlugin, BillingPlugin],
	configure({ env, deployment }) {
		return {
			database: env.DATABASE_URL
				? {
						driver: 'postgres',
						connectionString: env.DATABASE_URL,
						pool: { max: 20 },
					}
				: undefined,
			runtimeState: {
				snapshot: { enabled: ['AccountsPlugin', 'BillingPlugin'] },
			},
			persistence: env.PLUXEL_DATA_ROOT ?? `${deployment?.root ?? '.'}/data`,
			workbench:
				env.PLUXEL_WORKBENCH === 'false'
					? false
					: { enabled: true, access: { exposure: 'private' } },
		}
	},
})
```

`database` 省略时使用 persistence root 下的共享 PGlite，不自动读取 `DATABASE_URL`。远端连接必须由 startup resolver
显式传入；`database: false` 会完全关闭 capability，任何数据库插件都会诚实启动失败。测试若需要内存数据库，显式传
`{ driver: 'pglite', dataDir: 'memory://' }`。PGlite 的 durability 定位见 [`database.md`](database.md)。

用 `vite` 启动。不要用 raw TypeScript runner 执行 `pluxel.static.ts` 或插件入口。
route plugin 默认把 static/dynamic optimizer cache 隔离到各自的 `.pluxel/vite/` 子目录，因此同一项目 root 下的
业务前端可以使用自己的 Vite cache，并自动应用 Pluxel source conditions、core/runtime 与 React/Mantine singleton
dedupe。插件 package 的 `@pluxel/hmr` dev export 也由两种 route 自动解析，static host 不需要额外 source
alias。route 同时从 Vite watcher 排除整个生成态 `.pluxel/`，不监听 package-level source proxy，并防御旧版或损坏的递归链接；
宿主显式配置 `cacheDir` 时仍以宿主值为准，不要在项目里重复维护这些 watcher、Workbench/MF 底层默认值。

`plugins` 是固定 catalog：production build 后不能从外部增加或替换插件代码。`configure()` 本身进入 bundle，
但会在每次启动时重新执行，因此环境变量、平台 bindings、persistence、logging、HTTP、plugin config records 和
runtime enabled state 仍可变。运行时启停只改变 fixed catalog 中哪些插件运行，不改变 catalog 本身。
`runtimeState.snapshot.enabled` 使用 `@Plugin({ name })` 的稳定 ID；不要从 constructor `.name` 动态生成，class name
会在 production minify 后改变。

### 用环境变量初始化插件配置

Static 与 dynamic Node host 原生识别以下变量，不需要在 `configure()` 中按 plugin ID 手写 config snapshot：

```text
PLUXEL_CONFIG__<plugin-id>__<schema-key>[__<field>...]
```

例如：

```dotenv
PLUXEL_CONFIG__WorkerPlugin__config__endpoint=https://worker.example.com
PLUXEL_CONFIG__WorkerPlugin__config__concurrency=8
PLUXEL_CONFIG__WebPlugin__config__allowedOrigins=["https://app.example.com"]
```

值能被 JSON 解析时保留 array、object、boolean、number 或 null 类型，否则作为普通 string；之后仍由插件声明的
Standard Schema 完成校验和归一化。变量只初始化新的 config store，并会像 Workbench 保存的配置一样进入普通
持久化；已有 file config 始终优先，因此重启或升级不会用 env 覆盖管理员配置。host 明确传入的初始 snapshot 与 env
同时存在时，env 中的同路径优先。

这个入口用于非秘密的部署默认值。token、Cookie 和账号凭据仍使用插件拥有的 Vault/credential 流程，不要为了 env
方便把秘密降级成普通 plugin config。

`prepare()` 是可选的 application-wide eager policy，不是共享基础设施的唯一所有权入口。同一作者控制的 static plugins 可以
直接调用普通 application module 的无参数 lazy `use()`；只有希望数据库失败阻止任何 plugin 启动时，才在 `prepare()` 中调用
同一个入口预热。完整组织方式见 [`database.md`](database.md#static-application-共享数据库)。

## Static production build

`tsdown.config.ts` 直接指向同一个 canonical entry：

```ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	launcher: 'node',
	target: 'node',
	residualDependencies: {
		packages: ['@vendor/native-runtime'],
		fullTrace: ['@vendor/runtime-with-dynamic-assets'],
	},
})
```

`launcher` 默认是 `node`：产物启动时把 runtime Fetch boundary 包装为 Node HTTP listener，并额外导出
`address`。Electron utility process、测试之外的进程内宿主或已有网络适配器应使用 `launcher: 'fetch'`；该产物
只启动固定 catalog 并导出 `ctx`、`fetch`、`start`、`stop`，不创建 TCP listener。两种 launcher 使用完全相同的
plugin lifecycle、config、Vault、persistence、Workbench artifacts 和 distribution closure；不要用 test host 代替
生产 Fetch launcher。

通常不需要手写 `residualDependencies`；Pluxel 与 nf3 已覆盖框架 runtime 和已知原生 package。应用自己的 package
若只通过 `createRequire()`、原生 binding loader 或运行时路径加载，加入 `packages` 后会从应用根解析并由 NFT 精确追踪。
只有 package 内还有 NFT 无法静态发现的动态资源时才加入 `fullTrace`；`fullTrace` 自动隐含 `packages`。声明的 package
无法解析会直接使构建失败，目标机不需要再运行 package install 或手工复制脚本。

```sh
pnpm exec tsdown
node dist/app.mjs
```

`dist/` 是可搬运的 application distribution：

- server entry 与 code-split chunks；
- fixed plugins、`runtime-static`、所需 runtime/core closure；
- `pluxel-deployment.json`；
- `variant: 'workbench'` 时位于 `workbench/` 的 Workbench shell 和 extension remotes；
- Node native/dynamic 依赖以及 PostgreSQL `pg` 等无法安全内联的依赖所需的最小 `node_modules`。

Freezer 在 final assembly 末尾自动生成覆盖完整目录的 `pluxel-distribution.json`。如果业务 SPA、SBOM 或 packaging task 在此后继续
写入 `dist/`，必须在最后一次写入后运行 `pluxel distribution create ./dist`。检查、DSSE 签名和可选 delivery marker 流程见
[`distribution.md`](distribution.md)。

目标机不需要安装 `@pluxel/*`。`variant` 是 build-time capability：`headless` 不携带 Workbench，启动时不能再开启；
`workbench` 携带 artifacts，但仍可用 `PLUXEL_WORKBENCH=false` 或等价启动配置关闭。`launcher: 'node'` 读取
`PLUXEL_HOST_BIND` 和 `PLUXEL_HOST_PORT`。Node host 会在客户端中止请求或提前关闭流式响应时 abort 对应的 Fetch
`Request.signal` 并取消 response body；长请求应监听该 signal，流式 body 的 `cancel()` 应释放订阅、定时器等资源。
当前 freezer 只支持 Node application；不要把 Node runtime closure 标成 neutral/Worker bundle。Node distribution 若同时含有业务 SPA 的 `public/`，关闭 Workbench 时会以它作为 HTML/static
fallback；开启 Workbench 时根页面属于 Workbench。Fetch 平台需要未来独立的 platform-neutral runtime adapter。

## Dynamic host

`src/pluxel.dynamic.ts` 同样可以导出上文的 `product`；其结构与 static 完全一致，不写入
`defineDynamicRuntimeConfig()`：

```ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { HostOperationsPlugin } from './HostOperationsPlugin'

export { product } from './product.ts'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	plugins: [HostOperationsPlugin],
	sources: [{ kind: 'directory', path: 'plugins/runtime', include: ['*.mjs'] }],
	runtimeState: { snapshot: { enabled: ['HostOperationsPlugin'] } },
})
```

```ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	plugins: [
		dynamicRuntimeVitePlugin({
			config: './src/pluxel.dynamic.ts',
		}),
	],
})
```

dynamic runtime config 使用 `plugins` 声明宿主显式 import 的 fixed catalog，使用 `sources` 声明 mutable file catalog。
`plugins` 不隐式启用，启停仍由 RuntimeState 决定；fixed import graph 变化重建 host，source add/change/unlink 走增量 batch。`file`
source 是精确入口，`directory` source 必须用相对、正向 include glob 选择入口；glob 不能包含 negation、`.` 或 `..` segment。
目录或文件暂时不存在也可以先声明，runtime 会保留 watch root。一次配置最多解析 10,000 个 entry；普通 import dependency
不需要列入 entry glob，进入 module graph 后仍会触发所属插件 replacement。loader 负责文件 add/change/unlink 的发现与 graph
transaction；插件本身仍按
[`plugin-authoring.md`](plugin-authoring.md) 编写。

不经过宿主 Vite config 的程序化开发入口同样加载 config module，不接受含 constructor 的 object config：

```ts
import { createDynamicDevRuntime } from '@pluxel/runtime-dynamic'

const runtime = await createDynamicDevRuntime({ config: 'src/pluxel.dynamic.ts' })
await runtime.start()
```

runtime 不安装 package，也不提供 package-manager RPC 或内置页面。需要 registry 安装能力时使用官方
[`@pluxel/package-manager`](package-manager.md)，并把它发布的 entry directory 声明为 source。

bridge、SSR、optimizer、cache 和 Pluxel Vite plugins 由 runtime 统一管理，不在 config 中重复声明。CommonJS 与 N-API/
native package 会根据解析结果、扩展名和 package metadata 自动留在 Node host 执行；static 与 dynamic host 都不需要维护
`ssr.external` 或额外 package 名单。require-only exports 等 package 自身的 Node 调用约束仍应按该 package 文档使用。

## Logging root

每个进程只安装一个 active logging root。static/dynamic launcher 默认提供 console；dynamic launcher还提供轮转文件
sink。Workbench enabled 时 launcher 才加入 runtime store。插件只使用 `ctx.logger`，Workbench 修改的是同一个
root-owned plugin policy，不会为每个插件创建 LogTape logger config。

需要自定义时传入完整、显式的 `logging` plan：

```ts
logging: {
	root: {
		profile: 'dev',
		debugTopics: ['hmr:*', 'cache:lookup'],
		initialPluginPolicy: {
			version: 1,
			defaultLevel: 'info',
			overrides: { BillingPlugin: 'debug' },
		},
	},
	sinks: {
		console: {
			kind: 'console',
			format: 'pretty',
			caller: false,
			timezone: 'local',
		},
		store: { kind: 'store', streamId: 'default', caller: true },
	},
	routes: {
		runtime: [
			{ sink: 'console', minLevel: 'info' },
			{ sink: 'store', minLevel: 'trace' },
		],
		plugins: [
			{ sink: 'console', minLevel: 'trace' },
			{ sink: 'store', minLevel: 'trace' },
		],
		debug: [
			{ sink: 'console', minLevel: 'trace' },
			{ sink: 'store', minLevel: 'trace' },
		],
		meta: [{ sink: 'console', minLevel: 'warning' }],
	},
}
```

`plugins` route 通常保持 `trace`，再由 O(1) 的 plugin policy 查表决定实际等级。`logging: false` 仍会安装一个
无输出的 root，以保持 Context identity、policy 和控制面所有权一致；它不是“没有 logging manager”。
pretty console 会保持 info 日志紧凑，并在 warning/error/fatal 时直接展开错误和 lifecycle diagnostics；排查启动失败
不需要切换 JSON formatter 或只依赖 Workbench log store。

## Workbench Plane

只有一个顶层来源：

```ts
workbench: false
```

或：

```ts
workbench: {
	enabled: true,
	access: { exposure: 'private' },
}
```

不要再为 UI compiler、workbench routes 或 resource transport 配置独立开关。route plugin 从这个值派生整套安装行为。

关闭Workbench时插件 HTTP 仍然工作；Workbench extension callback 不执行，也不会初始化 compiler、artifact registry 或资源 transport。

## 启动结果

宿主应读取 lifecycle/startup report 决定进程策略：

- required plugin 是否全部 running；
- 哪些插件被 dependency failure 阻塞；
- 是否允许降级启动；
- 是否需要退出、告警或拒绝部署。

这些是宿主策略，不写进插件 metadata。
