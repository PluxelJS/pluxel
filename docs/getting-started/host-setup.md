---
title: 配置插件宿主
description: 为现有项目选择 static 或 dynamic host，并配置 Plugin 清单、运行状态和 Workbench。
---

Pluxel 提供静态和动态两种宿主模式。静态宿主的 Plugin 清单由入口文件确定；动态宿主在固定清单之外，还可以监听运行时增删的文件来源。Plugin 的写法不随模式变化，两者共享同一套依赖图、配置、运行时服务和生命周期。

从零创建完整应用时先使用 [example monorepo](../development/starter-monorepo.md)，它已经包含可运行的 static host、alternative dynamic host、Vite 和构建配置。本页用于把 Pluxel 接入现有项目。

## 选择宿主模式

| 场景                                           | 选择         |
| ---------------------------------------------- | ------------ |
| 产品内置 Plugin、清单固定、需要审计和冻结      | 静态模式     |
| 需要在宿主运行期间增加或删除 Plugin 文件入口   | 动态模式     |
| 需要把包含动态 Plugin 来源的宿主部署到其他环境 | 动态发行模式 |

不要根据是否需要 HMR 选择宿主模式：两种模式在开发期都支持模块热更新，也使用相同的 generation 清理流程。业务 Plugin 不需要为两种模式编写不同实现。

## Static host

```sh package-install
npx nypm add @pluxel/runtime @pluxel/runtime-static
```

```sh package-install
npx nypm add -D @pluxel/rolldown vite tsdown
```

### Canonical entry

```ts no-twoslash
// src/pluxel.static.ts
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { OrdersPlugin } from '@acme/orders'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
})

export default defineStaticRuntime({
	name: 'rhythm',
	plugins: [OrdersPlugin],
	configure({ env, deployment }) {
		return {
			runtimeState: {
				snapshot: { enabled: [pluginNodeAddressOf(OrdersPlugin)] },
			},
			persistence: env.PLUXEL_DATA_ROOT ?? `${deployment?.root ?? '.'}/data`,
			workbench: env.PLUXEL_WORKBENCH === 'false' ? false : { enabled: true },
		}
	},
})
```

`plugins` 定义 build-time fixed catalog 和 code closure；运行时依赖图由 enabled state、fork 和 provider override 形成。`workbench`、persistence、logging、HTTP、Plugin config records 和 enabled state 是 `configure()` 返回的 startup data。

`prepare()` 用于必须在 Plugin graph 启动前成功的 application-owned prerequisite。它在 runtime services ready 后执行；抛错会终止 startup 并清理已经创建的 host resources。应用共享数据库可以在这里 eager migrate/preflight，只有部分 Plugin 使用的数据库则保持 lazy。不要在 `prepare()` 中替 Plugin 调用 `ctx.database.use()`；两种数据所有权的选择见[数据库与数据归属](../runtime/database.md)。

不要把 `root` 或 `workbench` 直接写进 static application 顶层。`configure()` 每次宿主启动都会重新读取 env、bindings 与 deployment。

`product` 是 canonical module 的可选 named export，不放进 `defineStaticRuntime()`。Static 与 dynamic 使用同一个 `defineProduct()` contract。

### 初始化 Plugin config 的部署变量

少量部署变量需要初始化 Plugin config 时，在 canonical entry 使用 `configEnvironmentBootstrap`，并把 Plugin 实际交给 `configs.use()` 的同一个 exported schema 传给 `bindConfigEnvironment()`：

```ts no-twoslash
import { bindConfigEnvironment, defineStaticRuntime } from '@pluxel/runtime-static'
import { OrdersConfig, OrdersPlugin } from '@acme/orders'

export default defineStaticRuntime({
	name: 'orders',
	plugins: [OrdersPlugin],
	configEnvironmentBootstrap: [
		bindConfigEnvironment(OrdersPlugin, OrdersConfig, {
			endpoint: 'ORDERS_ENDPOINT',
			concurrency: 'ORDERS_CONCURRENCY',
		}),
	],
	configure({ env, deployment }) {
		return {
			persistence: env.PLUXEL_DATA_ROOT ?? `${deployment?.root ?? '.'}/data`,
		}
	},
})
```

