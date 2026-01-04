import { describe, expect, it } from 'bun:test'
import { toPlainObject } from '../src/logger/serialization'

class Chatbots {}
class MemeTest {}

describe('logger serialization', () => {
	it('serializes errors arrays into plain values', () => {
		const err = new Error('boom') as any
		err.errors = [{ kind: 'MissingDependency', chain: [Chatbots, MemeTest] }]
		err.aggregateErrors = err.errors

		const out = toPlainObject(err) as any

		expect(Array.isArray(out.errors)).toBe(true)
		expect(Array.isArray(out.aggregateErrors)).toBe(true)

		const chain = out.errors[0].chain
		expect(Array.isArray(chain)).toBe(true)
		expect(typeof chain[0]).toBe('string')
		expect(chain[0]).toContain('Chatbots')
	})
})
