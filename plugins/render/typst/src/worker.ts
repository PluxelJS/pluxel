import { isAbsolute, relative, resolve } from 'node:path'
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'

import type { TypstDiagnostic } from './errors.ts'

export type TypstWorkerInput = Readonly<{
	root: string
	entry: string
	fontPaths?: readonly string[]
	maxOutputBytes: number
}>

export type TypstWorkerOutput =
	| Readonly<{
			ok: true
			vector: Uint8Array
			pdf: Uint8Array
			diagnostics: readonly TypstDiagnostic[]
	  }>
	| Readonly<{
			ok: false
			code: 'COMPILE_FAILED' | 'LIMIT_EXCEEDED'
			diagnostics: readonly TypstDiagnostic[]
	  }>

/** One native document supplies both outputs; no native state survives this task. */
export default function compileTypst(input: TypstWorkerInput): TypstWorkerOutput {
	if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0) {
		throw new RangeError('Typst maxOutputBytes must be a positive safe integer')
	}
	if (!isAbsolute(input.root)) throw new TypeError('Typst worker root must be absolute')
	const entry = resolve(input.root, input.entry)
	const entryRelative = relative(input.root, entry)
	if (entryRelative === '..' || entryRelative.startsWith('../') || isAbsolute(entryRelative)) {
		throw new TypeError('Typst worker entry must stay inside its workspace')
	}
	const compiler = NodeCompiler.create({
		workspace: input.root,
		fontArgs: input.fontPaths?.length ? [{ fontPaths: [...input.fontPaths] }] : undefined,
	})
	try {
		const result = compiler.compile({ mainFilePath: entry })
		const nativeDiagnostics = result.takeDiagnostics()
		const diagnostics = nativeDiagnostics
			? normalizeDiagnostics(compiler.fetchDiagnostics(nativeDiagnostics), input.root)
			: []
		const document = result.result
		if (!document) return { ok: false, code: 'COMPILE_FAILED', diagnostics }
		const vector = compiler.vector(document)
		if (vector.byteLength > input.maxOutputBytes) {
			return {
				ok: false,
				code: 'LIMIT_EXCEEDED',
				diagnostics: [
					...diagnostics,
					{ severity: 'error', message: 'Typst Vector exceeds the output byte limit' },
				],
			}
		}
		const pdf = compiler.pdf(document)
		if (pdf.byteLength > input.maxOutputBytes - vector.byteLength) {
			return {
				ok: false,
				code: 'LIMIT_EXCEEDED',
				diagnostics: [
					...diagnostics,
					{
						severity: 'error',
						message: 'Typst Vector and PDF exceed the combined output byte limit',
					},
				],
			}
		}
		return { ok: true, vector, pdf, diagnostics }
	} finally {
		// Typst memoization is process-global. Age eviction preserves recent work from
		// other tasks; it is not session disposal or a hard native heap cap.
		compiler.evictCache(10)
	}
}

function normalizeDiagnostics(values: readonly unknown[], root: string): TypstDiagnostic[] {
	const diagnostics = values.slice(0, 128).map((value): TypstDiagnostic => {
		if (!value || typeof value !== 'object') {
			throw new TypeError('Typst returned an invalid diagnostic')
		}
		const item = value as Record<string, unknown>
		if (typeof item.message !== 'string') {
			throw new TypeError('Typst returned a diagnostic without a message')
		}
		const path = typeof item.path === 'string' ? item.path : undefined
		return {
			severity: item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info',
			message: (typeof item.package === 'string' && item.package
				? `[${item.package}] ${item.message}`
				: item.message
			).slice(0, 4096),
			path: path ? (isAbsolute(path) ? relative(root, path) : path).slice(0, 4096) : undefined,
			range: isRange(item.range) ? item.range : undefined,
		}
	})
	if (values.length > 128) {
		diagnostics.push({ severity: 'info', message: `${values.length - 128} diagnostics omitted` })
	}
	return diagnostics
}

function isRange(value: unknown): value is NonNullable<TypstDiagnostic['range']> {
	if (!value || typeof value !== 'object') return false
	const range = value as Record<string, unknown>
	return isPosition(range.start) && isPosition(range.end)
}

function isPosition(value: unknown): value is { line: number; character: number } {
	if (!value || typeof value !== 'object') return false
	const position = value as Record<string, unknown>
	return (
		Number.isSafeInteger(position.line) &&
		(position.line as number) >= 0 &&
		Number.isSafeInteger(position.character) &&
		(position.character as number) >= 0
	)
}