这里的 environment 是 config store 的一次性 bootstrap transport；已有 persisted config 始终优先。Host-only 的 persistence、Workbench、logging 或 platform policy 仍在 `configure()` 读取自己的环境值。完整的 decoder、缺失值、优先级和 secret 边界见[配置模型](./configuration.md#用部署环境初始化-static-config)。

### Vite development

```ts twoslash
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [staticRuntimeVitePlugin({ entry: './src/pluxel.static.ts' })],
})
```

Vite SSR 加载 canonical entry。Plugin module 变化执行 catalog HMR；entry/configure dependency 变化重建 host；Workbench remote 由开发 compiler 增量构建。

React、业务 alias 和普通 Vite plugin 属于 host `vite.config.ts`。不要复制 Pluxel semantic transform、SSR package classifier 或 runtime source alias。

### Production application

```ts twoslash
// tsdown.config.ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	target: 'node',
})
```

`variant` 决定 artifact 是否包含 Workbench shell/remotes：

- `headless`：没有 Workbench artifact，startup 不能开启 UI；
- `workbench`：artifact 包含 UI，startup config 仍可关闭它。

生产产物包含 Node server entry、fixed Plugin closure、deployment manifest 和所需 Node dependencies。目标机不再安装 Pluxel packages。

`configEnvironmentBootstrap` 非空时，构建还会生成 root `.env.example`。它是 distribution inventory 中的普通 immutable asset；不会包含构建机 value，也不会生成或加载 `.env`。如果其他 assembly input 已占用该保留路径，构建会失败而不是覆盖。

freezer 默认同时携带 managed database 的 PGlite 与 PostgreSQL driver，使 `configure()` 可以在启动时选择任一 backend。部署若只支持部分 driver，使用 `managedDatabaseDrivers` 收窄闭包；完全使用 application-private database 时传空数组，并在 runtime config 中设置 `database: false`：

```ts twoslash
export default staticApplication({
	entry: './src/pluxel.static.ts',
	managedDatabaseDrivers: [],
})
```

这个列表必须覆盖 `configure()` 可能返回的每个 managed database driver。未列出的 driver 不会复制进发行物；Plugin 首次实际取得该 database capability 时会进入明确的 absent module，并报告该 deployment 未包含对应 driver。

需要生产 source map 时可同时设置 `sourcemap: true` 与 `sourcemapExcludeSources: true`。后者保留路径和行列映射，但不在每份 `.map` 中嵌入完整源码；目标环境另有可信源码归档时通常应开启。

最终 inventory、签名和 delivery marker 见 [Static 发行物](../development/distribution.md)。

## Dynamic host

```sh package-install
npx nypm add @pluxel/runtime @pluxel/runtime-dynamic
```

```sh package-install
npx nypm add -D vite
```

### Canonical config

```ts no-twoslash
// src/pluxel.dynamic.ts
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { HostOperationsPlugin } from './HostOperationsPlugin.ts'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
})

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	plugins: [HostOperationsPlugin],
	runtimeState: {
		snapshot: { enabled: [pluginNodeAddressOf(HostOperationsPlugin)] },
	},
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'dev',
	sources: [
		{ kind: 'file', path: 'plugins/local.ts' },
		{
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		},
	],
	logsDir: 'logs',
	workbench: {
		enabled: true,
	},
})
```

`plugins` 是宿主显式 import 的 fixed catalog；`sources` 是 mutable file entries。两者只声明 code availability，不会隐式启用 Plugin，enabled state 仍来自 `runtimeState`。

### Vite host

```ts twoslash
// vite.config.ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		dynamicRuntimeVitePlugin({
			config: './src/pluxel.dynamic.ts',
		}),
	],
})
```

Dynamic route 只拥有 file/source lifecycle：watch、OXC resolution、module execution、graph transaction 与 HMR。package download、market、安装管理 RPC 和页面不属于 route core。

运行期安装 package 时显式装配官方 [Package Manager Plugin](../plugins/package-manager.md)；它把受管 package 原子发布成 `.mjs` source entry，dynamic route 只观察这些文件。

### Source 约束

- `file` 声明一个精确 entry，暂时不存在时仍 watch parent。
- `directory` 必须给出相对 include glob；不接受 absolute、negation、`.` 或 `..` segment。
- startup 中已存在的 entries 必须完成初始 graph commit，runtime 才 ready。
- add/change/unlink 进入同一 HMR batch，不直接 mutation running instance。
- entry 普通 import graph 不受 include glob 限制，dependency 变化沿 importer graph 返回 entry。

不要把源码仓库或 `node_modules` 整体作为 source directory。producer 只发布普通 ESM entry，不调用 loader internal API。

### Distribution mode

可搬运 source-based host 显式使用：

```ts no-twoslash
dynamicRuntimeVitePlugin({
	config: './src/pluxel.dynamic.ts',
	mode: 'distribution',
})
```

它使用 built/default package export，不注入 Vite client，并从 runtime artifact 使用 Workbench shell。这个 mode 只定义执行拓扑；目录 closure、inventory、签名和原子发布仍由 distribution tooling 负责。

## 共享宿主策略

### Plugin config 与 runtime state

Host 的两类状态不要混淆：

- runtime state：哪些 Plugin enabled、fork、provider override；
- Plugin config record：交给每个 Plugin schema 校验的 raw object。

Static `configure()` 或 dynamic config 提供初始值，file/memory/readonly backend 决定持久化方式；`readonly` 会读取同一 durable file source，但拒绝 mutation，文件缺失时保留 startup snapshot 且不创建文件。Plugin 只看到已经 normalized 的 `this.config`；详细 contract 见 [配置模型](./configuration.md)。

### Workbench 与 management access

Workbench 是可选 host capability：

```ts no-twoslash
workbench: false
```

或：

```ts no-twoslash
workbench: {
	enabled: true
}
```

`workbench: false` 或省略该字段时不创建 registry、compiler、watcher、artifact route、resource transport 或 Workbench persistence。Plugin business HTTP、database、commands 和 lifecycle 不受影响。启用 Workbench 会同时启用默认 private 的 management plane。

不加载 Workbench UI、但需要通过 `@pluxel/runtime/web` 管理宿主时，只配置访问策略：

```ts no-twoslash
workbench: false,
management: {}
```

`management` object 的存在会启用 headless management；省略时，关闭 Workbench 的宿主没有 management route 或 backend。
省略 `management.access` 使用 private policy。公网管理面使用
`management: { access: { exposure: 'public', oidc: { ... } } }`；public access 必须在同一 access object 中提供 OIDC。
没有独立的 `enabled` flag，也不存在同时“启用 Workbench、禁用 management”的矛盾状态。宿主产品分类放在
`management.pluginGroups`，不要求安装 Workbench UI。

公网管理面必须由 host 明确配置 admin access/OIDC。`publicPath` 的业务 HTTP 和 Workbench exposure 是不同边界；开启固定业务 route 不等于开放管理权限。

### Logging root

每个进程只有一个 active logging root。Static/dynamic launcher 提供默认 console；dynamic 可以增加轮转 file sink，Workbench enabled 时可加入 store。

Plugin 只使用 `ctx.logger`。完整 host logging plan、debug topics 和 sensitive fields 见 [结构化日志](../runtime/logging.md)。

### 启动结果与进程策略

graph commit 返回结构化 summary：成功节点进入 running，failed 节点回滚，required dependents blocked，无关 Plugin 可以继续。

Static startup/HMR report 中的 `unavailable` 表示 enabled durable intent 当前没有 route catalog availability，例如 source 被移除后仍保留的 fork；它不是 `start-failed`。相同 definition address 再次出现时，runtime 会按保留的 enabled、fork 和 dependency policy 自动恢复。

宿主决定：

- 任一失败是否退出进程；
- 哪些 Plugin 是 deployment readiness 前提；
- 如何暴露 health endpoint；
- 何时告警或自动 restart；
- shutdown signal 和最终 timeout。

Plugin 不调用 `process.exit()`，也不根据 static/dynamic route 自行改变失败语义。

## 测试与检查

### 测试 host entry

Static application 测试使用：

```ts twoslash
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'
```

普通 runtime Plugin 测试使用 `@pluxel/runtime/test` 的 `withRuntimeHost()` 或 `createRuntimeHost()`。完整选择见 [测试插件](../development/testing.md)。

### 启动前检查

- canonical entry/config 通过 Vite route plugin 加载，不用 raw TS runner。
- static `plugins` 与 dynamic `sources` 没有重复表示同一 definition。
- fixed Plugin 是否 enabled 由 runtime state 明确决定。
- Workbench/admin exposure 与业务 HTTP auth 分开配置。
- persistence、logs、dynamic artifact cache 指向可写 state，不写 immutable deployment root。
- production build 与真实 Node/PostgreSQL/native 环境做过 smoke test。
