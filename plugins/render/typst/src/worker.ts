import { parentPort, isMainThread } from 'node:worker_threads'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, join, sep } from 'node:path'
import { loadNativeCompiler, type NodeCompiler, type NavigationDocument } from './native-binding.ts'

import { TypstError, type TypstDiagnostic } from './errors.ts'
import {
	validateRenderPage,
	type TypstRenderPageOptions,
	type TypstPageImage,
} from './page-render.ts'
import type { TypstNavigation } from './preview-contract.ts'

export type TypstWorkerInput = Readonly<{
	root: string
	revision: number
	entry: string
	fontPaths?: readonly string[]
	maxOutputBytes: number
}>

export type TypstCompileWorkerInput = TypstWorkerInput & { readonly bindingPath: string }

export type TypstWorkerOutput =
	| Readonly<{
			ok: true
			vector: Uint8Array
			pdf: Uint8Array
			navigation: TypstNavigation
			diagnostics: readonly TypstDiagnostic[]
	  }>
	| Readonly<{
			ok: false
			code: 'COMPILE_FAILED' | 'LIMIT_EXCEEDED'
			diagnostics: readonly TypstDiagnostic[]
	  }>

export type TypstRenderWorkerInput = TypstRenderPageOptions & {
	readonly kind: 'render'
	readonly maxOutputBytes: number
}
let compiled:
	| { document: NavigationDocument; revision: number; navigation: TypstNavigation }
	| undefined
export function renderTypstPage(input: TypstRenderWorkerInput): TypstPageImage {
	validateRenderPage(input)
	if (!compiled || input.revision !== compiled.revision)
		throw new TypstError('STALE_REVISION', 'Requested Typst revision is no longer available')
	validateRenderPage(input, compiled.navigation.pages)
	if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0)
		throw new TypstError('INVALID_INPUT', 'maxOutputBytes must be a positive safe integer')
	let rendered
	try {
		rendered = compiled.document.renderPage(
			input.page,
			input.scale ?? 2,
			input.region,
			input.maxOutputBytes,
		)
	} catch (cause) {
		if (cause instanceof Error && cause.message === 'PNG exceeds configured output byte limit')
			throw new TypstError('LIMIT_EXCEEDED', cause.message, { cause })
		throw cause
	}
	if (rendered.data.byteLength > input.maxOutputBytes)
		throw new TypstError('LIMIT_EXCEEDED', 'PNG exceeds configured output byte limit')
	return { ...rendered, revision: input.revision, page: input.page, format: 'png' }
}

/** Native compiler and shadow VFS survive updates in the document's dedicated thread. */
let retained:
	| {
			root: string
			fonts: string
			compiler: NodeCompiler
			sources: Map<string, { bytes: Buffer; mtime: number; ino: number; size: number }>
	  }
	| undefined
function nativeCompiler(input: TypstCompileWorkerInput) {
	const fonts = JSON.stringify(input.fontPaths)
	if (!retained || retained.root !== input.root || retained.fonts !== fonts) {
		compiled = undefined
		retained = {
			root: input.root,
			fonts,
			compiler: loadNativeCompiler(input.bindingPath).create({
				workspace: input.root,
				fontArgs: input.fontPaths?.length ? [{ fontPaths: [...input.fontPaths] }] : undefined,
			}),
			sources: new Map(),
		}
	}
	const state = retained
	const next = new Map<string, { bytes: Buffer; mtime: number; ino: number; size: number }>()
	function visit(root: string) {
		for (const item of readdirSync(root, { withFileTypes: true })) {
			const path = join(root, item.name)
			if (item.isDirectory()) visit(path)
			else {
				const stat = statSync(path)
				const previous = state.sources.get(path)
				if (
					previous &&
					previous.mtime === stat.mtimeMs &&
					previous.ino === stat.ino &&
					previous.size === stat.size
				) {
					next.set(path, previous)
					continue
				}
				const bytes = readFileSync(path)
				next.set(path, { bytes, mtime: stat.mtimeMs, ino: stat.ino, size: stat.size })
				if (!previous?.bytes.equals(bytes)) state.compiler.mapShadow(path, bytes)
			}
		}
	}
	visit(input.root)
	for (const path of state.sources.keys()) if (!next.has(path)) state.compiler.unmapShadow(path)
	state.sources = next
	return state.compiler
}
export default function compileTypst(input: TypstCompileWorkerInput): TypstWorkerOutput {
	if (!Number.isSafeInteger(input.revision) || input.revision <= 0)
		throw new TypeError('Invalid compile revision')
	if (!Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0) {
		throw new RangeError('Typst maxOutputBytes must be a positive safe integer')
	}
	if (!isAbsolute(input.root)) throw new TypeError('Typst worker root must be absolute')
	const entry = resolve(input.root, input.entry)
	const entryRelative = relative(input.root, entry)
	if (entryRelative === '..' || entryRelative.startsWith(`..${sep}`) || isAbsolute(entryRelative)) {
		throw new TypeError('Typst worker entry must stay inside its workspace')
	}
	const compiler = nativeCompiler(input)
	try {
		const result = compiler.compile({ mainFilePath: entry, resetRead: true })
		// This binding's takeDiagnostics takes errors only; successful warnings have a separate receipt.
		const diagnostics = normalizeDiagnostics(
			[result.takeDiagnostics(), result.takeWarnings()].flatMap((value) =>
				value ? compiler.fetchDiagnostics(value) : [],
			),
			input.root,
		)
		const document = result.result
		if (!document) return { ok: false, code: 'COMPILE_FAILED', diagnostics }
		const navigation = (document as NavigationDocument).navigation()
		const navigationBytes = Buffer.byteLength(JSON.stringify(navigation))
		const vector = compiler.vector(document)
		if (vector.byteLength + navigationBytes > input.maxOutputBytes) {
			return {
				ok: false,
				code: 'LIMIT_EXCEEDED',
				diagnostics: [
					...diagnostics,
					{
						severity: 'error',
						message: 'Typst Vector and navigation exceed the output byte limit',
					},
				],
			}
		}
		const pdf = compiler.pdf(document)
		if (pdf.byteLength > input.maxOutputBytes - vector.byteLength - navigationBytes) {
			return {
				ok: false,
				code: 'LIMIT_EXCEEDED',
				diagnostics: [
					...diagnostics,
					{
						severity: 'error',
						message: 'Typst Vector, PDF and navigation exceed the combined output byte limit',
					},
				],
			}
		}
		compiled = { document: document as NavigationDocument, revision: input.revision, navigation }
		return { ok: true, vector, pdf, navigation, diagnostics }
	} finally {
		// Age out unused native memoized results while preserving recent incremental work.
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
			path: path
				? (isAbsolute(path) ? relative(root, path) : path).replaceAll(sep, '/').slice(0, 4096)
				: undefined,
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

if (!isMainThread && parentPort) {
	parentPort.on('message', (input: TypstCompileWorkerInput | TypstRenderWorkerInput) => {
		try {
			parentPort!.postMessage(
				{ ok: true, value: 'kind' in input ? renderTypstPage(input) : compileTypst(input) },
				[],
			)
		} catch (error) {
			parentPort!.postMessage(
				{ ok: false, error, code: error instanceof TypstError ? error.code : undefined },
				[],
			)
		}
	})
}
