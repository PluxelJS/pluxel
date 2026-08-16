---
title: 配置插件宿主
description: 正确装配 static/dynamic route、catalog、运行时状态、Workbench 和部署策略。
---

# 配置插件宿主

Static 与 dynamic 的差别是 Plugin source/catalog 从哪里来，不是 Plugin author API。两者使用同一个 dependency graph、config、runtime services 和 generation lifecycle。

## 选择 route

| 场景                                                    | Route                     |
| ------------------------------------------------------- | ------------------------- |
| 产品内置 Plugin、固定可审计 catalog、可冻结部署         | static                    |
| 开发期 mutable source、workspace HMR、运行期 entry 目录 | dynamic                   |
| 已物化、可搬运的 source-based host                      | dynamic distribution mode |

业务 Plugin 不根据 route 写两套实现。route launcher 负责加载 source，Plugin 只依赖公开 runtime contract。

## Static host

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
			workbench:
				env.PLUXEL_WORKBENCH === 'false'
					? false
					: { enabled: true, access: { exposure: 'private' } },
		}
	},
})
```

`plugins` 定义 build-time fixed catalog 和 code closure；运行时依赖图由 enabled state、fork 和 provider override 形成。`workbench`、persistence、logging、HTTP、Plugin config records 和 enabled state 是 `configure()` 返回的 startup data。

不要把 `root` 或 `workbench` 直接写进 static application 顶层。`configure()` 每次宿主启动都会重新读取 env、bindings 与 deployment。

`product` 是 canonical module 的可选 named export，不放进 `defineStaticRuntime()`。Static 与 dynamic 使用同一个 `defineProduct()` contract。

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

最终 inventory、签名和 delivery marker 见 [Static 发行物](../development/distribution.md)。

## Dynamic host

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
		access: { exposure: 'private' },
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

运行期安装 package 时显式装配 [Dynamic host 的 package manager](../development/package-manager.md)；它把受管 package 原子发布成 `.mjs` source entry，dynamic route 只观察这些文件。

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

Static `configure()` 或 dynamic config 提供初始值，file/memory/readonly backend 决定持久化方式。Plugin 只看到已经 normalized 的 `this.config`；详细 contract 见 [配置模型](./configuration.md)。

### Workbench 与 admin access

Workbench 是可选 host capability：

```ts no-twoslash
workbench: false
```

或：

```ts no-twoslash
workbench: {
	enabled: true,
	access: { exposure: 'private' },
}
```

disabled 时不创建 registry、compiler、watcher、artifact route、RPC/SSE transport 或 Workbench persistence。Plugin business HTTP、database、commands 和 lifecycle 不受影响。

公网管理面必须由 host 明确配置 admin access/OIDC。`publicPath` 的业务 HTTP 和 Workbench exposure 是不同边界；开启固定业务 route 不等于开放管理权限。

### Logging root

每个进程只有一个 active logging root。Static/dynamic launcher 提供默认 console；dynamic 可以增加轮转 file sink，Workbench enabled 时可加入 store。

Plugin 只使用 `ctx.logger`。完整 host logging plan、debug topics 和 sensitive fields 见 [结构化日志](../runtime/logging.md)。

### 启动结果与进程策略

graph commit 返回结构化 summary：成功节点进入 running，failed 节点回滚，required dependents blocked，无关 Plugin 可以继续。

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
