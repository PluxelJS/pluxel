import { describe, expect, it } from 'vitest'
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
