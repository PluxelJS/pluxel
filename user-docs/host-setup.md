# 配置插件宿主

插件源码必须由带 Pluxel route plugin 的 Vite host 加载。static 和 dynamic 的区别是插件来源，不是插件作者 API。

## 选择 route

- static：插件目录由应用代码固定，适合产品内置插件和可审计部署。
- dynamic：插件来自 workspace scan/loader，适合开发宿主和动态插件目录。

两者都复用同一 core lifecycle、runtime services 和 Workbench Plane。

## Static host

`vite.config.ts`：

```ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	appType: 'spa',
	plugins: [
		staticRuntimeVitePlugin({
			config: './src/pluxel.static.ts',
		}),
	],
})
```

`src/pluxel.static.ts`：

```ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { AccountsPlugin } from './plugins/AccountsPlugin.ts'
import { BillingPlugin } from './plugins/BillingPlugin.ts'

export default defineStaticRuntimeConfig({
	name: 'billing-host',
	plugins: [AccountsPlugin, BillingPlugin],
	runtimeState: {
		snapshot: {
			enabled: ['AccountsPlugin', 'BillingPlugin'],
		},
	},
	persistence: './.pluxel/persistence',
	workbench: {
		enabled: true,
		access: { exposure: 'private' },
	},
})
```

用 `vite` 启动。不要用 raw TypeScript runner 执行 `pluxel.static.ts` 或插件入口。

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
