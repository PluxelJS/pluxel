import { expect, it } from 'vitest'
import {
	createContextHost,
	installRootService,
	installScopeService,
	ContextServiceAccessError,
	ContextServiceMissingError,
} from '../src'
import { createServiceRef, bindServiceIdentity, createServiceReference } from '../src/internal'

it('does not identify unrelated services by class name or structural API', () => {
	const first = class SameName {
		value = 1
	}
	const second = class SameName {
		value = 1
	}
	const root = createContextHost({
		name: 'identity',
		services: [installRootService(first, { create: () => ({ value: 1 }) })],
	}).createRoot()
	expect(() => root.service(second)).toThrow(ContextServiceMissingError)
	expect(root.service(createServiceRef(second))).toBeUndefined()
})
it('gives generated required descriptors the same lookup as native declarations', () => {
	abstract class Value {
		abstract value: number
	}
	bindServiceIdentity(Value, 'test-definition')
	const generated = createServiceReference<Value, 'all'>('test-definition', 'all')
	const root = createContextHost({
		name: 'generated',
		services: [installRootService(Value, { create: () => ({ value: 1 }) })],
	}).createRoot()
	expect(root.service(generated)).toBe(root.service(Value))
	const other = createContextHost({ name: 'empty', services: [] }).createRoot()
	expect(() => other.service(generated)).toThrow(ContextServiceMissingError)
})
it('does not disguise owner access errors as optional absence', () => {
	abstract class Owner {
		static readonly access = 'owner'
		abstract value: number
	}
	const root = createContextHost({
		name: 'owner',
		services: [installScopeService(Owner, { create: () => ({ value: 1 }) })],
	}).createRoot()
	expect(() => root.service(createServiceRef(Owner))).toThrow(ContextServiceAccessError)
})
