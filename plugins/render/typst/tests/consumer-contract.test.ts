import { describe, expect, it } from 'vitest'
import { TypstError } from '../src/errors.js'
import { WorkerTaskError } from '@pluxel/services/workers'
import { consumerFailure } from './consumer/server.js'
import { diagnosticPosition, sourceOffset } from './consumer/compile-contract.js'

describe('consumer compile boundary', () => {
	it('projects structured diagnostics and preserves non-Typst failure categories and codes', () => {
		const diagnostic = {
			severity: 'error' as const,
			message: 'invalid token',
			path: 'main.typ',
			range: { start: { line: 0, character: 17 }, end: { line: 0, character: 18 } },
		}
		const failure = consumerFailure(
			new TypstError('COMPILE_FAILED', 'Compilation failed', {
				path: 'main.typ',
				diagnostics: [diagnostic],
			}),
		)
		expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
			kind: 'typst',
			code: 'COMPILE_FAILED',
			path: 'main.typ',
			diagnostics: [diagnostic],
		})
		expect(consumerFailure(new WorkerTaskError('TASK_FAILED', 'worker died'))).toMatchObject({
			kind: 'worker',
			code: 'TASK_FAILED',
			diagnostics: [],
		})
		expect(consumerFailure(new DOMException('cancelled', 'AbortError'))).toMatchObject({
			kind: 'cancelled',
			code: 'AbortError',
		})
		expect(
			consumerFailure(Object.assign(new Error('read failed'), { syscall: 'read', code: 'EIO' })),
		).toMatchObject({ kind: 'io', code: 'EIO' })
		expect(
			consumerFailure(Object.assign(new Error('native failure'), { code: 'NATIVE_PANIC' })),
		).toMatchObject({ kind: 'unexpected', code: 'NATIVE_PANIC' })
		expect(consumerFailure(new TypeError('programming failure'))).toMatchObject({
			kind: 'unexpected',
			code: 'UNEXPECTED',
			name: 'TypeError',
			message: 'programming failure',
		})
		expect(consumerFailure('untyped failure')).toMatchObject({
			kind: 'unexpected',
			code: 'UNEXPECTED',
			message: 'untyped failure',
		})
	})
	it('converts zero-based diagnostics to one-based UTF-16 navigation without byte/codepoint offsets', () => {
		const position = diagnosticPosition({
			severity: 'error',
			message: 'x',
			path: '/main.typ',
			range: { start: { line: 1, character: 3 }, end: { line: 1, character: 4 } },
		})!
		expect(position).toEqual({ path: 'main.typ', line: 2, column: 4 })
		const source = 'first\n😀 x\nlast'
		expect(sourceOffset(source, position)).toBe(source.indexOf('x'))
		expect(diagnosticPosition({ severity: 'warning', message: 'no span' })).toBeUndefined()
		for (const [line, column] of [
			[0, 1],
			[4, 1],
			[1, 0],
			[2, 6],
			[1.5, 1],
			[1, 1.5],
		])
			expect(
				sourceOffset(source, { path: 'main.typ', line: line!, column: column! }),
			).toBeUndefined()
	})
})
