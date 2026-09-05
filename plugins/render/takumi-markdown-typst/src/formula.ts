import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'
import { TypstMathError } from './errors.ts'

const ALLOWED_FORMULA = /^[\p{L}\p{N}\p{Sm}\p{Sk}\s()[\]{}.,_!|+\-*/^=<>]+$/u
const FORBIDDEN_IDENTIFIER =
	/(?:^|[^\p{L}\p{N}_])(import|include|read|sys|image|raw|eval|plugin)(?:$|[^\p{L}\p{N}_])/iu

/**
 * Validates the deliberately restricted inline-math dialect before the native compiler sees it.
 * It is not a general Typst document parser: code escapes, strings, paths, imports and resource APIs
 * are intentionally outside the accepted grammar.
 */
export function validateTypstMathFormula(value: unknown, maxCharacters: number): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new TypstMathError('FORMULA_INVALID', 'Typst math formula must be a non-empty string')
	}
	if (value.length > maxCharacters) {
		throw new TypstMathError(
			'FORMULA_TOO_LARGE',
			'Typst math formula exceeds the configured character limit',
		)
	}
	if (!ALLOWED_FORMULA.test(value) || FORBIDDEN_IDENTIFIER.test(value)) {
		throw new TypstMathError(
			'FORMULA_INVALID',
			'Typst math formula uses syntax outside the restricted math dialect',
		)
	}
	return value
}

export function compileTypstMathFormula(formula: string): Uint8Array {
	let compiler: ReturnType<typeof NodeCompiler.create> | undefined
	try {
		compiler = NodeCompiler.create()
		const svg = compiler.plainSvg({
			mainFileContent:
				'#set page(width: auto, height: auto, margin: 0pt)\n#set text(size: 12pt)\n$' +
				formula +
				'$',
		})
		if (!svg.startsWith('<svg')) {
			throw new TypstMathError('FORMULA_COMPILE_FAILED', 'Typst did not produce an SVG document')
		}
		return new Uint8Array(Buffer.from(svg, 'utf8'))
	} catch (cause) {
		if (cause instanceof TypstMathError) throw cause
		throw new TypstMathError('FORMULA_COMPILE_FAILED', 'Typst failed to compile the math formula', {
			cause,
		})
	} finally {
		try {
			compiler?.evictCache(0)
		} catch {
			// The compiler object is per-job; an eviction failure cannot make an otherwise valid SVG unsafe.
		}
	}
}
