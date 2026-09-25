import { Result, TaggedError } from '@pluxel/core/better-result'
import type { TakumiRenderResult } from '@pluxel/takumi'
import { MarkdownError, type MarkdownRenderer, type MarkdownRenderInput } from '../../src/index.ts'

export class DocumentTooLarge extends TaggedError('DocumentTooLarge')<{ message: string }> {}

export async function renderDocument(
	renderer: MarkdownRenderer,
	input: MarkdownRenderInput,
): Promise<Result<TakumiRenderResult, DocumentTooLarge>> {
	try {
		return Result.ok(await renderer.render(input))
	} catch (error) {
		if (error instanceof MarkdownError && error.code === 'MARKDOWN_TOO_LARGE') {
			return Result.err(new DocumentTooLarge({ message: 'Shorten the Markdown document.' }))
		}
		throw error
	}
}
