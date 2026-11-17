import { describe, expect, it } from 'vitest'
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
	resolveContextService,
	bindServiceIdentity,
	createServiceRef,
	createServiceReference,
	createContextPlan,
	createRootContext,
	createContextView,
	getInstalledServiceDefinitions,
	resolveInstalledServiceDefinition,
	getServiceDefinitionKey,
	initializeContextServiceValues,
} from '../src/internal'

abstract class Value {
	abstract readonly value: number
}
abstract class ScopeValue {
	abstract readonly scope: Context
}
abstract class OwnerValue {
	abstract readonly owner: Context
	abstract readonly backing: object
}

describe('Context services', () => {
	it('is strictly lazy and preserves root, scope, child and owner identities', () => {
		let roots = 0,
			scopes = 0,
			backings = 0,
			views = 0
		const host = createContextHost({
			name: 'lazy',
			services: [
				installRootService(Value, {
					create: () => {
						roots++
						return { value: 42 }
					},
				}),
				installScopeService(ScopeValue, {
					create: (scope) => {
						scopes++
						return { scope }
					},
				}),
				installOwnerViewService(OwnerValue, {
					createRoot: () => {
						backings++
						return {}
					},
					createView: (backing, owner) => {
						views++
						return { owner, backing }
					},
				}),
			],
		})
		const root = host.createRoot(),
			first = host.createScope(root, 'first'),
			second = host.createScope(root, 'second')
		const child = host.createChild(first, 'child'),
			sibling = host.createChild(first, 'sibling')
		expect([roots, scopes, backings, views]).toEqual([0, 0, 0, 0])
		expect(root.service(Value).value).toBe(42)
		expect(child.service(ScopeValue)).toBe(first.service(ScopeValue))
		expect(child.service(ScopeValue).scope).toBe(first)
		expect(child.service(ScopeValue)).not.toBe(second.service(ScopeValue))
		expect(child.service(OwnerValue)).toBe(child.service(OwnerValue))
		expect(child.service(OwnerValue)).not.toBe(sibling.service(OwnerValue))
		expect(child.service(OwnerValue).backing).toBe(sibling.service(OwnerValue).backing)
		expect(child.service(OwnerValue).owner).toBe(child)
		expect(child.root).toBe(root)
		expect(child.parent).toBe(first)
		expect([roots, scopes, backings, views]).toEqual([1, 2, 1, 2])
	})
	it('isolates values between roots and independent hosts', () => {
		const host = createContextHost({
			name: 'isolated',
			services: [installRootService(Value, { create: () => ({ value: 1 }) })],
		})
		const first = host.createRoot(),
			second = host.createRoot()
		expect(first.service(Value)).not.toBe(second.service(Value))
		const another = createContextHost({
			name: 'other',
			services: [installRootService(Value, { create: () => ({ value: 2 }) })],
		})
		expect(another.createRoot().service(Value).value).toBe(2)
		expect(() => host.createScope(another.createRoot(), 'foreign')).toThrow('different host')
	})
	it('gives source Context views fresh owner values while sharing the scope', () => {
		const host = createContextHost({
			name: 'views',
			services: [
				installScopeService(ScopeValue, { create: (scope) => ({ scope }) }),
				installOwnerViewService(OwnerValue, {
					createRoot: () => ({}),
					createView: (backing, owner) => ({ backing, owner }),
				}),
			],
		})
		const scope = host.createScope(host.createRoot(), 'scope')
		const a = createContextView(scope),
			b = createContextView(scope)
		expect(a.service(ScopeValue)).toBe(b.service(ScopeValue))
		expect(a.service(OwnerValue)).not.toBe(b.service(OwnerValue))
		expect(a.service(OwnerValue).owner).toBe(a)
		expect(b.service(OwnerValue).owner).toBe(b)
	})
	it('keeps construction-time owner values fixed across views without changing sibling or scope caches', () => {
		let ownerFactories = 0
		const host = createContextHost({
			name: 'construction',
			services: [
				installScopeService(ScopeValue, { create: (scope) => ({ scope }) }),
				installOwnerViewService(OwnerValue, {
					createRoot: () => ({}),
					createView: (backing, owner) => {
						ownerFactories++
						return { backing, owner }
					},
				}),
			],
		})
		const scope = host.createScope(host.createRoot(), 'scope')
		const part = host.createChild(scope, 'part'),
			sibling = host.createChild(scope, 'sibling')
		const fixed = { backing: {}, owner: part }
		initializeContextServiceValues(part, [[OwnerValue, fixed]])
		const view = createContextView(part)
		expect(part.service(OwnerValue)).toBe(fixed)
		expect(part.service(createServiceRef(OwnerValue))).toBe(fixed)
		expect(resolveContextService(part, OwnerValue)).toBe(fixed)
		expect(view.service(OwnerValue)).toBe(fixed)
		expect(sibling.service(OwnerValue)).not.toBe(fixed)
		expect(part.service(ScopeValue)).toBe(sibling.service(ScopeValue))
		expect(ownerFactories).toBe(1)
		expect(() => initializeContextServiceValues(part, [[OwnerValue, fixed]])).toThrow(
			'once before service resolution',
		)
	})
	it('validates construction-time bindings atomically and preserves installed access', () => {
		abstract class RootOnly {
			static readonly access = 'root'
			abstract readonly value: number
		}
		const host = createContextHost({
			name: 'bindings',
			services: [
				installRootService(RootOnly, { create: () => ({ value: 1 }) }),
				installOwnerViewService(Value, {
					createRoot: () => ({}),
					createView: () => ({ value: 2 }),
				}),
			],
		})
		const root = host.createRoot(),
			owner = host.createScope(root, 'owner')
		expect(() =>
			initializeContextServiceValues(owner, [
				[Value, { value: 7 }],
				[ScopeValue, {}],
			]),
		).toThrow(ContextServiceMissingError)
		expect(() => initializeContextServiceValues(owner, [[Value, undefined]])).toThrow(
			'cannot be undefined',
		)
		expect(() =>
			initializeContextServiceValues(owner, [
				[Value, {}],
				[Value, {}],
			]),
		).toThrow('more than once')
		initializeContextServiceValues(owner, [
			[Value, { value: 3 }],
			[RootOnly, { value: 4 }],
		])
		expect(owner.service(Value).value).toBe(3)
		expect(() => owner.service(RootOnly as never)).toThrow(ContextServiceAccessError)
		expect(root.service(RootOnly).value).toBe(1)
		const late = host.createScope(root, 'late')
		late.service(Value)
		expect(() => initializeContextServiceValues(late, [[Value, { value: 5 }]])).toThrow(
			'once before service resolution',
		)
		const missing = host.createScope(root, 'missing')
		expect(missing.service(createServiceRef(ScopeValue))).toBeUndefined()
		expect(() => initializeContextServiceValues(missing, [])).toThrow(
			'once before service resolution',
		)
	})
	it('unifies required and optional references through the bound canonical identity', () => {
		abstract class Native {
			abstract readonly value: number
		}
		const optional = createServiceRef(Native)
		expect(
			createContextHost({ name: 'not-installed-yet', services: [] }).createRoot().service(optional),
		).toBeUndefined()
		bindServiceIdentity(Native, 'canonical-service')
		const required = createServiceReference<Native, 'all'>('canonical-service', 'all')
		const host = createContextHost({
			name: 'identity',
			services: [installRootService(Native, { create: () => ({ value: 7 }) })],
		})
		const root = host.createRoot()
		expect(root.service(required)).toBe(root.service(Native))
		expect(root.service(optional)).toBe(root.service(Native))
		expect(getServiceDefinitionKey(Native)).toBe('canonical-service')
		expect(getInstalledServiceDefinitions(root)).toEqual([Native])
		expect(resolveInstalledServiceDefinition(root, 'canonical-service')).toBe(Native)
		expect(() => bindServiceIdentity(Native, 'another')).toThrow('another identity')
	})
	it('rejects distinct declarations claiming the same canonical identity', () => {
		abstract class First {
			abstract readonly value: number
		}
		abstract class Second {
			abstract readonly value: number
		}
		bindServiceIdentity(First, 'same-key')
		bindServiceIdentity(Second, 'same-key')
		expect(() =>
			createContextHost({
				name: 'collision',
				services: [
					installRootService(First, { create: () => ({ value: 1 }) }),
					installRootService(Second, { create: () => ({ value: 2 }) }),
				],
			}),
		).toThrow('more than once')
	})
	it('fixes identity before installation so later binding cannot invalidate existing plans', () => {
		abstract class Local {
			abstract readonly value: number
		}
		const ref = createServiceRef(Local)
		const item = installRootService(Local, { create: () => ({ value: 1 }) })
		expect(() => bindServiceIdentity(Local, 'too-late')).toThrow('before installation')
		const root = createContextHost({ name: 'fixed-identity', services: [item] }).createRoot()
		expect(root.service(Local).value).toBe(1)
		expect(root.service(ref)).toBe(root.service(Local))
		const descriptor = createServiceReference<Local, 'all'>('fixed-descriptor', 'all')
		expect(() => bindServiceIdentity(descriptor, 'another-descriptor')).toThrow('another identity')
	})
	it('returns undefined only for a missing optional reference', () => {
		const ref = createServiceRef(Value)
		const root = createContextHost({ name: 'absent', services: [] }).createRoot()
		expect(root.service(ref)).toBeUndefined()
		expect(() => root.service(Value)).toThrow(ContextServiceMissingError)
		expect(() => root.service({ ...ref } as typeof ref)).toThrow(TypeError)
		expect(() => installRootService(ref as never, { create: () => ({ value: 0 }) })).toThrow(
			'optional ServiceRef',
		)
	})
	it('preserves factory errors for optional lookup and retries failed construction', () => {
		const failure = new Error('backend failed')
		let attempts = 0
		const root = createContextHost({
			name: 'failure',
			services: [
				installRootService(Value, {
					create: () => {
						if (attempts++ === 0) throw failure
						return { value: 9 }
					},
				}),
			],
		}).createRoot()
		const ref = createServiceRef(Value)
		expect(() => root.service(ref)).toThrow(failure)
		expect(root.service(ref)?.value).toBe(9)
	})
	it('enforces installation access even when the declaration has default all access', () => {
		abstract class RootOnly {
			static readonly access = 'root'
			abstract readonly value: number
		}
		abstract class OwnerOnly {
			static readonly access = 'owner'
			abstract readonly value: number
		}
		const host = createContextHost({
			name: 'access',
			services: [
				installRootService(RootOnly, { create: () => ({ value: 1 }) }),
				installRootService(Value, { create: () => ({ value: 2 }) }),
				installScopeService(OwnerOnly, { create: () => ({ value: 3 }) }),
			],
		})
		const root = host.createRoot(),
			scope = host.createScope(root, 'owner')
		expect(root.service(RootOnly).value).toBe(1)
		expect(scope.service(OwnerOnly).value).toBe(3)
		expect(() => scope.service(RootOnly as never)).toThrow(ContextServiceAccessError)
		expect(() => scope.service(createServiceRef(Value))).toThrow(ContextServiceAccessError)
		expect(() => root.service(createServiceRef(OwnerOnly))).toThrow(ContextServiceAccessError)
		expect(() => root.service(createServiceRef(OwnerOnly))).toThrow(
			'Service OwnerOnly is not available',
		)
		expect(() => installRootService(OwnerOnly, { create: () => ({ value: 0 }) })).toThrow(
			'incompatible installation scope',
		)
		expect(() => installScopeService(RootOnly, { create: () => ({ value: 0 }) })).toThrow(
			'incompatible installation scope',
		)
		// Framework preparation can intentionally obtain the root backing through the internal resolver.
		expect(resolveContextService(scope, RootOnly)).toBe(root.service(RootOnly))
	})
	it('keeps primitive and function values native and caches falsy values', () => {
		const zero = createServiceReference<number, 'all'>('zero', 'all')
		const nil = createServiceReference<null, 'all'>('nil', 'all')
		abstract class Callable {}
		interface Callable {
			(value: number): number
		}
		let calls = 0
		const root = createContextHost({
			name: 'native',
			services: [
				installRootService(zero, {
					create: () => {
						calls++
						return 0
					},
				}),
				installRootService(nil, { create: (): null => null }),
				installScopeService(Callable, { create: () => (value) => value * 2 }),
			],
		}).createRoot()
		expect(root.service(zero)).toBe(0)
		expect(root.service(zero)).toBe(0)
		expect(calls).toBe(1)
		expect(root.service(nil)).toBeNull()
		expect(root.service(Callable)(3)).toBe(6)
	})
	it('rejects undefined results without converting them into optional absence', () => {
		const invalid = createServiceReference<unknown, 'all'>('invalid', 'all')
		let calls = 0
		const root = createContextHost({
			name: 'undefined',
			services: [
				installRootService(invalid, {
					create: (): undefined => {
						calls++
						return undefined
					},
				}),
			],
		}).createRoot()
		const ref = createServiceRef(invalid)
		expect(() => root.service(ref)).toThrow('returned undefined')
		expect(() => root.service(ref)).toThrow('returned undefined')
		expect(calls).toBe(2)
	})
	it('detects cycles and recovers while preserving an owner-view backing', () => {
		let cycle = true,
			backingCalls = 0
		const host = createContextHost({
			name: 'cycle',
			services: [
				installOwnerViewService(Value, {
					createRoot: () => {
						backingCalls++
						return {}
					},
					createView: (_backing, owner) => {
						if (cycle) {
							cycle = false
							return owner.service(Value)
						}
						return { value: 1 }
					},
				}),
			],
		})
		const owner = host.createScope(host.createRoot(), 'owner')
		expect(() => owner.service(Value)).toThrow('construction cycle')
		expect(owner.service(Value).value).toBe(1)
		expect(backingCalls).toBe(1)
	})
	it('applies explicit overrides and preserves installation scope and access', () => {
		const base = installRootService(Value, { create: () => ({ value: 1 }) })
		const replacement = installRootService(Value, { create: () => ({ value: 2 }) })
		const root = createContextHost({
			name: 'override',
			services: [base],
			overrides: [replacement],
		}).createRoot()
		expect(root.service(Value).value).toBe(2)
		expect(() =>
			createContextHost({
				name: 'duplicate',
				services: [base],
				overrides: [replacement, replacement],
			}),
		).toThrow('more than once')
		expect(() =>
			createContextHost({
				name: 'scope',
				services: [base],
				overrides: [
					installScopeService(Value, { create: () => ({ value: 3 }) }) as unknown as typeof base,
				],
			}),
		).toThrow('preserve scope and access')
	})
	it('uses opaque installations and plans with private immutable context shape', () => {
		const item = installRootService(Value, { create: () => ({ value: 1 }) })
		const plan = createContextPlan('opaque', [item])
		expect(Object.isFrozen(item)).toBe(true)
		expect(Reflect.ownKeys(item)).toEqual([])
		expect(Object.isFrozen(plan)).toBe(true)
		expect(Reflect.ownKeys(plan)).toEqual([])
		expect(createRootContext(plan).service(Value).value).toBe(1)
		expect(() => createContextPlan('forged', [{} as ServiceInstallation])).toThrow(
			'Invalid service installation',
		)
		const root = createContextHost({ name: 'shape', services: [] }).createRoot()
		expect(Object.isFrozen(Object.getPrototypeOf(root))).toBe(true)
		expect(Object.getOwnPropertySymbols(root)).toEqual([])
		expect('require' in root).toBe(false)
		expect(() => Object.defineProperty(root, 'injected', { value: 1 })).toThrow(TypeError)
		expect(() => resolveContextService({} as Context, Value)).toThrow(
			'Invalid Context implementation',
		)
	})
})
