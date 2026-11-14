import { BasePlugin, Plugin, parsePluginNodeAddress, type PluginNodeAddress } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { createScriptScope } from '@pluxel/host/agent/runtime'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'
import { createProjectSdk } from '../src/project-sdk'

let generation = 0
@Plugin({ forkable: true })
class Counter extends BasePlugin {
	readonly generation = ++generation
	count = 0
}

it('borrows real instances and root without Services and closes cached extension methods with the run', async () => {
	await using host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const sdk = createProjectSdk(host.ctx, scope)
	const select = sdk.plugin
	const counter = select(Counter.nodeAddress())
	expect(counter.address).toEqual(parsePluginNodeAddress(Counter.nodeAddress()))
	const erasedAddress: PluginNodeAddress = Counter.nodeAddress()
	await expect(select(erasedAddress).config.get()).resolves.toMatchObject({
		status: 'error',
		error: { code: 'config_not_found' },
	})
	expect(Object.keys(sdk.dev)).toEqual(['ctx'])
	const { start, status, instance } = counter
	const started = await start()
	started.unwrap()
	const borrowed = await instance()
	const first = borrowed.unwrap()
	const firstGeneration = first.generation
	first.count = 4
	expect(sdk.dev.ctx).toBe(host.ctx)
	await scope.dispose()
	await expect(status()).resolves.toMatchObject({
		status: 'error',
		error: { code: 'scope_closed' },
	})
	await expect(instance()).resolves.toMatchObject({
		status: 'error',
		error: { code: 'scope_closed' },
	})
	expect(() => first.count).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => select(Counter.nodeAddress())).toThrow(
		expect.objectContaining({ code: 'scope_closed' }),
	)
	expect(() => sdk.dev.ctx).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	const next = createScriptScope({ ctx: host.ctx })
	try {
		const nextSdk = createProjectSdk(host.ctx, next)
		const nextCounter = nextSdk.plugin(Counter.nodeAddress())
		const nextBorrowed = await nextCounter.instance()
		const current = nextBorrowed.unwrap()
		expect(current.count).toBe(4)
		expect(current.generation).toBe(firstGeneration)
		const { restart } = nextCounter
		const restarted = await restart()
		restarted.unwrap()
		const replaced = await nextCounter.instance()
		expect(replaced.unwrap().generation).not.toBe(firstGeneration)
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
		expect(await host.forks.ensure(Counter.nodeAddress('east'))).toMatchObject({ ok: true })
		const counter = sdk.plugin(Counter.nodeAddress('east'))
		expect(counter.address).toEqual(parsePluginNodeAddress(Counter.nodeAddress('east')))
		const started = await counter.start()
		started.unwrap()
		const borrowed = await counter.instance()
		expect(borrowed.unwrap()).toBeInstanceOf(Counter)
		const status = await counter.status()
		expect(status.unwrap()).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await scope.dispose()
	}
})

@Plugin()
class Replaceable extends BasePlugin {
	readonly config = this.configs.use({
		'~standard': {
			version: 1 as const,
			vendor: 'project-sdk-test',
			validate: () => ({ value: { count: 2 } }),
		},
	})
}
it('rejects an imported constructor superseded by the actual catalog', async () => {
	await using host = await createHost({ plugins: [Replaceable] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const sdk = createProjectSdk(host.ctx, scope)
		const { start, stop, status, restart, instance } = sdk.plugin(Replaceable.nodeAddress())
		const erasedAddress: PluginNodeAddress = Replaceable.nodeAddress()
		const { get, validate, patch, reset } = sdk.plugin(erasedAddress).config
		const initialConfig = await get()
		expect(initialConfig.unwrap()).toMatchObject({ config: { count: 2 } })
		const started = await start()
		started.unwrap()
		await host.updateCatalog([lowerTestReplacement(Replaceable, class extends Replaceable {})])
		for (const operation of [
			status,
			start,
			stop,
			restart,
			instance,
			get,
			() => validate({ set: { count: 3 } }),
			() => patch({ set: { count: 3 } }),
			reset,
		])
			await expect(operation()).resolves.toMatchObject({
				status: 'error',
				error: { code: 'stale_target' },
			})
		await expect(sdk.plugin(Replaceable.nodeAddress()).instance()).resolves.toMatchObject({
			status: 'error',
			error: { code: 'stale_target' },
		})
		const oldClassAddress: PluginNodeAddress = Replaceable.nodeAddress()
		await expect(sdk.plugin(oldClassAddress).config.get()).resolves.toMatchObject({
			status: 'error',
			error: { code: 'stale_target' },
		})
		const current = await sdk.plugin(parsePluginNodeAddress(Replaceable.nodeAddress())).status()
		expect(current.unwrap()).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await scope.dispose()
	}
})
