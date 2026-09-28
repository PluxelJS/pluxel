import {
	createCoreContextHost,
	defineContextCapability,
	installOwnerViewCapability,
	installScopeCapability,
} from '../src/host'
import type { Context, RootContext } from '../src'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createCallerContextView, createGenerationContext } from '../src/context/context-factory'
import { createCoreRootContext } from '../src/context/core-plan'

describe('Core Context integration', () => {
	it('installs the Core-owned scope capabilities on the immutable root', () => {
		const root = createCoreRootContext({ name: 'core-integration' })
		const scope = createGenerationContext(root, 'scope')

		expect(root.name).toBe('core-integration')
		expect(scope.logger).toBe(scope.logger)
		expect(scope.effects).toBe(scope.effects)
		expect(Object.isExtensible(root)).toBe(false)
	})

	it('keeps Core caller views isolated while sharing provider scope capabilities', () => {
		const root = createCoreRootContext({ name: 'caller-core' })
		const provider = createGenerationContext(root, 'provider')
		const firstCaller = createGenerationContext(root, 'first-caller')
		const secondCaller = createGenerationContext(root, 'second-caller')
		const firstView = createCallerContextView(provider, firstCaller)
		const secondView = createCallerContextView(provider, secondCaller)

		expect(firstView.caller).toBe(firstCaller)
		expect(secondView.caller).toBe(secondCaller)
		expect(firstView).not.toBe(secondView)
		expect(firstView.effects).toBe(provider.effects)
		expect(secondView.effects).toBe(provider.effects)
	})
})

it('composes typed services with Core and preserves caller and Part capability owners', () => {
	const service = defineContextCapability<{ owner: Context }>('example.service', {
		access: 'all',
		property: 'exampleService',
	})
	const capability = installOwnerViewCapability(service, {
		property: 'exampleService',
		createRoot: (root) => {
			expectTypeOf(root).toEqualTypeOf<RootContext>()
			return {}
		},
		createView: (_, owner) => ({ owner }),
	})
	const host = createCoreContextHost({ capabilities: [capability] })
	const root = host.createRoot()
	const provider = host.createScope(root, 'provider')
	const part = host.createChild(provider, 'part')
	const caller = host.createScope(root, 'caller')
	const view = createCallerContextView(provider, caller)
	expect(provider.require(service)).toBe(provider.exampleService)
	expect(part.require(service).owner).toBe(part)
	expect(view.require(service).owner).toBe(view)
	expect(provider.require(service)).not.toBe(view.require(service))
	expectTypeOf(provider.exampleService).toEqualTypeOf<{ owner: Context }>()
	const typeChecks = () => {
		// @ts-expect-error An unselected service is not part of a different Host's required shape.
		createCoreContextHost().createRoot().exampleService
		// @ts-expect-error Duplicate literal projected properties are rejected before compilation.
		createCoreContextHost({ capabilities: [capability, capability] })
		createCoreContextHost({
			// @ts-expect-error Core owner identity is not a service extension point.
			capabilities: [
				installScopeCapability(service, { property: 'pluginInfo', create: (owner) => ({ owner }) }),
			],
		})
	}
	void typeChecks
})
