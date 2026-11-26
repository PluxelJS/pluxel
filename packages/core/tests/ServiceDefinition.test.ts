import { expect, it } from 'vitest'
import { createContextHost, installScopeService, ContextServiceMissingError } from '@pluxel/context'
import { getServiceDefinitionKey } from '@pluxel/context/internal'
import {
	__defineServiceDefinition,
	__defineServiceRef,
	createServiceReference,
	defineServiceRef,
	readServiceDefinition,
	setServiceControlContract,
} from '../src/services/definition'
import {
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '../src/plugins/runtime/identity'

const definition: PluginDefinitionAddress = {
	entry: {
		kind: 'source-entry',
		sourceSpace: 'package',
		path: '@pluxel/core/tests/ServiceDefinition.test.ts',
	},
	exportName: 'Clock',
}
const contract = `sha256:${'a'.repeat(64)}`

export abstract class Clock {
	abstract now(): number
}

it('binds native declarations and generated required/optional references to one canonical service', () => {
	const lowered = __defineServiceDefinition(Clock, { format: 1, definition })
	expect(lowered).toBe(Clock)
	setServiceControlContract(Clock, contract)
	const required = createServiceReference<Clock, 'all'>({ definition, access: 'all', contract })
	const optional = __defineServiceRef<Clock>({ format: 1, definition, contract })
	const host = createContextHost({
		name: 'service-control',
		services: [installScopeService(Clock, { create: () => ({ now: () => 42 }) })],
	})
	const owner = host.createScope(host.createRoot(), 'owner')
	expect(owner.service(required)).toBe(owner.service(Clock))
	expect(owner.service(optional)).toBe(owner.service(Clock))
	expect(getServiceDefinitionKey(Clock)).toBe(pluginDefinitionIndexKey(definition))
	expect(readServiceDefinition(Clock)).toEqual({
		definition,
		access: 'all',
		contract,
		optional: false,
	})
	expect(readServiceDefinition(required)).toEqual(readServiceDefinition(Clock))
	expect(readServiceDefinition(optional)).toEqual({
		definition,
		access: 'all',
		contract,
		optional: true,
	})
	expect(Object.isFrozen(readServiceDefinition(Clock).definition)).toBe(true)
	const empty = createContextHost({ name: 'empty', services: [] }).createRoot()
	expect(() => empty.service(required)).toThrow(ContextServiceMissingError)
	expect(empty.service(optional)).toBeUndefined()
})

it('requires compiler evidence and rejects conflicting identities or invalid control contracts', () => {
	abstract class OwnerClock {
		static readonly access = 'owner'
		abstract now(): number
	}
	expect(() => defineServiceRef<OwnerClock>()).toThrow('was not lowered')
	expect(readServiceDefinition(OwnerClock)).toEqual({ access: 'owner', optional: false })
	expect(() => setServiceControlContract(OwnerClock, contract)).toThrow(
		'unlowered service declaration',
	)
	expect(() => __defineServiceDefinition(OwnerClock, { format: 2, definition } as never)).toThrow(
		'Unsupported service lowering format',
	)
	__defineServiceDefinition(OwnerClock, { format: 1, definition })
	expect(() =>
		__defineServiceDefinition(OwnerClock, {
			format: 1,
			definition: { ...definition, exportName: 'AnotherOwnerClock' },
		}),
	).toThrow('another identity')
	expect(() => __defineServiceRef({ format: 1, definition, contract: 'invalid' })).toThrow(
		'Invalid service control contract',
	)
	expect(() => createServiceReference({ definition, access: 'all', contract: 'invalid' })).toThrow(
		'Invalid service control contract',
	)
	expect(() => setServiceControlContract(OwnerClock, 'invalid')).toThrow(
		'Invalid service control contract',
	)
	const reference = __defineServiceRef<OwnerClock>({ format: 1, definition, access: 'owner' })
	expect(readServiceDefinition(reference).access).toBe('owner')
	expect(() => readServiceDefinition({ ...reference } as typeof reference)).toThrow(
		'Invalid service declaration or reference',
	)
})
