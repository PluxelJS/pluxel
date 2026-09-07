import { describe, expect, it } from 'vitest'
import {
	createContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installScopeCapability,
	type Context,
} from '../../src'
import { Context as LegacyContext } from '../src/Context'
import type { ServiceClass as LegacyServiceClass } from '../src/service-types'

type AnyLegacyService = new (ctx: LegacyContext, cfg?: unknown) => object
const asLegacyServiceClass = (ctor: AnyLegacyService): LegacyServiceClass<AnyLegacyService> =>
	ctor as LegacyServiceClass<AnyLegacyService>

class LegacyScopedService {
	static key = 'architectureComparisonScoped' as const
	constructor(public ctx: LegacyContext) {}
}

class LegacyOwnerService {
	static key = 'architectureComparisonOwner' as const
	constructor(public ctx: LegacyContext) {}
}

LegacyContext.registerService(asLegacyServiceClass(LegacyScopedService))
LegacyContext.registerService(asLegacyServiceClass(LegacyOwnerService))

describe('legacy architecture comparison', () => {
	it('records how isolate selected a Service subset for one inherited instance space', () => {
		const root = new LegacyContext({ name: 'root' })
		const isolated = root.isolate([asLegacyServiceClass(LegacyScopedService)], {
			name: 'isolated',
		})
		const child = isolated.extend({ name: 'child' })
		const rootService = (root as unknown as { architectureComparisonScoped: object })
			.architectureComparisonScoped
		const isolatedService = (isolated as unknown as { architectureComparisonScoped: object })
			.architectureComparisonScoped

		expect(isolatedService).not.toBe(rootService)
		expect(
			(child as unknown as { architectureComparisonScoped: object }).architectureComparisonScoped,
		).toBe(isolatedService)
	})

	it('records the mutable owner rebinding that owner-view replaced', () => {
		const root = new LegacyContext({ name: 'root' })
		const child = root.extend({ name: 'child' })
		const service = (root as unknown as { architectureComparisonOwner: LegacyOwnerService })
			.architectureComparisonOwner

		expect(service.ctx).toBe(root)
		expect(
			(child as unknown as { architectureComparisonOwner: LegacyOwnerService })
				.architectureComparisonOwner,
		).toBe(service)
		expect(service.ctx).toBe(child)
	})

	it('proves current scope sharing and owner views without mutable ctx rebinding', () => {
		const scopedCapability = defineContextCapability<object>('comparison.scope')
		const ownerCapability = defineContextCapability<{ readonly owner: Context }>('comparison.owner')
		const host = createContextHost({
			name: 'comparison',
			capabilities: [
				installScopeCapability(scopedCapability, {
					property: 'scoped',
					create: () => ({}),
				}),
				installOwnerViewCapability(ownerCapability, {
					property: 'ownerView',
					createRoot: () => ({}),
					createView: (_backing, owner) => ({ owner }),
				}),
			],
		})
		const root = host.createRoot()
		const scope = host.createScope(root, 'scope')
		const child = host.createChild(scope, 'child')
		const rootView = root.ownerView
		const childView = child.ownerView

		expect(scope.scoped).not.toBe(root.scoped)
		expect(child.scoped).toBe(scope.scoped)
		expect(childView).not.toBe(rootView)
		expect(rootView.owner).toBe(root)
		expect(childView.owner).toBe(child)
		expect(rootView.owner).toBe(root)
	})
})
