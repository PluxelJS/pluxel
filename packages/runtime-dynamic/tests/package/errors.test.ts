import { describe, expect, it } from 'vitest'
import {
	formatUnknownErrorMessage,
	getUnknownErrorStack,
	normalizeUnknownError,
} from '../../src/package/errors'

describe('package error helpers', () => {
	it('unwraps Error causes for persisted issue message and stack', () => {
		const cause = new Error('inner failure')
		const wrapped = new Error('outer failure', { cause })

		expect(formatUnknownErrorMessage(wrapped)).toBe('inner failure')
		expect(getUnknownErrorStack(wrapped)).toBe(cause.stack)
	})

	it('serializes circular non-Error values without throwing', () => {
		const value: { name: string; self?: unknown } = { name: 'cycle' }
		value.self = value

		expect(normalizeUnknownError(value).message).toBe('{"name":"cycle","self":"[Circular]"}')
	})
})
