---
title: 插件持久化状态（TinyBase）
description: 使用内建的 TinyBase Store 保存用户偏好与轻量业务记录，支持自动快照与跨重启恢复。
---

对于用户偏好设置、开关标记或轻量业务记录，Pluxel 内置了对 [TinyBase](https://tinybase.org/) 响应式内存数据存储的支持。每个插件节点拥有专属的 Store，修改会自动由宿主生成快照并持久化到文件后端。

> [!TIP]
> **状态选型建议**
>
> - **应用静态/环境配置**：使用 [`this.configs.use()`](./configuration.md)；
> - **私密密钥与密码**：使用 [Vault 凭据服务](./vault.md)；
> - **用户轻量状态与偏好**：使用本文介绍的 `ctx.tinybase`；
> - **大型关系型数据与高频事务**：使用 [SQL 数据库服务](./database.md)。

## 打开并使用原生 Store

在插件的 `init()` 阶段，通过 `this.ctx.tinybase.open()` 打开托管的 Store：

```ts twoslash
// @filename: preferences.ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { createStore, type Store } from 'tinybase'
import * as v from 'valibot'

const Preference = v.object({ theme: v.picklist(['system', 'light', 'dark']) })

@Plugin({ displayName: 'Preferences' })
export class PreferencesPlugin extends BasePlugin {
	private readonly state = this.ctx.tinybase
	private store!: Store

	protected override async init(): Promise<void> {
		// 1. 打开或创建 Store，并提供初始值快照
		this.store = await this.state.open(createStore().setValues({ theme: 'system' }))
		v.parse(Preference, this.store.getValues())
	}

	getTheme() {
		return v.parse(Preference, this.store.getValues()).theme
	}

	async setTheme(input: unknown): Promise<void> {
		const preference = v.parse(Preference, input)
		this.store.setValue('theme', preference.theme)

		// 2. 显式等待持久化刷新确认
		await this.state.flush()
	}
}
```

### 自动持久化与快照刷新

- **自动持久化**：宿主会在插件更新数据后自动生成快照并安排写入，在插件卸载时会确保所有在途数据安全排空（Drain）。
- **显式确认（`flush`）**：在对外提供的方法中，如果需要等待数据真正落盘并返回调用回执，可以 `await this.state.flush()`。

## 单元测试中的状态验证

使用 `@pluxel/test` 可以在隔离的内存环境中测试状态读写与持久化：

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { PreferencesPlugin } from './preferences'
import { expect, it } from 'vitest'

it('能够保存并读取偏好状态', async () => {
	await using host = await createTestHost()
	const preferences = await host.start(PreferencesPlugin)

	expect(preferences.getTheme()).toBe('system')

	await preferences.setTheme({ theme: 'dark' })
	expect(preferences.getTheme()).toBe('dark')
})
```
