import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	MarkdownError,
	type MarkdownRenderer,
	type MarkdownRenderOptions,
} from '../../src/index.ts'

export class FormulaRejected extends TaggedError('FormulaRejected')<{
	reason: 'invalid_formula' | 'too_large'
}> {}

// Running TypstPlugin supplies the optional math integration.
export async function renderFormulaDocument(
	renderer: MarkdownRenderer,
	markdown: string,
	options?: MarkdownRenderOptions,
): Promise<Result<Awaited<ReturnType<MarkdownRenderer['render']>>, FormulaRejected>> {
	try {
		return Result.ok(await renderer.render(markdown, options))
	} catch (error) {
		if (error instanceof MarkdownError && error.code === 'FORMULA_INVALID') {
			return Result.err(new FormulaRejected({ reason: 'invalid_formula' }))
		}
		if (error instanceof MarkdownError && error.code === 'FORMULA_TOO_LARGE') {
			return Result.err(new FormulaRejected({ reason: 'too_large' }))
		}
		throw error
	}
}
