# @pluxel/runtime-dynamic

Dynamic route 为 workspace-driven plugin loading 提供 scan、loader、module replacement 和 HMR。Vite server 仍由 host application 持有。

## Host entry

```ts
// vite.config.ts
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [dynamicRuntimeVitePlugin({ config: './src/pluxel.dynamic.ts' })],
})
```

```ts
// src/pluxel.dynamic.ts
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'

export default defineDynamicRuntimeConfig({
	root: process.cwd(),
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'dev',
	logsDir: 'logs',
	workbench: {
		enabled: true,
		access: { exposure: 'private' },
	},
})
```

React、GraphQL、macro 和 alias 属于 host `vite.config.ts`；loader/runtime 配置属于 dynamic config。不要用 raw TypeScript runner 绕开 route plugin。

## Internal entry

`@pluxel/runtime-dynamic/hmr` 提供 CLI/test 使用的 diagnose、snapshot 和 loader HMR primitives。应用宿主优先使用 `/vite`。

source update 必须进入 core runtime update/replacement/commit；dynamic route 不直接修改 running plugin instance，也不复制 lifecycle。
package manifest 使用 `pluxel.pluginPackages: Record<package, 'required' | 'optional'>`；只有 required facts 进入
安装/卸载依赖索引，optional facts 用于 inventory、availability retry 和诊断。package install 会使 active optional
requests 失效并重新解析，但 optional request 自身不会授权自动安装。

用户配置路径见 [`../../user-docs/host-setup.md`](../../user-docs/host-setup.md)，内部边界见 [`../../docs/HMR.md`](../../docs/HMR.md)。
