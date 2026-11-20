---
title: 受管出站 HTTP
description: 通过内建的 ctx.wretch 和 ctx.fetch 请求外部 HTTP 服务。
---

每个运行中的插件可以直接使用 `this.ctx.wretch` 发起请求。它是绑定到当前插件运行代的原生 Wretch 客户端，支持上游的不可变派生、addon、middleware 和失败处理。需要标准 `Response`、流式响应或向其他 SDK 注入传输时，使用签名与 Fetch 一致的 `this.ctx.fetch`。 [Wretch 文档](https://elbywan.github.io/wretch/)

## 发起请求

```ts twoslash
import { BasePlugin, Plugin } from '@pluxel/core'
import * as v from 'valibot'

const Profile = v.object({ id: v.string(), name: v.string() })

@Plugin()
export class ProfilePlugin extends BasePlugin {
	load(url: URL, signal?: AbortSignal) {
		return this.ctx.wretch
			.options({ signal })
			.get(url.href)
			.json((body) => v.parse(Profile, body))
	}
}
```

插件负责目标 API 的认证、响应校验及重试。可以从 Vault 读取业务凭据，再通过 Wretch 的 `.auth()` 或 `.headers()` 设置认证头。请求显式设置的 `User-Agent`、`Accept` 等头优先，受管传输只补缺失的默认值。用 `ctx.wretch` 派生重试时，每次传输尝试单独经过宿主策略。需要恢复业务上的 404 时，可以在原生 `.notFound()` 中返回领域 Result。 [Vault](./vault.md) · [可恢复失败示例](./better-result.md#官方插件示例)

## 借用标准 Fetch

下面的插件方法处理 HTTP 状态，并消费或取消响应体。

```ts no-twoslash
async download(url: URL, signal?: AbortSignal): Promise<ArrayBuffer> {
	const response = await this.ctx.fetch(url, { signal })
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error(`Download failed with HTTP ${response.status}`)
	}
	return response.arrayBuffer()
}
```

两种入口接收绝对 HTTP(S) URL，共用宿主的代理和出站限制。插件停止或替换后，缓存的客户端失效，排队中的请求会取消，传输中的请求收到取消信号。宿主启用 origin 限制时，字符串或 URL 请求省略 `redirect` 会采用 `error`。已有的 `Request` 也可通过 `init.redirect` 明确选择 `error` 或 `manual`。每次手动请求下一跳都要重新通过策略。 [宿主出站配置](../host/configuration.md#受管出站-http)

## 在测试中替换传输

通过 `coreConfig.http.fetch` 给测试宿主注入替身。下面的测试使用上面的 `ProfilePlugin`，经真实插件 Context 发起请求。

```ts no-twoslash
import { createTestHost } from '@pluxel/test'
import { expect, it } from 'vitest'
import { ProfilePlugin } from './profile-plugin'

it('decodes a profile through managed Fetch', async () => {
	await using host = await createTestHost({
		coreConfig: {
			http: {
				fetch: async () => Response.json({ id: 'alice', name: 'Alice' }),
			},
		},
	})

	const plugin = await host.start(ProfilePlugin.nodeAddress())
	await expect(plugin.load(new URL('https://api.example.test/profile'))).resolves.toEqual({
		id: 'alice',
		name: 'Alice',
	})
})
```

替身位于策略判定之后，测试能验证真实的出站限制，且无需启动 HTTP 监听器。 [创建测试宿主](./testing.md)
