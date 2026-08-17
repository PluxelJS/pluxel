---
title: 编写第一个插件
description: 在一页内完成插件包、配置、实现、宿主启用和生命周期测试。
---

# 编写第一个插件

本教程会创建一个带配置和 HTTP 路由的 Plugin，再通过真实测试宿主验证它能够启动、响应请求并完整清理资源。

## 创建插件包

CLI 模板会生成包根入口、TypeScript、构建和测试配置：

```sh
pluxel new --template plugin --name @acme/status
cd status
pnpm install
```

现有 Plugin package 需要使用 `pluxel build`、从 package root 导出具体 Plugin，并通过 `@pluxel/hmr` source condition 指向源码。完整 package contract 见 [插件 package](../development/plugin-package.md)。

## 最小文件结构

```text
src/
  config.ts
  StatusPlugin.ts
  index.ts
tests/
  StatusPlugin.test.ts
package.json
tsconfig.json
tsdown.config.ts
vitest.config.ts
```

Plugin 实现放在独立模块，package root 只负责公开稳定入口。

## 第一步和第二步：配置与 Plugin

```ts twoslash
// @filename: src/config.ts
import { f, v } from '@pluxel/runtime'

export const StatusConfig = v.object({
	label: v.optional(
		v.pipe(v.string(), f.formMeta({ label: '状态标签' }), f.stringMeta({})),
		'ready',
	),
	intervalMs: v.optional(
		v.pipe(
			v.number(),
			v.integer(),
			v.minValue(1_000),
			f.formMeta({ label: '采样间隔' }),
			f.numberMeta({ min: 1_000, step: 1_000 }),
		),
		30_000,
	),
})

// @filename: src/StatusPlugin.ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { StatusConfig } from './config.ts'

@Plugin({ displayName: 'Status' })
export class StatusPlugin extends BasePlugin {
	private readonly config = this.configs.use(StatusConfig)
	private samples = 0

	override init() {
		this.ctx.logger.info('status plugin starting', {
			intervalMs: this.config.intervalMs,
		})

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

默认值和范围在 schema 中只写一次。runtime、测试和配置 UI 都消费这份 contract。两个文件放在同一个 Twoslash block 中，因此 `StatusPlugin.ts` 的相对 import 也会参与检查。

Plugin authoring 使用四个固定位置：

| 内容                     | 位置                                   |
| ------------------------ | -------------------------------------- |
| identity 和展示 metadata | module-level `@Plugin()` class         |
| config contract          | class-level `this.configs.use()` field |
| 启动、注册和资源 acquire | `init()`                               |
| 长期资源释放             | 当前 Context 的 `effects`              |

constructor 现在为空，所以省略。以后加入“缺少它就不能工作”的 Plugin dependency 时才添加 constructor parameter。

## 第三步：公开 package root

```ts no-twoslash
// src/index.ts
export { StatusConfig } from './config.ts'
export { StatusPlugin } from './StatusPlugin.ts'
```

具体 Plugin 必须能从 package root `"."` 追溯到唯一 named export。不要要求 consumer 从 `dist/`、`src/` 或内部子路径导入 Plugin class。

一个 package 可以导出普通 types、schema 和 helper；但 plugin-bearing root entry 的 identity 必须明确。构建器会把 root export provenance 写入 metadata，class name 和 `displayName` 不承担 identity。

## 第四步：在 host 中启用

测试 host 或固定宿主把 Plugin 加入 catalog、设置 config，然后启用：

```ts no-twoslash
host.add([StatusPlugin])
host.cfg(StatusPlugin).set({
	label: 'healthy',
	intervalMs: 5_000,
})
host.cfg(StatusPlugin).enable()

const summary = await host.commit()
```

`commit()` 计算依赖图、验证 config、启动可运行节点，并返回结构化 lifecycle summary。生产宿主在 [宿主装配](./host-setup.md) 中配置。

## 第五步：写真实 lifecycle test

```ts no-twoslash
// tests/StatusPlugin.test.ts
import { describe, expect, it } from 'vitest'
import { withRuntimeHost } from '@pluxel/runtime/test'
import { StatusPlugin } from '../src/index.ts'

describe('StatusPlugin', () => {
	it('starts with normalized config and mounts HTTP', async () => {
		await withRuntimeHost(async (host) => {
			host.add(StatusPlugin)
			host.cfg(StatusPlugin).set({ label: 'healthy', intervalMs: 1_000 })
			host.cfg(StatusPlugin).enable()

			await host.commit()
			const plugin = host.require(StatusPlugin)
			const response = await host.ctx.http.fetch(
				new Request(`http://local${plugin.ctx.http.plugin.base('/status')}`),
			)

			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ label: 'healthy' })
		})
	})
})
```

`withRuntimeHost()` 在 callback 结束后关闭 host，因此该测试同时覆盖基本 cleanup。完整失败与 replacement 矩阵见 [测试插件](../development/testing.md)。

## 完成标准

在继续加入复杂能力前，确认：

1. `pnpm build` 能生成 Plugin metadata 和 package artifact。
2. `pnpm typecheck`、`pnpm lint`、`pnpm test` 通过。
3. 默认 config 与显式 config 都有测试。
4. remove/replacement 后 timer、route 和其他资源全部失效。
5. package consumer 只从公开 root export 导入 Plugin。

Required/optional dependency、启动失败和 replacement 语义见下一页：[Plugin 模型与生命周期](./plugin-model.md)。
