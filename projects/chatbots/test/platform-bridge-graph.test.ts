import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeHost, setParamTokens, type RuntimeHost } from '@pluxel/runtime/test'
import { ChatHubPlugin } from '@repo/chatbots-hub'
import { KookPlugin } from '@repo/chatbots-kook'
import { KookHubBridgePlugin } from '@repo/chatbots-kook-hub'
import { TelegramPlugin } from '@repo/chatbots-telegram'
import { TelegramHubBridgePlugin } from '@repo/chatbots-telegram-hub'

setParamTokens(TelegramHubBridgePlugin, [TelegramPlugin, ChatHubPlugin])
setParamTokens(KookHubBridgePlugin, [KookPlugin, ChatHubPlugin])

let host: RuntimeHost | undefined

afterEach(async () => {
	await host?.dispose()
	host = undefined
})

describe('platform bridge plugin graph', () => {
	it.each([
		[TelegramPlugin, TelegramHubBridgePlugin],
		[KookPlugin, KookHubBridgePlugin],
	] as const)(
		'keeps %s running when its optional bridge and Hub are removed',
		async (Platform, Bridge) => {
			host = createRuntimeHost()
			host.add([ChatHubPlugin, Platform, Bridge])
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
