import { expectTypeOf, it } from 'vitest'
import {
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installRootCapability,
	installScopeCapability,
	type Context,
	type ContextCapability,
	type ContextCapabilityInstallation,
	type ContextHost,
	type ContextOf,
	type RootContext,
	type RootContextOf,
} from '../src'

it('infers a host shape while keeping root-only projections off child contexts', () => {
	const rootCapability = defineContextCapability<{ root: true }>('types.root')
	const scopeCapability = defineContextCapability<{ scope: true }>('types.scope')
	const ownerCapability = defineContextCapability<{ owner: true }>('types.owner')
	const host = createContextHost({
		name: 'types',
		capabilities: [
			installRootCapability(rootCapability, {
				property: 'rootValue',
				create: () => ({ root: true as const }),
			}),
			installScopeCapability(scopeCapability, {
				property: 'scopeValue',
				create: () => ({ scope: true as const }),
			}),
			installOwnerViewCapability(ownerCapability, {
				property: 'ownerValue',
				createRoot: () => ({}),
				createView: () => ({ owner: true as const }),
			}),
		] as const,
	})

	type HostContext = ContextOf<typeof host>
	type HostRoot = RootContextOf<typeof host>
	expectTypeOf<HostContext['scopeValue']>().toEqualTypeOf<{ scope: true }>()
	expectTypeOf<HostContext['ownerValue']>().toEqualTypeOf<{ owner: true }>()
	expectTypeOf<HostRoot['rootValue']>().toEqualTypeOf<{ root: true }>()
	expectTypeOf<HostContext['root']>().toEqualTypeOf<HostRoot>()
	expectTypeOf<HostRoot['root']>().toEqualTypeOf<HostRoot>()

	type HasNoRootProjection = 'rootValue' extends keyof HostContext ? false : true
	expectTypeOf<HasNoRootProjection>().toEqualTypeOf<true>()
})

it('keeps capability value types invariant', () => {
	type Animal = { kind: string }
	type Dog = Animal & { bark(): void }
	const dogCapability = null as unknown as ContextCapability<Dog>
	expectTypeOf(dogCapability).toEqualTypeOf<ContextCapability<Dog>>()

	// @ts-expect-error A descriptor must never be widened and installed with a different value type.
	const unsafe: ContextCapability<Animal> = dogCapability
	void unsafe

	const animalCapability = null as unknown as ContextCapability<Animal>
	// @ts-expect-error A descriptor cannot be narrowed to a more specific value type either.
	const alsoUnsafe: ContextCapability<Dog> = animalCapability
	void alsoUnsafe
})

it('infers owner-view backing and factory Context types without annotations', () => {
	const rootCapability = defineContextCapability<{ root: true }>('types.factory-root')
	const scopeCapability = defineContextCapability<{ scope: true }>('types.factory-scope')
	const ownerCapability = defineContextCapability<{ view: true }>('types.factory-owner')

	installRootCapability(rootCapability, {
		create: (root) => {
			expectTypeOf(root).toEqualTypeOf<RootContext>()
			return { root: true as const }
		},
	})
	installScopeCapability(scopeCapability, {
		create: (scope) => {
			expectTypeOf(scope).toEqualTypeOf<Context>()
			return { scope: true as const }
		},
	})
	installOwnerViewCapability(ownerCapability, {
		createRoot: (root) => {
			expectTypeOf(root).toEqualTypeOf<RootContext>()
			return { backing: 1 as const }
		},
		createView: (backing, owner) => {
			expectTypeOf(backing).toEqualTypeOf<{ backing: 1 }>()
			expectTypeOf(owner).toEqualTypeOf<Context>()
			return { view: true as const }
		},
	})
})

it('keeps Context, RootContext, installation, and host contracts nominal', () => {
	const context = null as unknown as Context
	expectTypeOf(context).toEqualTypeOf<Context>()
	// @ts-expect-error A normal Context cannot be used as a host root.
	const root: RootContext = context
	void root

	// @ts-expect-error Installations can only be created by an installation helper.
	const installation: ContextCapabilityInstallation = {}
	void installation

	// @ts-expect-error ContextHost carries an inaccessible nominal type identity.
	const host: ContextHost = {
		name: 'forged',
		createRoot: () => null as unknown as RootContext,
		createScope: () => context,
		createChild: () => context,
	}
	void host

	// @ts-expect-error Capability descriptors can only be created by defineContextCapability().
	const capability: ContextCapability<string> = { description: 'forged' }
	void capability
})

it('infers symbol projections without leaking root-only properties to normal Contexts', () => {
	const rootKey: unique symbol = Symbol('root')
	const scopeKey: unique symbol = Symbol('scope')
	const rootCapability = defineContextCapability<number>('types.symbol-root')
	const scopeCapability = defineContextCapability<string>('types.symbol-scope')
	const host = createContextHost({
		name: 'symbol-projection',
		capabilities: [
			installRootCapability(rootCapability, { property: rootKey, create: () => 1 }),
			installScopeCapability(scopeCapability, { property: scopeKey, create: () => 'value' }),
		],
	})

	type HostContext = ContextOf<typeof host>
	type HostRoot = RootContextOf<typeof host>
	expectTypeOf<HostRoot[typeof rootKey]>().toEqualTypeOf<number>()
	expectTypeOf<HostRoot[typeof scopeKey]>().toEqualTypeOf<string>()
	expectTypeOf<HostContext[typeof scopeKey]>().toEqualTypeOf<string>()
	type HasNoRootSymbol = typeof rootKey extends keyof HostContext ? false : true
	expectTypeOf<HasNoRootSymbol>().toEqualTypeOf<true>()
})

it('constrains overrides to the base host projection contract', () => {
	const stringCapability = defineContextCapability<string>('types.override-string')
	const numberCapability = defineContextCapability<number>('types.override-number')
	const base = installRootCapability(stringCapability, {
		property: 'value',
		create: () => 'base',
	})

	const host = createContextHost({
		name: 'valid-override',
		capabilities: [base] as const,
		overrides: [
			installRootCapability(stringCapability, {
				property: 'value',
				create: () => 'replacement',
			}),
		],
	})
	expectTypeOf<RootContextOf<typeof host>['value']>().toEqualTypeOf<string>()

	const assertInvalidOverrides = () => {
		createContextHost({
			name: 'invalid-override-value',
			capabilities: [base] as const,
			overrides: [
				// @ts-expect-error An override cannot change the projected value contract.
				installRootCapability(numberCapability, { property: 'value', create: () => 1 }),
			],
		})

		createContextHost({
			name: 'invalid-override-property',
			capabilities: [base] as const,
			overrides: [
				// @ts-expect-error An override cannot change the projected property.
				installRootCapability(stringCapability, { property: 'other', create: () => 'value' }),
			],
		})
	}
	void assertInvalidOverrides
})
