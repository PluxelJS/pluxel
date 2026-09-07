import { describe, expect, it } from 'vitest'
import { TypstMathError } from '../src/errors.ts'
import { compileTypstMathFormula, validateTypstMathFormula } from '../src/formula.ts'
import { createTypstMathWorkerHandler } from '../src/worker.ts'

describe('restricted Typst math formula', () => {
	it('accepts ordinary math but rejects document execution and resource syntax before compiling', () => {
		expect(validateTypstMathFormula('x^2 + y_1 = sqrt(4)', 128)).toBe('x^2 + y_1 = sqrt(4)')
		for (const source of [
			'#let danger = 1',
			'import "package.typ"',
			'include "other.typ"',
			'read("secret")',
			'image("remote.png")',
			'raw("script")',
			'\\sqrt(x)',
			'"string literal"',
		]) {
			expect(() => validateTypstMathFormula(source, 128)).toThrow(
				expect.objectContaining({ code: 'FORMULA_INVALID' }),
			)
		}
		expect(() => validateTypstMathFormula('x'.repeat(129), 128)).toThrow(
			expect.objectContaining({ code: 'FORMULA_TOO_LARGE' }),
		)
	})

	it('builds a fixed-wrapper SVG with no caller path or document options', () => {
		const svg = compileTypstMathFormula('x^2 + y^2 = z^2')
		expect(Buffer.from(svg).toString('utf8', 0, 32)).toContain('<svg')
		expect(svg.byteLength).toBeGreaterThan(1_000)
	})

	it('returns cloneable SVG bytes and structured failures from the worker handler', () => {
		const worker = createTypstMathWorkerHandler()
		const success = worker({
			formula: 'sum_(i=1)^n i',
			maxFormulaCharacters: 128,
			maxSvgBytes: 100_000,
		})
		expect(success).toMatchObject({ ok: true })
		if (!success.ok) throw new Error('Expected Typst worker to return SVG bytes')
		expect(success.svg).toBeInstanceOf(Uint8Array)
		expect(Buffer.from(success.svg).toString('utf8', 0, 32)).toContain('<svg')

		const rejected = worker({
			formula: '#import "unsafe.typ"',
			maxFormulaCharacters: 128,
			maxSvgBytes: 100_000,
		})
		expect(rejected).toEqual({
			ok: false,
			error: expect.objectContaining({ code: 'FORMULA_INVALID' }),
		})

		const oversized = worker({
			formula: 'x',
			maxFormulaCharacters: 128,
			maxSvgBytes: 1,
		})
		expect(oversized).toEqual({
			ok: false,
			error: expect.objectContaining({ code: 'SVG_TOO_LARGE' }),
		})
	})

	it('keeps compiler failures represented by the stable math error type', () => {
		expect(() => validateTypstMathFormula('', 128)).toThrow(TypstMathError)
	})
})
