import { BasePlugin, Plugin } from '@pluxel/core'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { expect, it } from 'vitest'
import { createHost } from '../src/index'

@Plugin()
class Counter extends BasePlugin {
	static readonly events: string[] = []
	version = 'original'

	init() {
		const version = this.version
		Counter.events.push(`start ${version}`)
		return () => {
			Counter.events.push(`stop ${version}`)
		}
	}
}

it('keeps session intent across catalog updates and starts the newly published implementation', async () => {
	const address = Counter.nodeAddress()
	Counter.events.length = 0
	await using host = await createHost({
		plugins: [{ plugin: Counter }],
		policy: { document: false },
	})
	await host.start()
	await host.setAutoStart(address, true)
	const afterPolicy = await host.status()
	expect(afterPolicy.statuses).toMatchObject([
		{ address, autoStart: true, lifecycleState: 'stopped' },
	])
	expect(Counter.events).toEqual([])

	await host.startNode(address)
	const selection = [Counter]
	const refreshing = host.updateCatalog(selection)
	selection.length = 0
	await refreshing
	expect(Counter.events).toEqual(['start original'])

	await host.stopNode(address)
	const Replacement = lowerTestReplacement(
		Counter,
		class extends Counter {
			override version = 'replacement'
		},
	)
	await host.updateCatalog([Replacement])
	const afterReplacement = await host.status()
	expect(afterReplacement.statuses).toMatchObject([
		{ address, autoStart: true, lifecycleState: 'stopped' },
	])
	expect(Counter.events).toEqual(['start original', 'stop original'])

	await host.startNode(address)
	await host.close()
	expect(Counter.events).toEqual([
		'start original',
		'stop original',
		'start replacement',
		'stop replacement',
	])
})

it('rejects an identity in place of a constructor or an unknown Host option before preparing services', async () => {
	const services = [
		{
			name: 'probe',
			provides: [] as const,
			prepare: () => {
				throw new Error('prepared')
			},
		},
	]
	await expect(
		createHost({ plugins: [{ plugin: Counter.nodeAddress() }], services } as never),
	).rejects.toThrow('plugins[0].plugin must be a Plugin constructor')
	await expect(createHost({ plugins: [], service: [], services } as never)).rejects.toThrow(
		'unsupported "service"',
	)
})
