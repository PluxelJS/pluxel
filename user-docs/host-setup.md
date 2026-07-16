# 配置插件宿主

插件源码必须由带 Pluxel route plugin 的 Vite host 加载。static 和 dynamic 的区别是插件来源，不是插件作者 API。

## 选择 route

- static：插件目录由应用代码固定，适合产品内置插件和可审计部署。
- dynamic：插件来自 workspace scan/loader，适合开发宿主和动态插件目录。

两者都复用同一 core lifecycle、runtime services 和 Workbench Plane。

HTTP、config、logger、events、persistence 和 plugin data 随 `@pluxel/runtime` 主入口注册。Vault
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
import { AccountsPlugin } from './plugins/AccountsPlugin.ts'
import { BillingPlugin } from './plugins/BillingPlugin.ts'

export default defineStaticRuntime({
	name: 'billing-host',
	plugins: [AccountsPlugin, BillingPlugin],
	configure({ env, deployment }) {
		return {
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

用 `vite` 启动。不要用 raw TypeScript runner 执行 `pluxel.static.ts` 或插件入口。

`plugins` 是固定 catalog：production build 后不能从外部增加或替换插件代码。`configure()` 本身进入 bundle，
但会在每次启动时重新执行，因此环境变量、平台 bindings、persistence、logging、HTTP、plugin config records 和
runtime enabled state 仍可变。运行时启停只改变 fixed catalog 中哪些插件运行，不改变 catalog 本身。
`runtimeState.snapshot.enabled` 使用 `@Plugin({ name })` 的稳定 ID；不要从 constructor `.name` 动态生成，class name
会在 production minify 后改变。

## Static production build

`tsdown.config.ts` 直接指向同一个 canonical entry：

```ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	target: 'node',
})
```

```sh
pnpm exec tsdown
node dist/app.mjs
```

`dist/` 是可搬运的 application distribution：

- server entry 与 code-split chunks；
- fixed plugins、`runtime-static`、所需 runtime/core closure；
- `pluxel-deployment.json`；
- `variant: 'workbench'` 时位于 `workbench/` 的 Workbench shell 和 extension remotes；
- Node native/dynamic dependencies 需要时生成的最小 `node_modules`。

目标机不需要安装 `@pluxel/*`。`variant` 是 build-time capability：`headless` 不携带 Workbench，启动时不能再开启；
`workbench` 携带 artifacts，但仍可用 `PLUXEL_WORKBENCH=false` 或等价启动配置关闭。Node target 读取
`PLUXEL_HOST_BIND` 和 `PLUXEL_HOST_PORT`。当前 freezer 只支持 Node application；不要把 Node runtime closure 标成
neutral/Worker bundle。Node distribution 若同时含有业务 SPA 的 `public/`，关闭 Workbench 时会以它作为 HTML/static
fallback；开启 Workbench 时根页面属于 Workbench。Fetch 平台需要未来独立的 platform-neutral runtime adapter。

## Dynamic host

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

dynamic runtime config 提供 workspace root、loader config、profile 和 runtime state。loader 负责发现和替换模块；插件本身仍按 [`plugin-authoring.md`](plugin-authoring.md) 编写。

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
