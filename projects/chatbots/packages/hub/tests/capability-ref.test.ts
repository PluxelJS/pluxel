import { describe, expect, it, vi } from 'vitest'
import { createCapabilityRef } from '../src/index.ts'

describe('CapabilityRef', () => {
	it('publishes optional capability replacement without exposing mutation', () => {
		const { ref, controller } = createCapabilityRef<object>()
		const observer = vi.fn()
		const dispose = ref.observe(observer)
		const first = {}
		const second = {}
		controller.set(first)
		controller.set(first)
		controller.set(second)
		controller.set(undefined)
		dispose()
		controller.set(first)
		expect(observer.mock.calls.map(([value]) => value)).toEqual([first, second, undefined])
		expect(ref.current).toBe(first)
	})

	it('isolates observer failures so every binding sees the replacement', () => {
		const onObserverError = vi.fn()
		const { ref, controller } = createCapabilityRef<object>({ onObserverError })
		const expected = new Error('binding failed')
		ref.observe(() => {
			throw expected
		})
		const healthyObserver = vi.fn()
		ref.observe(healthyObserver)
		const capability = {}

		expect(() => controller.set(capability)).not.toThrow()
		expect(onObserverError).toHaveBeenCalledWith(expected)
		expect(healthyObserver).toHaveBeenCalledWith(capability)
		expect(ref.current).toBe(capability)
	})
})
