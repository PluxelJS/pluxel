import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { createScriptScope, type Script } from '@pluxel/host/agent'
import { elysia, ElysiaApp } from '@pluxel/services/elysia'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { Commands, commands } from '@pluxel/services/commands'
import { Result } from '@pluxel/commands'
import { expect, it, vi } from 'vitest'

@Plugin()
class Health extends BasePlugin {
	init() {
		this.ctx.require(ElysiaApp).get('/health', () => ({ ok: true }))
	}
}

it('uses installed service tokens alongside the portable SDK without a console proxy', async () => {
	const host = await createHost({ plugins: [Health], services: [elysia(), commands()] })
	const controller = new AbortController()
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	try {
		const started = await scope.sdk.plugin(Health.nodeAddress()).start()
		expect(started.isOk()).toBe(true)
		const script: Script = async (_sdk, run) => {
			const server = host.ctx.require(ElysiaRuntime)
			const response = await server.fetch(
				new Request('http://local.dev/health', { signal: run.signal }),
			)
			return {
				status: response.status,
				body: await response.json(),
				commands: host.ctx.require(Commands).list(),
			}
		}
		expect(
			await script(scope.sdk, { id: 'test', input: undefined, signal: controller.signal }),
		).toEqual({ status: 200, body: { ok: true }, commands: [] })
		// @ts-expect-error Root Context cannot access owner-only HTTP routes.
		expect(() => host.ctx.require(ElysiaApp)).toThrow(
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
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	const entered = Promise.withResolvers<AbortSignal>()
	vi.spyOn(host.ctx.require(Commands), 'execute').mockImplementation(
		(_name, _input, context) =>
			new Promise((resolve) => {
				const signal = context!.signal!
				entered.resolve(signal)
				signal.addEventListener('abort', () => resolve(Result.ok('aborted')), { once: true })
			}),
	)
	try {
		const script: Script = (_sdk, run) =>
			host.ctx.require(Commands).execute('pending', {}, { signal: run.signal })
		const pending = script(scope.sdk, { id: 'test', input: undefined, signal: controller.signal })
		expect(await entered.promise).toBe(controller.signal)
		controller.abort()
		expect(await pending).toEqual(Result.ok('aborted'))
	} finally {
		await scope.dispose()
		await host.close()
	}
})
