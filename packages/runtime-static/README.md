# @pluxel/runtime-static

Static route 使用应用代码声明的 fixed plugin catalog。插件源码仍由 host-owned Vite/Rolldown 链加载；static 只描述插件来源，不改变插件 API。

## Host entry

```ts
// vite.config.ts
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [staticRuntimeVitePlugin({ config: './src/pluxel.static.ts' })],
})
```

```ts
// src/pluxel.static.ts
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { DemoPlugin } from './DemoPlugin.ts'

export default defineStaticRuntimeConfig({
	name: 'app',
	plugins: [DemoPlugin],
	runtimeState: { snapshot: { enabled: ['DemoPlugin'] } },
	persistence: './.pluxel/persistence',
	workbench: {
		enabled: true,
		access: { exposure: 'private' },
	},
})
```

Vite plugin 负责 SSR source loading、decorator/config metadata、host lifecycle、request forwarding、UI source compiler 和 config-module reload。

`runtimeState.snapshot` 是首次运行 seed；存在持久状态后以持久状态为准。

## Prebuilt runtime

`createStaticRuntime()` 只适用于已经由 Pluxel toolchain 生成 JavaScript 和 UI/worker artifacts 的部署入口，不得直接执行插件 TypeScript 源码。它在 resolve 前启动 fixed catalog，并暴露 fetch/lifecycle handle。

## Boundaries

- production entry 不引入 Vite、Rolldown 或 watcher；
- `/vite` entry 拥有开发 wiring；
- runtime common 与 dynamic loader 都不是 static 的依赖；
- Workbench Plane 是否安装只由 runtime config 的顶层值决定。

用户配置路径见 [`../../user-docs/host-setup.md`](../../user-docs/host-setup.md)，内部边界见 [`../../docs/RUNTIME.md`](../../docs/RUNTIME.md)。
