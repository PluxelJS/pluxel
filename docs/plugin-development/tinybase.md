---
title: 插件状态（TinyBase）
description: 使用内建 Store 保存插件状态，为需要跨重启恢复的数据选择持久后端。
---

每个插件节点可以通过 `ctx.tinybase` 打开自己的 TinyBase Store。Core 把 Store 的 Tables 和 Values 写成 JSON 快照，交给 Host 文档存储保存，无需安装 SQL 驱动。Node 和浏览器的直接启动入口默认把快照存在内存里。Cloudflare Worker 的快照可供同一个根上的后续请求读取，根被替换或 isolate 被回收时就会丢失。业务需要跨重启恢复时，在打开 Store 时指定 `durable: true`。 [Host 存储](../host/configuration.md#选择文件后端)

随版本交付的只读字典和模板可以直接导入。部署配置使用 `configs.use()`，部署凭据由 Vault 提供。 [发布前确定哪些输入](../host/runtime-portability.md#发布前确定哪些输入)

## 打开并使用原生 Store

下面的插件在同一个 Host 根上保存主题选择，允许使用会话存储。它把自己创建的 Store 交给 Core，因此插件的 `peerDependencies.tinybase` 和 `devDependencies.tinybase` 都要指向已安装 `@pluxel/core` 清单中 `pluxel.tinybase` 指定的精确版本。可以使用指向该版本的 pnpm catalog。Host 会核对插件实际解析到的版本，再共享同一份 TinyBase。

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
		this.store = await this.state.open(createStore().setValues({ theme: 'system' }))
		v.parse(Preference, this.store.getValues())
	}

	getTheme() {
		return v.parse(Preference, this.store.getValues()).theme
	}

	async setTheme(input: unknown): Promise<void> {
		const preference = v.parse(Preference, input)
		this.store.setValue('theme', preference.theme)

		await this.state.flush()
	}
}
```

`open(store)` 先读取该节点的快照。没有快照时使用传入 Store 的初值，已有快照时恢复完整内容，包括用户保存的空 Store。发布新版时修改初值，只会影响还没有快照的节点。

如果用户下次打开应用时仍应看到已保存的主题，把示例中的打开操作换成下面这一行。

```ts
this.store = await this.state.open({
	durable: true,
	store: createStore().setValues({ theme: 'system' }),
})
```

宿主须为快照目录挂载可写的持久存储，并在 `coreConfig.zenfs.durableMounts` 声明对应挂载点。会话后端或持久性未知时，`open({ durable: true })` 抛出错误码为 `DURABILITY_UNAVAILABLE` 的 `TinyBaseError`。在 `init()` 中等待它，部署方就能在插件启动时发现配置缺失。

### 自动保存与写入确认

Store 修改后，框架会安排快照写入。在向调用方确认保存前，用 `await this.state.flush()` 等待当前后端完成写入。内存后端也可以成功完成这一步。要验证跨重启恢复，请在同一介质上关闭并重新打开 Host，再读取上次保存的值。

## 在内存宿主中验证读写

下面的测试使用示例中的会话存储，检查同一插件实例上的修改和读取。

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { PreferencesPlugin } from './preferences'
import { expect, it } from 'vitest'

it('能够保存并读取偏好状态', async () => {
	await using host = await createTestHost()
	const preferences = await host.start(PreferencesPlugin.nodeAddress())

	expect(preferences.getTheme()).toBe('system')

	await preferences.setTheme({ theme: 'dark' })
	expect(preferences.getTheme()).toBe('dark')
})
```
