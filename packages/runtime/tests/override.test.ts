import { expect, test } from 'bun:test'
import { Context, Injectable, OverrideOf } from '@pluxel/context'
import { MathService } from './MathService'

@OverrideOf(MathService)
@Injectable
class NewMathService {
	add(a: number, b: number): number {
		// override to multiply instead
		return a * b
	}
}

test('Override MathService with new behavior', () => {
	const ctx = new Context()
	const math = ctx.mathService
	expect(math).toBeInstanceOf(NewMathService)
	expect(ctx.add(3, 4)).toBe(12)
})

test('Override then isolate yields separate overridden instances', () => {
	const ctx = new Context()
	const rootInst = ctx.mathService
	expect(rootInst).toBeInstanceOf(NewMathService)
	expect(ctx.add(2, 3)).toBe(6)

	// 3. 隔离上下文也拿到重写实例
	const iso = ctx.isolate([MathService])
	const isoInst = iso.mathService
	expect(isoInst).toBeInstanceOf(NewMathService)
	expect(isoInst).not.toBe(rootInst) // 确保是独立实例
	expect(iso.add(2, 3)).toBe(6)
	expect(iso.mathService).toBe(isoInst)

	const iso2 = ctx.isolate([NewMathService])
	const isoInst2 = iso2.mathService
	expect(isoInst2).toBeInstanceOf(NewMathService)
	expect(isoInst2).not.toBe(rootInst) // 确保是独立实例
	expect(iso2.add(2, 3)).toBe(6)
})
