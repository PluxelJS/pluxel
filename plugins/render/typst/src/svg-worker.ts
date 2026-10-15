import { loadNativeCompiler } from './native-binding.ts'
import type { TypstDiagnostic } from './errors.ts'

export interface TypstSvgWorkerInput {
	readonly source: string
	readonly bindingPath: string
	readonly fonts: readonly Uint8Array[]
	readonly maxOutputBytes: number
}

export type TypstSvgWorkerOutput =
	| { readonly ok: true; readonly data: Uint8Array }
	| {
			readonly ok: false
			readonly code: 'COMPILE_FAILED' | 'LIMIT_EXCEEDED'
			readonly diagnostics: readonly TypstDiagnostic[]
	  }

/** One trusted source, one compiler, no retained document or file workspace. */
export default function renderTypstSvg(input: TypstSvgWorkerInput): TypstSvgWorkerOutput {
	const compiler = loadNativeCompiler(input.bindingPath).create({
		fontArgs:
			input.fonts.length > 0
				? [
						{
							fontBlobs: input.fonts.map((font) =>
								Buffer.from(font.buffer, font.byteOffset, font.byteLength),
							),
						},
					]
				: undefined,
	})
	try {
		const result = compiler.compile({ mainFileContent: input.source })
		const document = result.result
		if (!document) {
			const native = result.takeDiagnostics()
			const diagnostics: TypstDiagnostic[] = native
				? compiler
						.fetchDiagnostics(native)
						.slice(0, 128)
						.map((diagnostic) => ({
							severity:
								diagnostic.severity === 1
									? 'error'
									: diagnostic.severity === 2
										? 'warning'
										: 'info',
							message: diagnostic.message.slice(0, 4096),
						}))
				: []
			return { ok: false, code: 'COMPILE_FAILED', diagnostics }
		}
		const svg = compiler.plainSvg(document)
		if (Buffer.byteLength(svg, 'utf8') > input.maxOutputBytes)
			return {
				ok: false,
				code: 'LIMIT_EXCEEDED',
				diagnostics: [{ severity: 'error', message: 'Typst SVG exceeds the output byte limit' }],
			}
		return { ok: true, data: new Uint8Array(Buffer.from(svg, 'utf8')) }
	} finally {
		// This compiler is per job; do not retain memoized native documents in the shared worker.
		compiler.evictCache(0)
	}
}
