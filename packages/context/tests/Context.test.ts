import { describe, expect, it } from 'vitest'
import {
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	resolveContextCapability,
	type Context,
	type ContextCapability,
	type ContextCapabilityInstallation,
} from '../src'
import {
	createContextPlan,
	createContextView,
	createRootContext,
	type ContextPlan,
} from '../src/internal'

describe('Context host', () => {
	it('is strictly lazy and preserves root, scope, child, and owner-view identity', () => {
		const rootCapability = defineContextCapability<object>('test.root')
		const scopeCapability = defineContextCapability<object>('test.scope')
		const ownerCapability = defineContextCapability<{ owner: object; backing: object }>(
			'test.owner',
		)
		let rootCreates = 0
		let scopeCreates = 0
		let backingCreates = 0
		let viewCreates = 0
		let rootFactoryContext: Context | undefined
		let scopeFactoryContext: Context | undefined
		const host = createContextHost({
			name: 'scope-test',
			capabilities: [
				installRootCapability(rootCapability, {
					property: 'rootValue',
					create: (ctx) => {
						rootCreates += 1
						rootFactoryContext = ctx
						return {}
					},
				}),
				installScopeCapability(scopeCapability, {
					property: 'scopeValue',
					create: (ctx) => {
						scopeCreates += 1
						scopeFactoryContext ??= ctx
						return {}
					},
				}),
				installOwnerViewCapability(ownerCapability, {
					property: 'ownerValue',
					createRoot: () => {
						backingCreates += 1
						return {}
					},
					createView: (backing, owner) => {
						viewCreates += 1
						return { owner, backing }
					},
				}),
			],
		})
		const root = host.createRoot()
		const firstScope = host.createScope(root, 'first')
		const secondScope = host.createScope(root, 'second')
		const firstChild = host.createChild(firstScope, 'first-child')
		const secondChild = host.createChild(firstScope, 'second-child')

		expect([rootCreates, scopeCreates, backingCreates, viewCreates]).toEqual([0, 0, 0, 0])
		expect(firstScope.root).toBe(root)
		expect(firstChild.parent).toBe(firstScope)
		expect(Object.isExtensible(root)).toBe(false)
		expect(Object.isExtensible(firstScope)).toBe(false)
		expect('rootValue' in firstScope).toBe(false)

		expect(resolveContextCapability(firstChild, rootCapability)).toBe(
			resolveContextCapability(secondScope, rootCapability),
		)
		expect(resolveContextCapability(firstChild, scopeCapability)).toBe(
			resolveContextCapability(secondChild, scopeCapability),
		)
		expect(resolveContextCapability(firstChild, scopeCapability)).not.toBe(
			resolveContextCapability(secondScope, scopeCapability),
		)
		expect(firstChild.ownerValue).toBe(firstChild.ownerValue)
		expect(firstChild.ownerValue).not.toBe(secondChild.ownerValue)
		expect(firstChild.ownerValue.owner).toBe(firstChild)
		expect(root.rootValue).toBe(resolveContextCapability(firstChild, rootCapability))
		expect(firstChild.scopeValue).toBe(resolveContextCapability(firstChild, scopeCapability))
		expect(firstChild.ownerValue).toBe(resolveContextCapability(firstChild, ownerCapability))
		expect(rootFactoryContext).toBe(root)
		expect(scopeFactoryContext).toBe(firstScope)
		expect([rootCreates, scopeCreates, backingCreates, viewCreates]).toEqual([1, 2, 1, 2])
	})

	it('allows independent hosts with the same property name and descriptor', () => {
		const capability = defineContextCapability<string>('test.host-isolation')
		const first = createContextHost({
			name: 'first',
			capabilities: [
				installRootCapability(capability, { property: 'value', create: () => 'first' }),
			],
		})
		const second = createContextHost({
			name: 'second',
			capabilities: [
				installRootCapability(capability, { property: 'value', create: () => 'second' }),
			],
		})

		expect(first.createRoot().value).toBe('first')
		expect(second.createRoot().value).toBe('second')
		expect(() => first.createScope(second.createRoot(), 'wrong-host')).toThrow(
			'belongs to a different host',
		)
	})

	it('keeps descriptors identity-based even when their descriptions match', () => {
		const firstCapability = defineContextCapability<string>('test.same-description')
		const secondCapability = defineContextCapability<string>('test.same-description')
		const host = createContextHost({
			name: 'descriptor-identity',
			capabilities: [
				installRootCapability(firstCapability, { create: () => 'first' }),
				installRootCapability(secondCapability, { create: () => 'second' }),
			],
		})
		const root = host.createRoot()

		expect(resolveContextCapability(root, firstCapability)).toBe('first')
		expect(resolveContextCapability(root, secondCapability)).toBe('second')
	})

	it('keeps runtime state private and freezes the compiled prototype chain', () => {
		const host = createContextHost({ name: 'opaque-state', capabilities: [] })
		const root = host.createRoot()
		const scope = host.createScope(root, 'scope')

		expect(Object.getOwnPropertySymbols(root)).toEqual([])
		expect(Object.getOwnPropertySymbols(scope)).toEqual([])
		expect(Object.isFrozen(Object.getPrototypeOf(root))).toBe(true)
		expect(Object.isFrozen(Object.getPrototypeOf(scope))).toBe(true)
		expect(Object.getPrototypeOf(root).constructor).toBeUndefined()
		expect(Object.getPrototypeOf(scope).constructor).toBeUndefined()
		expect(Object.getPrototypeOf(Object.getPrototypeOf(scope)).constructor).toBeUndefined()
		expect(() => Object.defineProperty(scope, 'root', { value: root })).toThrow(/not extensible/)
		expect(() => Object.setPrototypeOf(scope, null)).toThrow(/not extensible/)
	})

	it('uses runtime-opaque frozen capability, installation, and plan tokens', () => {
		const capability = defineContextCapability<string>('test.opaque-token')
		const installation = installRootCapability(capability, { create: () => 'value' })
		const plan = createContextPlan('opaque-token', [installation])

		expect(Object.isFrozen(capability)).toBe(true)
		expect(Object.isFrozen(installation)).toBe(true)
		expect(Object.getOwnPropertyNames(installation)).toEqual([])
		expect(Object.getOwnPropertySymbols(installation)).toEqual([])
		expect(Object.isFrozen(plan)).toBe(true)
		expect(Object.getOwnPropertyNames(plan)).toEqual([])
		expect(Object.getOwnPropertySymbols(plan)).toEqual([])
		expect(resolveContextCapability(createRootContext(plan), capability)).toBe('value')

		expect(() =>
			installRootCapability({ description: 'forged' } as ContextCapability<string>, {
				create: () => 'forged',
			}),
		).toThrow('Invalid Context capability descriptor')
		expect(() =>
			createContextPlan('forged-installation', [{} as ContextCapabilityInstallation]),
		).toThrow('invalid capability installation')
		expect(() => createRootContext({} as ContextPlan)).toThrow('Invalid Context plan')
	})

	it('rejects incomplete capability factories when creating an installation', () => {
		const capability = defineContextCapability<string>('test.invalid-factory')

		expect(() => installRootCapability(capability, {} as never)).toThrow(
			'requires a create factory',
		)
		expect(() => installScopeCapability(capability, null as never)).toThrow(
			'requires a create factory',
		)
		expect(() => installOwnerViewCapability(capability, {} as never)).toThrow(
			'requires a createRoot factory',
		)
		expect(() =>
			installOwnerViewCapability(capability, { createRoot: () => ({}) } as never),
		).toThrow('requires a createView factory')
	})

	it('applies explicit pre-root overrides and rejects ambiguous replacements', () => {
		const capability = defineContextCapability<string>('test.override')
		const base = installRootCapability(capability, {
			property: 'value',
			create: () => 'base',
		})
		const replacement = installRootCapability(capability, {
			property: 'value',
			create: () => 'replacement',
		})
		const host = createContextHost({
			name: 'override',
			capabilities: [base],
			overrides: [replacement],
		})
		expect(host.createRoot().value).toBe('replacement')

		const absent = defineContextCapability('test.absent')
		expect(() =>
			createContextHost({
				name: 'unmatched',
				capabilities: [base],
				overrides: [
					installRootCapability(absent, {
						create: () => 'absent',
					}) as unknown as typeof base,
				],
			}),
		).toThrow('Cannot override uninstalled capability')
		expect(() =>
			createContextHost({
				name: 'duplicate-override',
				capabilities: [base],
				overrides: [replacement, replacement],
			}),
		).toThrow('is overridden more than once')
		expect(() =>
			createContextHost({
				name: 'changed-contract',
				capabilities: [base],
				overrides: [
					installRootCapability(capability, {
						property: 'other',
						create: () => 'wrong',
					}) as unknown as typeof base,
				],
			}),
		).toThrow('must preserve scope and property')
	})

	it('keeps omitted and unused capabilities at zero construction cost', () => {
		let creates = 0
		const unused = defineContextCapability<object>('test.unused')
		const omitted = defineContextCapability<object>('test.omitted')
		const host = createContextHost({
			name: 'lazy',
			capabilities: [
				installRootCapability(unused, {
					property: 'unused',
					create: () => {
						creates += 1
						return {}
					},
				}),
			],
		})
		const root = host.createRoot()
		host.createScope(root, 'scope')
		expect(creates).toBe(0)
		expect(() => resolveContextCapability(root, omitted)).toThrow('does not install test.omitted')
		expect(() =>
			resolveContextCapability(root, { description: 'forged' } as ContextCapability<object>),
		).toThrow('Invalid Context capability descriptor')
		expect(() => resolveContextCapability({} as Context, unused)).toThrow(
			'Invalid Context implementation',
		)
		expect(creates).toBe(0)
	})

	it('isolates values across roots while sharing one compiled host shape', () => {
		const rootCapability = defineContextCapability<object>('test.root-isolation')
		const scopeCapability = defineContextCapability<object>('test.scope-isolation')
		const host = createContextHost({
			name: 'root-isolation',
			capabilities: [
				installRootCapability(rootCapability, { create: () => ({}) }),
				installScopeCapability(scopeCapability, { create: () => ({}) }),
			],
		})
		const firstRoot = host.createRoot('first')
		const secondRoot = host.createRoot('second')
		const firstScope = host.createScope(firstRoot, 'first-scope')
		const secondScope = host.createScope(secondRoot, 'second-scope')

		expect(resolveContextCapability(firstScope, rootCapability)).not.toBe(
			resolveContextCapability(secondScope, rootCapability),
		)
		expect(resolveContextCapability(firstScope, scopeCapability)).not.toBe(
			resolveContextCapability(secondScope, scopeCapability),
		)
		expect(Object.getPrototypeOf(firstRoot)).toBe(Object.getPrototypeOf(secondRoot))
		expect(Object.getPrototypeOf(firstScope)).toBe(Object.getPrototypeOf(secondScope))
	})

	it('gives views fresh owner values while retaining their source scope', () => {
		const scopeCapability = defineContextCapability<object>('test.view-scope')
		const ownerCapability = defineContextCapability<{ owner: object; backing: object }>(
			'test.view-owner',
		)
		const host = createContextHost({
			name: 'views',
			capabilities: [
				installScopeCapability(scopeCapability, { create: () => ({}) }),
				installOwnerViewCapability(ownerCapability, {
					createRoot: () => ({}),
					createView: (backing, owner) => ({ backing, owner }),
				}),
			],
		})
		const scope = host.createScope(host.createRoot(), 'scope')
		const firstView = createContextView(scope)
		const secondView = createContextView(scope)

		expect(resolveContextCapability(firstView, scopeCapability)).toBe(
			resolveContextCapability(secondView, scopeCapability),
		)
		expect(resolveContextCapability(firstView, ownerCapability)).not.toBe(
			resolveContextCapability(secondView, ownerCapability),
		)
		expect(resolveContextCapability(firstView, ownerCapability).owner).toBe(firstView)
		expect(resolveContextCapability(secondView, ownerCapability).owner).toBe(secondView)
	})

	it('detects construction cycles and retries failed factories', () => {
		const first = defineContextCapability<string>('test.first')
		const second = defineContextCapability<string>('test.second')
		let fail = true
		const host = createContextHost({
			name: 'cycles',
			capabilities: [
				installRootCapability(first, {
					create: (ctx) => {
						if (fail) {
							fail = false
							return resolveContextCapability(ctx, second)
						}
						return 'ready'
					},
				}),
				installRootCapability(second, {
					create: (ctx) => resolveContextCapability(ctx, first),
				}),
			],
		})
		const root = host.createRoot()
		expect(() => resolveContextCapability(root, first)).toThrow('construction cycle at test.first')
		expect(resolveContextCapability(root, first)).toBe('ready')
	})

	it('detects owner-view cycles and retries a failed view without rebuilding its backing', () => {
		const capability = defineContextCapability<string>('test.owner-cycle')
		let cycle = true
		let backingCalls = 0
		let viewCalls = 0
		const host = createContextHost({
			name: 'owner-cycle',
			capabilities: [
				installOwnerViewCapability(capability, {
					createRoot: () => {
						backingCalls += 1
						return {}
					},
					createView: (_backing, owner) => {
						viewCalls += 1
						if (cycle) {
							cycle = false
							return resolveContextCapability(owner, capability)
						}
						return 'ready'
					},
				}),
			],
		})
		const owner = host.createScope(host.createRoot(), 'owner')

		expect(() => resolveContextCapability(owner, capability)).toThrow(
			'construction cycle at test.owner-cycle',
		)
		expect(resolveContextCapability(owner, capability)).toBe('ready')
		expect(backingCalls).toBe(1)
		expect(viewCalls).toBe(2)
	})

	it('caches falsy values and retries undefined factories', () => {
		const zero = defineContextCapability<number>('test.zero')
		const empty = defineContextCapability<string>('test.empty')
		const nil = defineContextCapability<null>('test.null')
		const invalid = defineContextCapability<unknown>('test.undefined')
		let zeroCalls = 0
		const host = createContextHost({
			name: 'values',
			capabilities: [
				installRootCapability(zero, {
					create: () => {
						zeroCalls += 1
						return 0
					},
				}),
				installRootCapability(empty, { create: () => '' }),
				installRootCapability(nil, { create: (): null => null }),
				installRootCapability(invalid, { create: (): undefined => undefined }),
			],
		})
		const root = host.createRoot()
		expect(resolveContextCapability(root, zero)).toBe(0)
		expect(resolveContextCapability(root, zero)).toBe(0)
		expect(zeroCalls).toBe(1)
		expect(resolveContextCapability(root, empty)).toBe('')
		expect(resolveContextCapability(root, nil)).toBeNull()
		expect(() => resolveContextCapability(root, invalid)).toThrow('returned undefined')
		expect(() => resolveContextCapability(root, invalid)).toThrow('returned undefined')
	})

	it('rejects duplicate capabilities and projected properties', () => {
		const first = defineContextCapability('test.duplicate')
		const second = defineContextCapability('test.second')
		const installation = installRootCapability(first, { create: () => 'first' })
		expect(() =>
			createContextHost({
				name: 'duplicate-capability',
				capabilities: [installation, installation],
			}),
		).toThrow('installs test.duplicate more than once')
		expect(() =>
			createContextHost({
				name: 'duplicate-property',
				capabilities: [
					installRootCapability(first, { property: 'value', create: () => 'first' }),
					installScopeCapability(second, { property: 'value', create: () => 'second' }),
				],
			}),
		).toThrow('has a duplicate property value')
	})
})
