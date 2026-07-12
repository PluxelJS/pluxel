import { describe, expect, it, vi } from 'vitest'
import { createBotRegistry } from '../src/index.ts'

describe('BotRegistry', () => {
	it('exposes a read-only live view with strict lookup', () => {
		const { registry, controller } = createBotRegistry<{ name: string }>()
		const bot = { name: 'primary' }
		controller.register('primary', bot)

		expect(registry.size).toBe(1)
		expect(registry.get('primary')).toBe(bot)
		expect(registry.require('primary')).toBe(bot)
		expect([...registry]).toEqual([bot])
		expect(Object.isFrozen(registry)).toBe(true)
		expect(() => registry.require('missing')).toThrow('not configured')
	})

	it('rejects duplicate IDs and makes registration disposal idempotent', () => {
		const { registry, controller } = createBotRegistry<object>()
		const bot = {}
		const dispose = controller.register('bot-1', bot)
		expect(() => controller.register('bot-1', {})).toThrow('already registered')
		dispose()
		dispose()
		expect(registry.size).toBe(0)
	})

	it('notifies observers without granting mutation authority', () => {
		const { registry, controller } = createBotRegistry<object>()
		const observer = vi.fn()
		const dispose = registry.observe(observer)
		const bot = {}
		controller.register('primary', bot)
		controller.remove('primary', bot)
		dispose()
		controller.register('secondary', {})
		expect(observer.mock.calls.map(([change]) => change.type)).toEqual(['added', 'removed'])
	})

	it('does not let an observer corrupt registry mutation', () => {
		const errors: unknown[] = []
		const { registry, controller } = createBotRegistry<object>({
			onObserverError: (error) => errors.push(error),
		})
		registry.observe(() => {
			throw new Error('observer failed')
		})
		const dispose = controller.register('primary', {})
		expect(registry.has('primary')).toBe(true)
		dispose()
		expect(registry.has('primary')).toBe(false)
		expect(errors).toHaveLength(2)
	})
})
