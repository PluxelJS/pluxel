import { createCoreContextHost, installOwnerViewService } from '../src/host'
import { LoggerService, EffectsService, type Context, type RootContext } from '../src'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createCallerContextView, createGenerationContext } from '../src/context/context-factory'
import { createCoreRootContext } from '../src/context/core-plan'
abstract class ExampleService {}
interface ExampleService {
	readonly owner: Context
}

describe('Core Context integration', () => {
	it('installs lazy Core services on the immutable root', () => {
		const root = createCoreRootContext({ name: 'core-integration' })
		const scope = createGenerationContext(root, 'scope')
		expect(root.name).toBe('core-integration')
		expect(scope.service(LoggerService)).toBe(scope.service(LoggerService))
		expect(scope.service(EffectsService)).toBe(scope.service(EffectsService))
		expect(Object.isExtensible(root)).toBe(false)
		expect('logger' in scope).toBe(false)
		expect('require' in scope).toBe(false)
	})

	it('shares generation services while preserving dependency caller ownership', () => {
		const root = createCoreRootContext({ name: 'caller-core' })
		const provider = createGenerationContext(root, 'provider')
		const firstCaller = createGenerationContext(root, 'first-caller')
		const secondCaller = createGenerationContext(root, 'second-caller')
		const firstView = createCallerContextView(provider, firstCaller)
		const secondView = createCallerContextView(provider, secondCaller)
		expect(firstView.caller).toBe(firstCaller)
		expect(secondView.caller).toBe(secondCaller)
		expect(firstView).not.toBe(secondView)
		expect(firstView.service(EffectsService)).toBe(provider.service(EffectsService))
		expect(secondView.service(EffectsService)).toBe(provider.service(EffectsService))
	})

	it('binds owner views to their Context and rejects duplicate service installations', () => {
		const installation = installOwnerViewService(ExampleService, {
			createRoot: (root) => {
				expectTypeOf(root).toEqualTypeOf<RootContext>()
				return {}
			},
			createView: (_, owner) => ({ owner }),
		})
		const host = createCoreContextHost({ services: [installation] })
		const root = host.createRoot()
		const provider = host.createScope(root, 'provider')
		const part = host.createChild(provider, 'part')
		const caller = host.createScope(root, 'caller')
		const view = createCallerContextView(provider, caller)
		expect(provider.service(ExampleService).owner).toBe(provider)
		expect(part.service(ExampleService).owner).toBe(part)
		expect(view.service(ExampleService).owner).toBe(view)
		expect(provider.service(ExampleService)).not.toBe(view.service(ExampleService))
		expectTypeOf(provider.service(ExampleService)).toEqualTypeOf<ExampleService>()
		expect(() => createCoreContextHost({ services: [installation, installation] })).toThrow(
			/more than once/,
		)
	})
})
