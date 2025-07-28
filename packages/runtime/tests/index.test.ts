import { expect, test } from 'bun:test'
import { Context } from '@pluxel/context'
import { MathService } from './MathService'

test('MathService injection and functionality', () => {
	const ctx = new Context({ mathService: { foo: 'bar' } })
	const math = ctx.mathService
	expect(math).toBeInstanceOf(MathService)
	expect(math.add(2, 3)).toBe(5)
	expect(math.getConfig()).toEqual({ foo: 'bar' })
})

test('Method delegation on Context', () => {
	const ctx = new Context()
	// Context.prototype.add delegates to MathService.add
	expect(ctx.add(4, 5)).toBe(9)
})

test('Context.extend shares service instances', () => {
	const ctx = new Context()
	const inst1 = ctx.mathService
	const child = ctx.extend()
	const inst2 = child.mathService
	expect(inst1).toBe(inst2)
})

test('Context.isolate creates a separate instance for specified services', () => {
	const ctx = new Context()
	const inst1 = ctx.mathService
	const iso = ctx.isolate([MathService])
	const inst2 = iso.mathService
	expect(inst2).toBeInstanceOf(MathService)
	expect(inst2).not.toBe(inst1)

	// Subsequent calls on iso yield the same isolated instance
	const inst3 = iso.mathService
	expect(inst3).toBe(inst2)
})
