---
title: 编写第一个插件
description: 从 CLI 模板完成配置、HTTP 路由和生命周期测试。
---

本教程从 CLI 生成的单文件 Plugin 开始，加入配置和 HTTP 路由，再用真实 runtime host 验证启动与清理。

## 创建项目

```sh
pnpm dlx @pluxel/cli new --template plugin --name @acme/pluxel-plugin-status
cd status
pnpm verify
```

官方模板默认完成依赖安装；需要只生成文件时传入 `--no-install`。模板已经配置 package root export、
`@pluxel/hmr` 源码入口、tsdown、Vitest 和本地 `@pluxel/cli`。生成后只有两个需要修改的文件：

```text
src/status.ts
tests/status.test.ts
```

## 编写 Plugin

用下面的内容替换 `src/status.ts`：

```ts twoslash
import { BasePlugin, f, Plugin, v } from '@pluxel/runtime'

export const StatusConfig = v.object({
	label: v.optional(v.pipe(v.string(), f.formMeta({ title: '状态标签' })), 'ready'),
	intervalMs: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1_000),
			f.formMeta({ title: '采样间隔' }),
			f.numberMeta({ step: 1_000 }),
		),
		30_000,
	),
})

@Plugin({ displayName: 'Status' })
export class StatusPlugin extends BasePlugin {
	readonly config = this.configs.use(StatusConfig)
	private samples = 0

	override init(): void {
		this.ctx.http.plugin.routes((app) =>
			app.get('/status', () => ({
				label: this.config.label,
				samples: this.samples,
			})),
		)

		const timer = setInterval(() => {
			this.samples += 1
		}, this.config.intervalMs)
		this.ctx.effects.defer(() => clearInterval(timer), { tag: 'status-sampler' })
	}
}
```

这个文件包含四个固定位置：

| 内容                     | 位置                                   |
| ------------------------ | -------------------------------------- |
| identity 和展示 metadata | module-level `@Plugin()` class         |
| config contract          | class-level `this.configs.use()` field |
| 路由和长期资源           | `init()`                               |
| 资源释放                 | 当前 Context 的 `effects`              |

默认值和范围只写在 schema 中。constructor 只用于 required Plugin dependency；当前 Plugin 没有依赖，所以省略。

## 验证运行结果

用下面的内容替换 `tests/status.test.ts`：

```ts no-twoslash
import { withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { StatusPlugin } from '@acme/pluxel-plugin-status'

describe('StatusPlugin', () => {
	it('starts with config and mounts its route', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add(StatusPlugin)
				host.cfg(StatusPlugin).set({ label: 'healthy', intervalMs: 1_000 })
				host.cfg(StatusPlugin).enable()
				await host.commit()

				const plugin = host.require(StatusPlugin)
				const statusUrl = `http://local${plugin.ctx.http.plugin.base('/status')}`
				const response = await host.ctx.http.fetch(new Request(statusUrl))

				expect(response.status).toBe(200)
				expect(await response.json()).toMatchObject({ label: 'healthy', samples: 0 })
			},
			{ workbench: false },
		)
	}
})
```

`withRuntimeHost()` 使用真实配置校验、依赖图和 lifecycle，并在 callback 结束后关闭 host。路由和 timer 都属于当前 Plugin generation；shutdown 时由 runtime 清理。

运行完整检查：

```sh
pnpm verify
```

## 接下来

- 添加 required 或 optional dependency：[Plugin 模型与生命周期](./plugin-model.md)
- 增加配置字段和表单 metadata：[配置模型](./configuration.md)
- 把 Plugin 放进应用宿主：[配置插件宿主](./host-setup.md)
- 覆盖失败、replacement 和 rollback：[测试 Pluxel 插件](../development/testing.md)
