import { expect, it, vi } from 'vitest'
import {
	ContextServiceAccessError,
	ContextServiceMissingError,
	createContextHost,
	installRootService,
	installScopeService,
	installOwnerViewService,
	type Context,
	type ServiceInstallation,
} from '../src'
import {
	bindServiceIdentity,
	createContextView,
	createServiceRef,
	createServiceReference,
	resolveContextService,
} from '../src/internal'

abstract class RootValue {
	abstract readonly value: number
}
abstract class ScopeValue {
	abstract readonly scope: Context
}
abstract class OwnerValue {
	abstract readonly owner: Context
	abstract readonly backing: object
}

it('lazily shares services at their root, scope, and owner boundaries', () => {
	const makeRoot = vi.fn(() => ({ value: 42 }))
	const makeScope = vi.fn((scope: Context) => ({ scope }))
	const makeBacking = vi.fn(() => ({}))
	const makeView = vi.fn((backing: object, owner: Context) => ({ backing, owner }))
	const host = createContextHost({
		name: 'scoped',
		services: [
			installRootService(RootValue, { create: makeRoot }),
			installScopeService(ScopeValue, { create: makeScope }),
			installOwnerViewService(OwnerValue, { createRoot: makeBacking, createView: makeView }),
		],
	})
	const root = host.createRoot()
	const scope = host.createScope(root, 'scope')
	const child = host.createChild(scope, 'child')
	const view = createContextView(scope)
	for (const factory of [makeRoot, makeScope, makeBacking, makeView]) {
		expect(factory).not.toHaveBeenCalled()
	}

	expect(root.service(RootValue)).toBe(root.service(RootValue))
	expect(host.createRoot().service(RootValue)).not.toBe(root.service(RootValue))
	expect(child.service(ScopeValue)).toBe(scope.service(ScopeValue))
	expect(view.service(ScopeValue)).toBe(scope.service(ScopeValue))
	expect(host.createScope(root, 'other').service(ScopeValue)).not.toBe(scope.service(ScopeValue))
	expect(child.service(OwnerValue)).toBe(child.service(OwnerValue))
	expect(child.service(OwnerValue).owner).toBe(child)
	expect(view.service(OwnerValue).owner).toBe(view)
	expect(view.service(OwnerValue).backing).toBe(child.service(OwnerValue).backing)
})

it('matches canonical service references without conflating declarations by class name', () => {
	const first = class Value {
		value = 7
	}
	const sameName = class Value {
		value = 7
	}
	const optional = createServiceRef(first)
	bindServiceIdentity(first, 'service-value')
	const generated = createServiceReference<InstanceType<typeof first>, 'all'>(
		'service-value',
		'all',
	)
	const root = createContextHost({
		name: 'identity',
		services: [installRootService(first, { create: () => new first() })],
	}).createRoot()
	expect(root.service(generated)).toBe(root.service(first))
	expect(root.service(optional)).toBe(root.service(first))
	expect(() => root.service(sameName)).toThrow(ContextServiceMissingError)
	expect(root.service(createServiceRef(sameName))).toBeUndefined()
	expect(() => root.service({ ...optional } as typeof optional)).toThrow(TypeError)
})

it('rejects canonical identity collisions and refuses to rename a service after installation', () => {
	abstract class First extends RootValue {}
	abstract class Second extends RootValue {}
	bindServiceIdentity(First, 'same-key')
	bindServiceIdentity(Second, 'same-key')
	const first = installRootService(First, { create: () => ({ value: 1 }) })
	const second = installRootService(Second, { create: () => ({ value: 2 }) })

	expect(() => createContextHost({ name: 'collision', services: [first, second] })).toThrow(
		'more than once',
	)
	expect(() => bindServiceIdentity(First, 'another')).toThrow('another identity')
	const local = installRootService(RootValue, { create: () => ({ value: 3 }) })
	expect(() => bindServiceIdentity(RootValue, 'too-late')).toThrow('before installation')
	expect(
		createContextHost({ name: 'local', services: [local] })
			.createRoot()
			.service(RootValue).value,
	).toBe(3)
})

it('enforces root and owner access for optional references as well as required declarations', () => {
	abstract class OwnerOnly {
		static readonly access = 'owner'
		abstract readonly value: number
	}
	const host = createContextHost({
		name: 'access',
		services: [
			installRootService(RootValue, { create: () => ({ value: 1 }) }),
			installScopeService(OwnerOnly, { create: () => ({ value: 2 }) }),
		],
	})
	const root = host.createRoot()
	const owner = host.createScope(root, 'owner')
	expect(() => owner.service(createServiceRef(RootValue))).toThrow(ContextServiceAccessError)
	expect(() => root.service(createServiceRef(OwnerOnly))).toThrow(ContextServiceAccessError)
	expect(() => installRootService(OwnerOnly, { create: () => ({ value: 0 }) })).toThrow(
		'incompatible installation scope',
	)
	expect(owner.service(OwnerOnly).value).toBe(2)
	expect(resolveContextService(owner, RootValue)).toBe(root.service(RootValue))
})

it('surfaces an optional factory failure and caches a falsy value after successful retry', () => {
	const failure = new Error('backend failed')
	const build = vi.fn()
	build
		.mockImplementationOnce(() => {
			throw failure
		})
		.mockReturnValue(0)
	const value = createServiceReference<number, 'all'>('value', 'all')
	const ref = createServiceRef(value)
	const root = createContextHost({
		name: 'retry',
		services: [installRootService(value, { create: build })],
	}).createRoot()

	expect(() => root.service(ref)).toThrow(failure)
	expect(root.service(ref)).toBe(0)
	expect(root.service(value)).toBe(0)
	expect(build).toHaveBeenCalledTimes(2)
})

it('rejects an undefined factory result instead of reporting a missing optional service', () => {
	const invalid = createServiceReference<unknown, 'all'>('invalid', 'all')
	const root = createContextHost({
		name: 'invalid',
		services: [installRootService(invalid, { create: (): undefined => undefined })],
	}).createRoot()
	expect(() => root.service(createServiceRef(invalid))).toThrow('returned undefined')
})

it('recovers from an owner-view construction cycle while retaining its shared backing', () => {
	const backing = vi.fn(() => ({}))
	let enterCycle = true
	const host = createContextHost({
		name: 'cycle',
		services: [
			installOwnerViewService(RootValue, {
				createRoot: backing,
				createView: (_, owner) => (enterCycle ? owner.service(RootValue) : { value: 1 }),
			}),
		],
	})
	const owner = host.createScope(host.createRoot(), 'owner')
	expect(() => owner.service(RootValue)).toThrow('construction cycle')
	enterCycle = false
	expect(owner.service(RootValue).value).toBe(1)
	expect(backing).toHaveBeenCalledOnce()
})

it('applies a service override only when it preserves the installation boundary', () => {
	const original = installRootService(RootValue, { create: () => ({ value: 1 }) })
	const replacement = installRootService(RootValue, { create: () => ({ value: 2 }) })
	const host = createContextHost({
		name: 'override',
		services: [original],
		overrides: [replacement],
	})
	expect(host.createRoot().service(RootValue).value).toBe(2)
	expect(() =>
		createContextHost({
			name: 'invalid-override',
			services: [original],
			overrides: [
				// @ts-expect-error Runtime callers must also preserve the installation scope.
				installScopeService(RootValue, { create: () => ({ value: 3 }) }),
			],
		}),
	).toThrow('preserve scope and access')
	expect(() =>
		createContextHost({ name: 'forged', services: [{} as ServiceInstallation] }),
	).toThrow('Invalid service installation')
})
