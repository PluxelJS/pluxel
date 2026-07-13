import { describe, expect, it, vi } from 'vitest'
import { AcknowledgedProjectionRegistry } from '../src/projection.ts'

describe('AcknowledgedProjectionRegistry', () => {
	it('uses a stable ordered plan for each dispatch', async () => {
		const registry = new AcknowledgedProjectionRegistry<string, number>('test projection')
		const seen: string[] = []
		let disposeSecond = () => {}
		let thirdRegistered = false

		registry.register('first', async (source, event) => {
			seen.push(`first:${source}:${event}`)
			disposeSecond()
			if (!thirdRegistered) {
				thirdRegistered = true
				registry.register('third', () => void seen.push('third'))
			}
		})
		disposeSecond = registry.register('second', () => void seen.push('second'))

		await registry.dispatch('bot', 1, new AbortController().signal)
		expect(seen).toEqual(['first:bot:1', 'second'])

		seen.length = 0
		await registry.dispatch('bot', 2, new AbortController().signal)
		expect(seen).toEqual(['first:bot:2', 'third'])
	})

	it('is fail-fast and leaves checkpoint policy to the caller', async () => {
		const registry = new AcknowledgedProjectionRegistry<object, object>('test projection')
		const later = vi.fn()
		registry.register('failing', () => {
			throw new Error('queue full')
		})
		registry.register('later', later)

		await expect(registry.dispatch({}, {}, new AbortController().signal)).rejects.toThrow(
			'queue full',
		)
		expect(later).not.toHaveBeenCalled()
	})

	it('validates ids, rejects duplicates and returns an idempotent disposer', () => {
		const registry = new AcknowledgedProjectionRegistry<object, object>('test projection')
		expect(() => registry.register(' ', () => {})).toThrow('id is required')
		const dispose = registry.register('hub', () => {})
		expect(() => registry.register('hub', () => {})).toThrow('already registered')
		dispose()
		dispose()
		expect(registry.size).toBe(0)
	})

	it('does not start another projection after cancellation', async () => {
		const registry = new AcknowledgedProjectionRegistry<object, object>('test projection')
		const controller = new AbortController()
		const later = vi.fn()
		registry.register('first', () => controller.abort(new Error('stopped')))
		registry.register('later', later)

		await expect(registry.dispatch({}, {}, controller.signal)).rejects.toThrow('stopped')
		expect(later).not.toHaveBeenCalled()
	})
})
