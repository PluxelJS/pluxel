import { BasePlugin, Plugin, formatPluginNodeReference } from '@pluxel/core'
import { expect, it } from 'vitest'
import { createCoreTestHost, definePluginFork } from '../src/internal-test'

let constructions = 0
abstract class AddressToken extends BasePlugin {}

@Plugin(AddressToken, { forkable: true })
class AddressOwner extends AddressToken {
	constructor() {
		super()
		constructions++
	}
}

it('projects lowered default and fork addresses before any instance exists', async () => {
	const defaultNode = AddressOwner.nodeAddress()
	const fork = AddressOwner.nodeAddress('east')
	expect(constructions).toBe(0)
	expect(AddressOwner.nodeAddress()).toBe(defaultNode)
	expect(fork).toEqual({ definition: defaultNode.definition, variant: 'fork', forkId: 'east' })
	expect(Object.isFrozen(fork)).toBe(true)
	expect(formatPluginNodeReference(fork)).toContain('east')
	await using host = createCoreTestHost()
	const instance = await host.add(AddressOwner)
	expect(instance.ctx.pluginInfo.nodeAddress).toEqual(defaultNode)
	const forkInstance = await host.add(definePluginFork(AddressOwner, 'east'))
	expect(forkInstance.ctx.pluginInfo.nodeAddress).toEqual(fork)
	expect(constructions).toBe(2)
})

it('rejects abstract, unlowered, inherited and malformed identities without constructing', () => {
	class Unlowered extends BasePlugin {}
	class UnloweredChild extends AddressOwner {}
	expect(() => AddressToken.nodeAddress()).toThrow('Abstract Plugin tokens')
	expect(() => Unlowered.nodeAddress()).toThrow('was not lowered')
	expect(() => UnloweredChild.nodeAddress()).toThrow('was not lowered')
	for (const forkId of ['', 'bad/id', 'a'.repeat(65)])
		expect(() => AddressOwner.nodeAddress(forkId)).toThrow('fork id')
})
