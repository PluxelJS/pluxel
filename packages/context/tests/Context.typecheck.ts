import { expectTypeOf } from 'vitest'
import {
	createContextHost,
	installRootService,
	installScopeService,
	installOwnerViewService,
	type Context,
	type RootContext,
	type ServiceRef,
	type ServiceDefinition,
	type ServiceInstallation,
} from '../src'
import { createServiceRef } from '../src/internal'

abstract class RootOnly {
	static readonly access = 'root'
	abstract readonly rootValue: number
}
abstract class OwnerOnly {
	static readonly access = 'owner'
	abstract readonly ownerValue: string
}
abstract class Shared {
	abstract readonly value: number
}
const host = createContextHost({
	name: 'types',
	services: [
		installRootService(RootOnly, { create: () => ({ rootValue: 1 }) }),
		installScopeService(OwnerOnly, { create: () => ({ ownerValue: 'owner' }) }),
		installOwnerViewService(Shared, {
			createRoot: () => ({ count: 1 }),
			createView: (backing) => ({ value: backing.count }),
		}),
	],
})
const check = () => {
	const root = host.createRoot(),
		owner = host.createScope(root, 'owner')
	expectTypeOf(root.service(RootOnly)).toEqualTypeOf<RootOnly>()
	expectTypeOf(owner.service(OwnerOnly)).toEqualTypeOf<OwnerOnly>()
	expectTypeOf(owner.service(Shared)).toEqualTypeOf<Shared>()
	expectTypeOf(root.service(createServiceRef(Shared))).toEqualTypeOf<Shared | undefined>()
	// @ts-expect-error root-only definitions are not available directly through an owner.
	owner.service(RootOnly)
	// @ts-expect-error owner-only definitions are not available through root.
	root.service(OwnerOnly)
	// @ts-expect-error Service properties are not projected onto the Context.
	owner.ownerValue
	// @ts-expect-error The old accessor is removed.
	root.require(Shared)
	// @ts-expect-error A service factory must return the declared API.
	installScopeService(Shared, { create: () => ({ other: true }) })
	// @ts-expect-error Installations are opaque.
	const installation: ServiceInstallation = {}
	// @ts-expect-error Optional references are opaque.
	const ref: ServiceRef<Shared> = { access: 'all' }
	// @ts-expect-error Required descriptors are opaque (classes are accepted declarations).
	const definition: ServiceDefinition<Shared> = { access: 'all' }
	// @ts-expect-error Ordinary contexts are not roots.
	const invalidRoot: RootContext = owner
	const ctx: Context = owner
	void [installation, ref, definition, invalidRoot, ctx]
}
void check
