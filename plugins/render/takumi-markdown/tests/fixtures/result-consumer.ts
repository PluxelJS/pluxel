import { Result, TaggedError } from '@pluxel/core/better-result'
import {
	MarkdownError,
	type MarkdownRenderer,
	type MarkdownRenderOptions,
} from '../../src/index.ts'

export class DocumentTooLarge extends TaggedError('DocumentTooLarge')<{ message: string }> {}

export async function renderDocument(
	renderer: MarkdownRenderer,
	markdown: string,
	options?: MarkdownRenderOptions,
): Promise<Result<Awaited<ReturnType<MarkdownRenderer['render']>>, DocumentTooLarge>> {
	try {
		return Result.ok(await renderer.render(markdown, options))
	} catch (error) {
		if (error instanceof MarkdownError && error.code === 'MARKDOWN_TOO_LARGE') {
			return Result.err(new DocumentTooLarge({ message: 'Shorten the Markdown document.' }))
		}
		throw error
	}
}
