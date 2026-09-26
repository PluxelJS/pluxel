import { describe, expect, it } from 'vitest'
import { defineCommand, Result } from '../src/index'
import { createArgvRouter, tail, toCli } from '../src/argv'
import { Type, obj } from '../src/typebox'

describe('argv routing', () => {
	it('parses a candidate and executes through the command Result boundary', async () => {
		const echo = defineCommand({
			name: 'text.echo',
			description: 'Return text.',
			input: obj({ text: Type.String() }),
			execute({ text }) {
				return Result.ok(text)
			},
		})
		const router = createArgvRouter()
		const cli = toCli(echo, { routes: ['text echo'], tail: tail.text('text') })
		expect(Object.isFrozen(cli)).toBe(true)
		using binding = router.bind(cli)
		const resolved = router.resolve('text echo hello world')!
		expect(resolved.candidate).toEqual({ text: 'hello world' })
		const result = await resolved.command.execute(resolved.candidate)
		expect(result.isOk() && result.value).toBe('hello world')
		binding.dispose()
		expect(router.resolve('text echo hello world')).toBeUndefined()
	})

	it('keeps syntax failures in the argv boundary', () => {
		const echo = defineCommand({
			name: 'text.echo',
			description: 'Return text.',
			input: obj({ text: Type.String() }),
			execute({ text }) {
				return Result.ok(text)
			},
		})
		const router = createArgvRouter()
		router.bind(toCli(echo, { routes: ['echo'] }))
		expect(() => toCli(echo, { routes: [''] })).toThrow('must bind at least one route')
		expect(() => router.resolve('echo --unknown x')).toThrow('Unknown')
	})
})
