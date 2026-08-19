# @pluxel/runtime-static

Static route 以一个 `defineStaticRuntime()` 默认导出固定插件 catalog。Vite 开发和 production build 都消费同一入口；插件 API、core lifecycle、runtime services 和 Workbench contract 与 dynamic route 共用。

## Canonical entry

```ts
// src/pluxel.static.ts
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'
import { DemoPlugin } from './DemoPlugin.ts'

export const product = defineProduct({
	displayName: 'Rhythm',
	publisher: 'Example Company',
})

export default defineStaticRuntime({
	name: 'app',
	plugins: [DemoPlugin],
	configure({ env, deployment }) {
		return {
			runtimeState: {
				snapshot: { enabled: [pluginNodeAddressOf(DemoPlugin)] },
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

可选 named export `product` 是 route-neutral 的应用展示信息。它不进入 `defineStaticRuntime()`；缺失时为 `null`，非法值会使
entry 加载失败。Vite 与 production bootstrap 都从同一个 ESM module namespace 读取它，标准 re-export 也有效。

`plugins` 是 build-time fixed code graph。`configure()` 的代码会进入 bundle，但会在每次宿主启动时重新读取 env、bindings 和 deployment；plugin config records、runtime enabled state、persistence、logging 与 HTTP 配置仍是运行时数据。

Static catalog、RuntimeState、config owner 与 HMR 都使用 lowering 生成的结构化 Plugin node address；class name 和 `displayName` 只用于展示。`configure()` 在 canonical entry 完成求值后执行，因此可以在回调中通过 `pluginNodeAddressOf()` 取得 address。源码移动或 root export 重命名会产生新的 identity，不读取或迁移旧 name-key state。

## Vite development

```ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [staticRuntimeVitePlugin({ entry: './src/pluxel.static.ts' })],
})
```

Vite SSR 加载 canonical entry。插件模块变化执行 catalog HMR；entry 或只影响 `configure()` 的依赖变化会重建 host；Workbench UI 由开发 compiler 增量构建。

## Production application

```ts
// tsdown.config.ts
import { staticApplication } from '@pluxel/rolldown/build'

export default staticApplication({
	entry: './src/pluxel.static.ts',
	variant: 'workbench',
	target: 'node',
})
```

构建产物包含 server entry、fixed plugins、`runtime-static` 与所需 runtime/core closure、deployment manifest，以及 variant 选择的 `workbench/public` shell 和 extension remotes。freezer 生成 namespace-based bootstrap，执行 canonical entry 后分别消费 default application 与 `product`，不静态求值或复制产品字段。业务 SPA 可以独立输出到 `public/`。Node native 或动态依赖由 `nf3` 追踪到产物自己的 `node_modules`；目标机不安装 Pluxel packages。

`variant` 决定 artifact 是否存在，启动时的 `workbench` 配置决定是否启用。`headless` 产物不能在启动时开启 Workbench。当前 freezer 只生成 Node application，并拥有 HTTP listener 与 signal shutdown；在 runtime services 拆出真正 platform-neutral closure 前不开放 Fetch/Worker target。
headless 与 workbench 使用独立的 production adapter，因此 headless server closure 不解析 Workbench backend。

测试使用 `createStaticRuntimeTestHost()`：

```ts
import { createStaticRuntimeTestHost } from '@pluxel/runtime-static/test'
```

用户配置见 [`../../docs/getting-started/host-setup.md`](../../docs/getting-started/host-setup.md)，内部边界见 [`../../engineering/RUNTIME.md`](../../engineering/RUNTIME.md)。
