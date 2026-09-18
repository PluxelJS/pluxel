import { BasePlugin, Plugin } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import { createHost } from '@pluxel/host'
import type { DevScript } from '@pluxel/host-dev/console'
import { createDevConsoleScope } from '@pluxel/host-dev/internal/dev/console'
import { http, Http, HttpServer } from '@pluxel/services/http'
import { Commands, commands } from '@pluxel/services/commands'
import { expect, it, vi } from 'vitest'

@Plugin()
class Health extends BasePlugin {
	init() {
		this.ctx.require(Http).get('/health', () => ({ ok: true }))
	}
}

it('lets a script import installed service tokens and use its borrowed root directly', async () => {
	const host = await createHost({ plugins: [Health], services: [http(), commands()] })
	const controller = new AbortController()
	await host.start()
	const scope = createDevConsoleScope({ ctx: host.ctx, signal: controller.signal })
	try {
		await scope.dev.plugins.start(Health)
		const script: DevScript = async (dev, run) => {
			const server = resolveContextCapability(dev.ctx, HttpServer)
			const response = await server.fetch(
				new Request('http://local.dev/health', { signal: run.signal }),
			)
			return {
				status: response.status,
				body: await response.json(),
				commands: dev.ctx.require(Commands).list(),
			}
		}
		expect(
			await script(scope.dev, { id: 'services', input: undefined, signal: controller.signal }),
		).toEqual({ status: 200, body: { ok: true }, commands: [] })
		expect(() => scope.dev.ctx.require(Http)).toThrow(
			expect.objectContaining({ code: 'CONTEXT_CAPABILITY_ACCESS_DENIED' }),
		)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('passes run cancellation explicitly to a service without a console proxy', async () => {
	const host = await createHost({ plugins: [], services: [commands()] })
	const controller = new AbortController()
	await host.start()
	const scope = createDevConsoleScope({ ctx: host.ctx, signal: controller.signal })
	const entered = Promise.withResolvers<AbortSignal>()
	vi.spyOn(host.ctx.require(Commands), 'execute').mockImplementation(
		(_name, _input, context) =>
			new Promise((resolve) => {
				const signal = context!.signal!
				entered.resolve(signal)
				signal.addEventListener('abort', () => resolve('aborted'), { once: true })
			}),
	)
	try {
		const script: DevScript = (dev, run) =>
			dev.ctx.require(Commands).execute('pending', {}, { signal: run.signal })
		const pending = script(scope.dev, { id: 'cancel', input: undefined, signal: controller.signal })
		expect(await entered.promise).toBe(controller.signal)
		controller.abort()
		expect(await pending).toBe('aborted')
	} finally {
		await scope.dispose()
		await host.close()
	}
})
