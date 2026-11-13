import { BasePlugin, Plugin } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { createScriptScope } from '@pluxel/host/agent'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'
import { createProjectSdk } from '../src/project-sdk'

@Plugin({ forkable: true })
class Counter extends BasePlugin {
	count = 0
}

it('borrows real instances and root without Services and closes cached extension methods with the run', async () => {
	await using host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const sdk = createProjectSdk(host.ctx, scope)
	const address = sdk.dev.address(Counter)
	await sdk.plugins.start(address)
	const first = sdk.dev.instance(Counter)
	first.count = 4
	expect(sdk.dev.ctx).toBe(host.ctx)
	const cached = sdk.dev.instance
	await scope.dispose()
	expect(() => cached(Counter)).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => sdk.dev.ctx).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	const next = createScriptScope({ ctx: host.ctx })
	try {
		const nextSdk = createProjectSdk(host.ctx, next)
		expect(nextSdk.dev.instance(Counter)).toBe(first)
		expect(first.count).toBe(4)
		await nextSdk.plugins.restart(address)
		expect(nextSdk.dev.instance(Counter)).not.toBe(first)
	} finally {
		await next.dispose()
	}
})

it('resolves existing typed forks', async () => {
	await using host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const sdk = createProjectSdk(host.ctx, scope)
		const fork = { plugin: Counter, forkId: 'east' }
		expect(await host.forks.ensure(Counter.nodeAddress('east'))).toMatchObject({ ok: true })
		await sdk.plugins.start(sdk.dev.address(fork))
		expect(sdk.dev.instance(fork)).toBeInstanceOf(Counter)
		expect(() => sdk.dev.instance(Counter.nodeAddress() as never)).toThrow(TypeError)
		expect(await sdk.plugins.status(Counter.nodeAddress('east'))).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await scope.dispose()
	}
})

@Plugin()
class Replaceable extends BasePlugin {}
it('rejects an imported constructor superseded by the actual catalog', async () => {
	await using host = await createHost({ plugins: [Replaceable] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const sdk = createProjectSdk(host.ctx, scope)
		await sdk.plugins.start(sdk.dev.address(Replaceable))
		await host.updateCatalog([lowerTestReplacement(Replaceable, class extends Replaceable {})])
		expect(() => sdk.dev.address(Replaceable)).toThrow(
			expect.objectContaining({ code: 'stale_target' }),
		)
		expect(await sdk.plugins.status(Replaceable.nodeAddress())).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await scope.dispose()
	}
})
