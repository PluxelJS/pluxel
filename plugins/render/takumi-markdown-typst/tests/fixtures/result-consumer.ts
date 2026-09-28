import { Result, TaggedError } from '@pluxel/core/better-result'
import type { TakumiRenderResult } from '@pluxel/takumi'
import type { MarkdownRenderer, MarkdownRenderInput } from '@pluxel/takumi-markdown'
import { TypstMathError } from '../../src/index.ts'

export class FormulaRejected extends TaggedError('FormulaRejected')<{
	reason: 'invalid_formula' | 'too_large'
}> {}

// The renderer must be created with typst.createMarkdownExtension().
export async function renderFormulaDocument(
	renderer: MarkdownRenderer,
	input: MarkdownRenderInput,
): Promise<Result<TakumiRenderResult, FormulaRejected>> {
	try {
		return Result.ok(await renderer.render(input))
	} catch (error) {
		if (error instanceof TypstMathError && error.code === 'FORMULA_INVALID') {
			return Result.err(new FormulaRejected({ reason: 'invalid_formula' }))
		}
		if (error instanceof TypstMathError && error.code === 'FORMULA_TOO_LARGE') {
			return Result.err(new FormulaRejected({ reason: 'too_large' }))
		}
		throw error
	}
}
