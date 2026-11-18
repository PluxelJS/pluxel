import { BasePlugin, Plugin, formatPluginNodeReference, parsePluginNodeAddress } from '@pluxel/core'
import {
	createPluginNodeAddressEvidence,
	DetachedPluginNodeAddressError,
	readPluginNodeAddressEvidence,
} from '@pluxel/core/internal/plugin-address-evidence'
import { requirePluginService } from '@pluxel/core/internal'
import { expect, it } from 'vitest'
import { createCoreTestHost } from '../src/internal-test'

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
	expect(AddressOwner.address()).toBe(defaultNode.definition)
	expect(fork.definition).toBe(defaultNode.definition)
	expect(AddressToken.address().exportName).toBe('AddressToken')
	expect(AddressToken.address()).toBe(AddressToken.address())
	expect(Object.isFrozen(AddressToken.address())).toBe(true)
	expect(AddressOwner.nodeAddress()).toBe(defaultNode)
	expect(parsePluginNodeAddress(fork)).toEqual({
		definition: defaultNode.definition,
		variant: 'fork',
		forkId: 'east',
	})
	expect(Object.isFrozen(fork)).toBe(true)
	expect(formatPluginNodeReference(fork)).toContain('east')
	await using host = createCoreTestHost()
	const instance = await host.add(AddressOwner.nodeAddress())
	expect(instance.ctx.pluginInfo.nodeAddress).toEqual(parsePluginNodeAddress(defaultNode))
	const forkInstance = await host.add(AddressOwner.nodeAddress('east'))
	expect(forkInstance.ctx.pluginInfo.nodeAddress).toEqual(parsePluginNodeAddress(fork))
	const runtime = requirePluginService(instance.ctx)
	const adjacency = runtime.readCommittedDependencyAdjacency()
	expect(adjacency.nodes).toHaveLength(2)
	expect(runtime.nodeAddressOf(runtime.resolvePluginNode(defaultNode)!)).toBe(
		instance.ctx.pluginInfo.nodeAddress,
	)
	expect(runtime.nodeAddressOf(runtime.resolvePluginNode(fork)!)).toBe(
		forkInstance.ctx.pluginInfo.nodeAddress,
	)
	for (const node of [
		instance.ctx.pluginInfo.nodeAddress,
		forkInstance.ctx.pluginInfo.nodeAddress,
		...adjacency.nodes,
	]) {
		expect(Object.getOwnPropertySymbols(node)).toHaveLength(0)
		expect(readPluginNodeAddressEvidence(node)).toBeUndefined()
	}
	expect(constructions).toBe(2)
})

it('rejects abstract, unlowered, inherited and malformed identities without constructing', () => {
	class Unlowered extends BasePlugin {}
	class UnloweredChild extends AddressOwner {}
	expect(() => AddressToken.nodeAddress()).toThrow('Abstract Plugin tokens')
	expect(() => Unlowered.nodeAddress()).toThrow('was not lowered')
	expect(() => UnloweredChild.nodeAddress()).toThrow('was not lowered')
	expect(() => Unlowered.address()).toThrow('was not lowered')
	expect(() => UnloweredChild.address()).toThrow('was not lowered')
	for (const forkId of ['', 'bad/id', 'a'.repeat(65)])
		expect(() => AddressOwner.nodeAddress(forkId)).toThrow('fork id')
})

it('binds implementation evidence to exact frozen address values without changing identity', () => {
	for (const node of [AddressOwner.nodeAddress(), AddressOwner.nodeAddress('east')]) {
		expect(readPluginNodeAddressEvidence(node)).toEqual({
			kind: 'constructor',
			implementation: AddressOwner,
		})
		const pure = parsePluginNodeAddress(node)
		expect(pure).toEqual(JSON.parse(JSON.stringify(node)))
		expect(Object.getOwnPropertySymbols(pure)).toHaveLength(0)
		expect(readPluginNodeAddressEvidence(pure)).toBeUndefined()
		expect(readPluginNodeAddressEvidence(JSON.parse(JSON.stringify(node)))).toBeUndefined()
		expect(() => readPluginNodeAddressEvidence({ ...node })).toThrow('copied or detached')
		expect(() => readPluginNodeAddressEvidence(Object.assign({}, node))).toThrow(
			'copied or detached',
		)
		expect(Object.isFrozen(node)).toBe(true)
		expect(Object.isFrozen(node.definition)).toBe(true)
		expect(Object.isFrozen(node.definition.entry)).toBe(true)
		const first = Object.freeze({ revision: 1 })
		const second = Object.freeze({ revision: 2 })
		const a = createPluginNodeAddressEvidence(pure, first)
		const b = createPluginNodeAddressEvidence(a, second)
		expect(a).not.toBe(b)
		expect(formatPluginNodeReference(a)).toBe(formatPluginNodeReference(b))
		expect(readPluginNodeAddressEvidence(a)).toBe(first)
		expect(readPluginNodeAddressEvidence(b)).toBe(second)
		expect(readPluginNodeAddressEvidence(pure)).toBeUndefined()
	}
})

it('rejects foreign runtime evidence without treating the address as a dynamic target', () => {
	const foreignAddress = Object.freeze({
		...parsePluginNodeAddress(AddressOwner.nodeAddress()),
		[Symbol.for('@pluxel/core/plugin-node-address-evidence')]: Object.freeze({}),
	})
	expect(() => readPluginNodeAddressEvidence(foreignAddress)).toThrow(
		DetachedPluginNodeAddressError,
	)
	expect(readPluginNodeAddressEvidence(parsePluginNodeAddress(foreignAddress))).toBeUndefined()
})
