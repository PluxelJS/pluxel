---
title: 编写第一个插件
description: 从 CLI 模板完成配置、HTTP 路由和生命周期测试。
---

在[快速开始](./index.md)中运行应用后，这篇教程带你创建一个可独立发布的 Plugin 包，加入配置和 HTTP 路由，并用测试验证启动与清理。

## 创建独立插件包

在 `my-app` 所在的父目录执行以下命令。这篇练习先用独立包验证插件，接入应用宿主的步骤见文末。

```sh
pnpm dlx @pluxel/cli@1 new --template plugin --name @acme/pluxel-plugin-status --root .
cd status
pnpm add -D @types/node@24 --save-catalog
pnpm verify
```

生成命令默认安装依赖。本例额外安装 Node.js 类型，因为下面会使用计时器和 `URL`；`--save-catalog` 将版本加入模板已有的 catalog。
模板已配置好导出、构建、测试和热更新；接下来只需修改两个文件：

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
	private readonly config = this.configs.use(StatusConfig)
	private samples = 0

	protected override init(): void {
		this.ctx.elysia.get('/status', () => ({
			label: this.config.label,
			samples: this.samples,
		}))

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
| Elysia 路由和长期资源    | `init()`                               |
| 资源释放                 | 当前 Context 的 `effects`              |

默认值和范围只写在 schema 中。constructor 只用于 required Plugin dependency；当前 Plugin 没有依赖，所以省略。

## 验证运行结果

用下面的内容替换 `tests/status.test.ts`：

```ts no-twoslash
import { createRuntimeTestHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { StatusPlugin } from '@acme/pluxel-plugin-status'

describe('StatusPlugin', () => {
	it('starts with config and mounts its route', async () => {
		await using host = createRuntimeTestHost()
		await host.start(StatusPlugin, {
			initialConfig: { label: 'healthy', intervalMs: 1_000 },
		})

		const response = await host.http.fetch(new URL('/status', host.http.origin))

		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ label: 'healthy', samples: 0 })
	})
})
```

`createRuntimeTestHost()` 使用真实配置校验、依赖图和 lifecycle。`start()` 立即提交并等待稳定，`initialConfig` 只建立首次
lifecycle 前的 fixture config；后续更新使用 `host.config.patch()`。`await using` 在作用域结束后关闭 host。
`ctx.elysia` 是当前 generation 的真实 Elysia 2 application，`/status` 就是最终产品路径。Plugin 与它的 Part 完成 `init()` 后，Runtime
会 compile/seal app 并原子发布；`host.http.fetch()` 经过同一个 in-process directory，路由和 timer 都随 generation 在 shutdown、
replacement 或 rollback 时清理。

运行完整检查：

```sh
pnpm verify
```

## 接下来

- 添加 required 或 optional dependency：[Plugin 模型与生命周期](./plugin-model.md)
- 拆分 owner 内部的 config、registration 和 cleanup：[使用 PluginPart](./plugin-parts.md)
- 增加配置字段和表单 metadata：[配置模型](./configuration.md)
- 把 Plugin 放进应用宿主：[配置插件宿主](./host-setup.md)
- 覆盖失败、replacement 和 rollback：[测试 Pluxel 插件](../development/testing.md)
