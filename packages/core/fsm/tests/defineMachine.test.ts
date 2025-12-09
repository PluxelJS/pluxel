import { describe, expect, test } from 'bun:test'
import { defineMachine } from '../defineMachine.macro'

describe('defineMachine validation', () => {
	test('rejects duplicate states', () => {
		expect(() =>
			defineMachine({
				states: ['idle', 'idle'] as const,
				events: ['start'] as const,
				init: 'idle',
				transitions: [['idle', 'start', 'idle']] as const,
				impl: { callbacks: {}, hooks: {} },
			}),
		).toThrow(/Duplicate state/)
	})

	test('rejects duplicate events', () => {
		expect(() =>
			defineMachine({
				states: ['idle', 'running'] as const,
				events: ['start', 'start'] as const,
				init: 'idle',
				transitions: [['idle', 'start', 'running']] as const,
				impl: { callbacks: {}, hooks: {} },
			}),
		).toThrow(/Duplicate event/)
	})

	test('rejects duplicate edges when strict mode is on', () => {
		expect(() =>
			defineMachine({
				states: ['idle', 'running'] as const,
				events: ['start'] as const,
				init: 'idle',
				transitions: [
					['idle', 'start', 'running'],
					['idle', 'start', 'idle'],
				] as const,
				impl: { callbacks: {}, hooks: {} },
			}),
		).toThrow(/Duplicate edge/)
	})
})
