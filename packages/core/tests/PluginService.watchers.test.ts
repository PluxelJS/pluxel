import { BasePlugin, Plugin, createCoreInternalTestHost } from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'

@Plugin({ forkable: true })
class ObservedPlugin extends BasePlugin {}

it('watches an absent fork through first admission, restart, and removal', async () => {
	await using host = createCoreInternalTestHost()
	const address = ObservedPlugin.nodeAddress('east')
	const seen: Array<BasePlugin | undefined> = []
	host.ctx.effects.defer(
		host.pluginService.watchInstance(address, (instance) => seen.push(instance)),
	)

	const east = host.fork(ObservedPlugin, 'east')
	await host.commit()
	const first = host.require(east)
	host.restart(east)
	await host.commit()
	const second = host.require(east)
	host.remove(east)
	await host.commit()

	expect(second).not.toBe(first)
	expect(seen).toEqual([undefined, first, second, undefined])
})
