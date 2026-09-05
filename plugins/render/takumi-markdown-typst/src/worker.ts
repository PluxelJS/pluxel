import { TypstMathError, type TypstMathErrorCode } from './errors.ts'
import { compileTypstMathFormula, validateTypstMathFormula } from './formula.ts'

export type TypstMathWorkerInput = Readonly<{
	formula: string
	maxFormulaCharacters: number
	maxSvgBytes: number
}>

export type TypstMathWorkerOutput =
	| Readonly<{ ok: true; svg: Uint8Array }>
	| Readonly<{
			ok: false
			error: Readonly<{ code: TypstMathErrorCode; message: string }>
	  }>

export function createTypstMathWorkerHandler(): (
	input: TypstMathWorkerInput,
) => TypstMathWorkerOutput {
	return (input) => {
		try {
			if (
				!input ||
				typeof input !== 'object' ||
				!Number.isSafeInteger(input.maxFormulaCharacters) ||
				!Number.isSafeInteger(input.maxSvgBytes) ||
				input.maxFormulaCharacters <= 0 ||
				input.maxSvgBytes <= 0
			) {
				throw new TypstMathError('FORMULA_INVALID', 'Typst worker input is invalid')
			}
			const formula = validateTypstMathFormula(input.formula, input.maxFormulaCharacters)
			const svg = compileTypstMathFormula(formula)
			if (svg.byteLength > input.maxSvgBytes) {
				throw new TypstMathError(
					'SVG_TOO_LARGE',
					'Typst formula SVG exceeds the configured byte limit',
				)
			}
			return Object.freeze({ ok: true as const, svg })
		} catch (cause) {
			const error =
				cause instanceof TypstMathError
					? cause
					: new TypstMathError('FORMULA_COMPILE_FAILED', 'Typst worker failed unexpectedly', {
							cause,
						})
			return Object.freeze({
				ok: false as const,
				error: Object.freeze({ code: error.code, message: error.message }),
			})
		}
	}
}

export default createTypstMathWorkerHandler()
