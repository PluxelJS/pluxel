import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { createScriptScope, type Script } from '@pluxel/agent-sdk/host'
import { elysia, ElysiaApp } from '@pluxel/services/elysia'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { Commands, commands } from '@pluxel/services/commands'
import { Result } from '@pluxel/commands'
import { expect, it, vi } from 'vitest'

@Plugin()
class Health extends BasePlugin {
	init() {
		this.ctx.service(ElysiaApp).get('/health', () => ({ ok: true }))
	}
}

it('uses installed service declarations through the portable SDK', async () => {
	const host = await createHost({ plugins: [Health], services: [elysia(), commands()] })
	const controller = new AbortController()
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	try {
		await scope.sdk.plugin(Health.nodeAddress()).start()
		const script: Script = async (sdk, run) => {
			const server = sdk.ctx.service(ElysiaRuntime)
			const response = await server.fetch(
				new Request('http://local.dev/health', { signal: run.signal }),
			)
			return {
				status: response.status,
				body: await response.json(),
				commands: sdk.ctx.service(Commands).list(),
			}
		}
		expect(
			await script(scope.sdk, { id: 'test', input: undefined, signal: controller.signal }),
		).toEqual({ status: 200, body: { ok: true }, commands: [] })
		// @ts-expect-error Root Context cannot access owner-only HTTP routes.
		expect(() => scope.sdk.ctx.service(ElysiaApp)).toThrow(
			expect.objectContaining({ code: 'CONTEXT_SERVICE_ACCESS_DENIED' }),
		)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('passes run cancellation explicitly to a borrowed service', async () => {
	const host = await createHost({ plugins: [], services: [commands()] })
	const controller = new AbortController()
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx, signal: controller.signal })
	const entered = Promise.withResolvers<AbortSignal>()
	vi.spyOn(host.ctx.service(Commands), 'execute').mockImplementation(
		(_name, _input, context) =>
			new Promise((resolve) => {
				const signal = context!.signal!
				entered.resolve(signal)
				signal.addEventListener('abort', () => resolve(Result.ok('aborted')), { once: true })
			}),
	)
	try {
		const script: Script = (sdk, run) =>
			sdk.ctx.service(Commands).execute('pending', {}, { signal: run.signal })
		const pending = script(scope.sdk, { id: 'test', input: undefined, signal: controller.signal })
		expect(await entered.promise).toBe(controller.signal)
		controller.abort()
		expect(await pending).toEqual(Result.ok('aborted'))
	} finally {
		await scope.dispose()
		await host.close()
	}
})
