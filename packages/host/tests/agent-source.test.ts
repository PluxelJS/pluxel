import { BasePlugin, Plugin, parsePluginNodeAddress, type PluginNodeAddress } from '@pluxel/core'
import { createHost } from '../src/index'
import { createScriptScope } from '../src/agent-runtime'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'

let generation = 0
@Plugin({ forkable: true })
class Counter extends BasePlugin {
	readonly generation = ++generation
	count = 0
}

it('borrows the same root and closes its admission with the shared script scope', async () => {
	await using host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const sdk = scope.sdk
	const select = sdk.plugin
	const counter = select(Counter.nodeAddress())
	expect(counter.address).toBe(Counter.nodeAddress())
	const erasedAddress: PluginNodeAddress = Counter.nodeAddress()
	await expect(select(erasedAddress).config.get()).rejects.toMatchObject({
		details: { code: 'config_not_found' },
	})
	expect(sdk.ctx.logging).toBeUndefined()
	const { start, status, instance } = counter
	await start()
	const borrowed = await instance()
	const first = borrowed.instance
	const firstGeneration = first.generation
	first.count = 4
	expect(sdk.ctx).toBe(sdk.ctx)
	expect(Reflect.ownKeys(sdk.ctx)).toContain('logger')
	await scope.dispose()
	await expect(status()).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
	await expect(instance()).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
	expect(() => first.count).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => select(Counter.nodeAddress())).toThrow(
		expect.objectContaining({ code: 'scope_closed' }),
	)
	expect(() => sdk.ctx).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	const next = createScriptScope({ ctx: host.ctx })
	try {
		const nextSdk = next.sdk
		const nextCounter = nextSdk.plugin(counter.address)
		const nextBorrowed = await nextCounter.instance()
		const current = nextBorrowed.instance
		expect(current.count).toBe(4)
		expect(current.generation).toBe(firstGeneration)
		const { restart } = nextCounter
		await restart()
		const replaced = await nextCounter.instance()
		expect(replaced.instance.generation).not.toBe(firstGeneration)
	} finally {
		await next.dispose()
	}
})

it('resolves existing typed forks', async () => {
	await using host = await createHost({ plugins: [Counter] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const sdk = scope.sdk
		expect(await host.forks.ensure(Counter.nodeAddress('east'))).toMatchObject({ ok: true })
		const counter = sdk.plugin(Counter.nodeAddress('east'))
		expect(parsePluginNodeAddress(counter.address)).toEqual(
			parsePluginNodeAddress(Counter.nodeAddress('east')),
		)
		await counter.start()
		const borrowed = await counter.instance()
		expect(borrowed.instance).toBeInstanceOf(Counter)
		const status = await counter.status()
		expect(status).toMatchObject({
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
			vendor: 'agent-source-test',
			validate: () => ({ value: { count: 2 } }),
		},
	})
}
it('rejects an imported constructor superseded by the actual catalog', async () => {
	await using host = await createHost({ plugins: [Replaceable] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	try {
		const sdk = scope.sdk
		const selected = sdk.plugin(Replaceable.nodeAddress())
		const { start, stop, status, restart, instance } = selected
		const reselected = sdk.plugin(selected.address)
		const { get, validate, patch, reset } = selected.config
		const initialConfig = await get()
		expect(initialConfig).toMatchObject({ config: { count: 2 } })
		await start()
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
			reselected.instance,
			reselected.config.get,
			() => reselected.config.patch({ set: { count: 3 } }),
		])
			await expect(operation()).rejects.toMatchObject({
				details: { code: 'stale_target' },
			})
		await expect(sdk.plugin(Replaceable.nodeAddress()).instance()).rejects.toMatchObject({
			details: { code: 'stale_target' },
		})
		const oldClassAddress: PluginNodeAddress = Replaceable.nodeAddress()
		await expect(sdk.plugin(oldClassAddress).config.get()).rejects.toMatchObject({
			details: { code: 'stale_target' },
		})
		const current = await sdk.plugin(parsePluginNodeAddress(Replaceable.nodeAddress())).status()
		expect(current).toMatchObject({
			lifecycleState: 'running',
		})
	} finally {
		await scope.dispose()
	}
})
