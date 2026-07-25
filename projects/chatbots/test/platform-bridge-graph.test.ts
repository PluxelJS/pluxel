import { afterEach, describe, expect, it } from 'vitest'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { createRuntimeHost, setParamTokens, type RuntimeHost } from '@pluxel/runtime/test'
import type { Wretch } from '@pluxel/wretch'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { KookPlugin } from '@repo/chatbots-kook'
import { KookHubBridgePlugin } from '@repo/chatbots-kook-hub-bridge'
import { TelegramPlugin } from '@repo/chatbots-telegram'
import { TelegramHubBridgePlugin } from '@repo/chatbots-telegram-hub-bridge'

setParamTokens(TelegramHubBridgePlugin, [TelegramPlugin, ChatHubPlugin])
setParamTokens(KookHubBridgePlugin, [KookPlugin, ChatHubPlugin])
@Plugin({ name: 'ChatbotsTestHttpPlugin' })
class TestHttpPlugin extends BasePlugin {
	readonly client = {} as Wretch
}

setParamTokens(TelegramPlugin, [TestHttpPlugin])
setParamTokens(KookPlugin, [TestHttpPlugin])

let host: RuntimeHost | undefined

afterEach(async () => {
	await host?.dispose()
	host = undefined
})

describe('platform bridge plugin graph', () => {
	it.each([TelegramPlugin, KookPlugin])(
		'%s starts with only its HTTP capability',
		async (Platform) => {
			host = createRuntimeHost({ workbench: false })
			host.add([TestHttpPlugin, Platform])
			await host.commit()

			expect(host.isRunning(TestHttpPlugin)).toBe(true)
			expect(host.isRunning(Platform)).toBe(true)
			expect(host.has(ChatHubPlugin)).toBe(false)
		},
	)

	it.each([
		[TelegramPlugin, TelegramHubBridgePlugin],
		[KookPlugin, KookHubBridgePlugin],
	] as const)(
		'keeps %s running when its optional bridge and Hub are removed',
		async (Platform, Bridge) => {
			host = createRuntimeHost({ workbench: false })
			host.add([TestHttpPlugin, ChatHubPlugin, Platform, Bridge])
			const started = await host.commitAllowFail()
			expect(started.lifecycleReport.issues).toEqual([])

			expect(host.isRunning(Platform)).toBe(true)
			expect(host.isRunning(Bridge)).toBe(true)
			expect(host.isRunning(ChatHubPlugin)).toBe(true)
			const bridgeLifetime = (host.require(Bridge) as unknown as { lifetime: AbortController })
				.lifetime
			expect(bridgeLifetime.signal.aborted).toBe(false)

			host.remove(Bridge)
			await host.commit()
			expect(host.isRunning(Platform)).toBe(true)
			expect(host.has(Bridge)).toBe(false)
			expect(bridgeLifetime.signal.aborted).toBe(true)

			host.remove(ChatHubPlugin)
			await host.commit()
			expect(host.isRunning(Platform)).toBe(true)
			expect(host.has(ChatHubPlugin)).toBe(false)
		},
	)
})
