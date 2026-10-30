import type { JSONContent } from '@tiptap/core'
import type { AstExpr } from '@r4ai/typst-ast-node'
import { projectTypstSource } from './project.js'
import { parseTypstSource } from './parse.js'
import { prepareTypstSourceEdit } from './writeback.js'
import type {
	TypstPreparedSourceEdit,
	TypstSourceFiles,
	TypstSourceProject,
	TypstSourceProjectOptions,
	TypstSourceSnapshot,
} from './state-types.js'
import type {
	TypstSourceDiagnostic,
	TypstSourceParser,
	TypstSourcePatch,
	TypstParsedProjection,
	TypstSourceResult,
} from './types.js'

type Files = Record<string, string | Uint8Array>
type Change = { path: string; before: string | Uint8Array; after: string | Uint8Array }
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const HISTORY_LIMIT = 100

export class TypstSourceProjectError extends Error {
	constructor(
		readonly code: 'INVALID_PATH' | 'NOT_FOUND' | 'INVALID_SOURCE',
		message: string,
	) {
		super(message)
		this.name = 'TypstSourceProjectError'
	}
}

function validPath(path: string): boolean {
	return (
		typeof path === 'string' &&
		!!path &&
		!path.includes('\\') &&
		!path.includes('\0') &&
		path.split('/').every((part) => !!part && part !== '.' && part !== '..')
	)
}

function copyFiles(input: TypstSourceFiles): Files {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypstSourceProjectError('INVALID_SOURCE', 'files must be a project-relative file map')
	const files: Files = Object.create(null)
	for (const [path, value] of Object.entries(input)) {
		if (!validPath(path))
			throw new TypstSourceProjectError('INVALID_PATH', `Invalid project file path: ${path}`)
		if (typeof value === 'string') {
			if (!value.isWellFormed())
				throw new TypstSourceProjectError(
					'INVALID_SOURCE',
					`${path}: text contains an unpaired surrogate`,
				)
			files[path] = value
		} else if (value instanceof Uint8Array) files[path] = value.slice()
		else throw new TypstSourceProjectError('INVALID_SOURCE', `${path}: expected text or Uint8Array`)
	}
	for (const path of Object.keys(files)) {
		let separator = path.indexOf('/')
		while (separator >= 0) {
			if (Object.hasOwn(files, path.slice(0, separator)))
				throw new TypstSourceProjectError('INVALID_PATH', `${path}: a parent path is a file`)
			separator = path.indexOf('/', separator + 1)
		}
	}
	return files
}

function textFile(files: TypstSourceFiles, path: string): string {
	if (!validPath(path))
		throw new TypstSourceProjectError('INVALID_PATH', `Invalid project file path: ${path}`)
	if (!Object.hasOwn(files, path))
		throw new TypstSourceProjectError('NOT_FOUND', `File does not exist: ${path}`)
	const value = files[path]
	if (typeof value === 'string') return value
	try {
		return decoder.decode(value)
	} catch {
		throw new TypstSourceProjectError('INVALID_SOURCE', `${path}: file is not valid UTF-8 text`)
	}
}

function equalFile(
	a: string | Uint8Array | undefined,
	b: string | Uint8Array | undefined,
): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false
	const left = typeof a === 'string' ? encoder.encode(a) : a
	const right = typeof b === 'string' ? encoder.encode(b) : b
	return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function boundary(bytes: Uint8Array, offset: number): boolean {
	return (
		Number.isSafeInteger(offset) &&
		offset >= 0 &&
		offset <= bytes.length &&
		(offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80)
	)
}

/** The runtime-selected parser is injected once; this module has no Node or WASM initialization. */
export function createTypstSourceProjectState(
	options: TypstSourceProjectOptions,
	parser: TypstSourceParser,
): TypstSourceProject {
	let files = copyFiles(options.files)
	let revision = 0
	const components = Object.freeze(
		structuredClone(options.components ?? []).map((component) =>
			Object.freeze({
				...component,
				parameters: Object.freeze(
					Object.fromEntries(
						Object.entries(component.parameters).map(([name, parameter]) => [
							name,
							Object.freeze(parameter),
						]),
					),
				),
			}),
		),
	)
	const writable = options.writablePaths === undefined ? undefined : new Set(options.writablePaths)
	for (const path of writable ?? []) {
		if (!validPath(path) || !Object.hasOwn(files, path))
			throw new TypstSourceProjectError('INVALID_PATH', `Writable path does not exist: ${path}`)
	}
	const cache = new Map<string, TypstParsedProjection>()
	const past: Change[][] = []
	const future: Change[][] = []
	const listeners = new Set<() => void>()
	const snapshot = (): TypstSourceSnapshot => {
		const detached: Files = Object.create(null)
		for (const [path, value] of Object.entries(files)) {
			Object.defineProperty(
				detached,
				path,
				typeof value === 'string'
					? { enumerable: true, value }
					: { enumerable: true, get: () => value.slice() },
			)
		}
		return { revision, files: Object.freeze(detached) }
	}
	const issue = (
		code: TypstSourceDiagnostic['code'],
		message: string,
		path = '',
		from = 0,
		to = from,
	): TypstSourceDiagnostic => ({ code, message, path, from, to, revision, severity: 'error' })
	const fail = <T>(
		code: TypstSourceDiagnostic['code'],
		message: string,
		path = '',
		from = 0,
		to = from,
	): TypstSourceResult<T> => ({ ok: false, issues: [issue(code, message, path, from, to)] })
	const checkRevision = (base: number) =>
		base === revision
			? undefined
			: issue('CONFLICT', `Source revision ${base} is stale; current revision is ${revision}`)
	const currentProjection = (path: string): TypstParsedProjection => {
		const source = textFile(files, path)
		let cached = cache.get(path)
		if (!cached || cached.source !== source) {
			cached = projectTypstSource({ path, source, revision, parser, files, components })
			cache.set(path, cached)
		}
		return cached.revision === revision
			? cached
			: {
					...cached,
					revision,
					// Keep diagnostics from already returned revisions immutable.
					diagnostics: cached.diagnostics.map((entry) => Object.assign({}, entry, { revision })),
				}
	}
	const projections = (candidate?: Files, currentPath?: string): TypstParsedProjection[] => {
		const changed = new Set(
			candidate
				? Object.keys(candidate).filter((path) => !equalFile(candidate[path], files[path]))
				: [],
		)
		return Object.keys(candidate ?? files)
			.filter((path) => path.endsWith('.typ') || path === currentPath)
			.flatMap((path) => {
				try {
					const source = textFile(candidate ?? files, path)
					return [
						candidate &&
						(changed.has(path) || (cache.has(path) && importsChanged(cache.get(path)!, changed)))
							? projectTypstSource({ path, source, revision, parser, files: candidate, components })
							: currentProjection(path),
					]
				} catch (error) {
					if (error instanceof TypstSourceProjectError) return []
					throw error
				}
			})
	}
	const projectIssues = (values: TypstParsedProjection[]): TypstSourceDiagnostic[] => {
		const diagnostics = values.flatMap((value) => value.diagnostics)
		const labels = values.flatMap((value) => value.labels)
		const counts = new Map<string, number>()
		for (const label of labels) counts.set(label.label, (counts.get(label.label) ?? 0) + 1)
		for (const label of labels)
			if ((counts.get(label.label) ?? 0) > 1)
				diagnostics.push(
					issue(
						'DUPLICATE_LABEL',
						`Label <${label.label}> has multiple source declarations`,
						label.path,
						label.from,
						label.to,
					),
				)
		for (const reference of values.flatMap((value) => value.references))
			if (!counts.has(reference.label))
				diagnostics.push({
					...issue(
						'UNRESOLVED_REFERENCE',
						`No static declaration for @${reference.label}; bibliography or generated targets are checked by Typst`,
						reference.path,
						reference.from,
						reference.to,
					),
					severity: 'warning',
				})
		return diagnostics
	}
	const notify = () => {
		// A callback may remove or add subscriptions; notify the captured listeners only.
		const captured = [...listeners]
		for (const listener of captured) {
			try {
				listener()
			} catch (error) {
				queueMicrotask(() => {
					throw error
				})
			}
		}
	}
	const accept = (
		next: Files,
		changes: Change[],
		history: boolean,
	): TypstSourceResult<TypstSourceSnapshot> => {
		if (changes.length === 0) return { ok: true, value: snapshot() }
		const changedPaths = new Set(changes.map((change) => change.path))
		for (const [path, projection] of cache) {
			if (changedPaths.has(path) || importsChanged(projection, changedPaths)) cache.delete(path)
		}
		files = next
		revision++
		if (history) {
			past.push(changes)
			if (past.length > HISTORY_LIMIT) past.shift()
			future.length = 0
		}
		const value = snapshot()
		notify()
		return { ok: true, value }
	}
	const candidate = (
		patches: readonly TypstSourcePatch[],
	): TypstSourceResult<{ files: Files; changes: Change[] }> => {
		if (!Array.isArray(patches)) return fail('INVALID_PATCH', 'patches must be an array')
		const byPath = new Map<string, TypstSourcePatch[]>()
		for (const patch of patches) {
			if (!patch || !validPath(patch.path))
				return fail(
					'INVALID_PATH',
					'Patch requires a canonical project-relative path',
					patch?.path ?? '',
				)
			if (!Object.hasOwn(files, patch.path))
				return fail('NOT_FOUND', 'Patch file does not exist', patch.path)
			if (writable && !writable.has(patch.path))
				return fail('READ_ONLY', 'File is read-only', patch.path)
			if (typeof patch.text !== 'string' || !patch.text.isWellFormed())
				return fail('INVALID_PATCH', 'Patch text must be well-formed Unicode', patch.path)
			const list = byPath.get(patch.path) ?? []
			list.push(patch)
			byPath.set(patch.path, list)
		}
		const next = { ...files }
		const changes: Change[] = []
		for (const [path, edits] of byPath) {
			let source: string
			try {
				source = textFile(files, path)
			} catch (error) {
				if (error instanceof TypstSourceProjectError) return fail(error.code, error.message, path)
				throw error
			}
			const bytes = encoder.encode(source)
			const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to)
			for (let index = 0; index < sorted.length; index++) {
				const patch = sorted[index]
				if (!boundary(bytes, patch.from) || !boundary(bytes, patch.to) || patch.to < patch.from)
					return fail(
						'INVALID_PATCH',
						'Patch range must use complete UTF-8 character boundaries',
						path,
						patch.from,
						patch.to,
					)
				const previous = sorted[index - 1]
				if (previous && (patch.from < previous.to || patch.from === previous.from))
					return fail(
						'INVALID_PATCH',
						'Patch ranges overlap or have an ambiguous insertion order',
						path,
						patch.from,
						patch.to,
					)
			}
			let text = ''
			let cursor = 0
			for (const patch of sorted) {
				text += decoder.decode(bytes.subarray(cursor, patch.from)) + patch.text
				cursor = patch.to
			}
			text += decoder.decode(bytes.subarray(cursor))
			const after = typeof files[path] === 'string' ? text : encoder.encode(text)
			if (!equalFile(files[path], after)) {
				changes.push({ path, before: files[path], after })
				next[path] = after
			}
		}
		return { ok: true, value: { files: next, changes } }
	}
	const apply: TypstSourceProject['apply'] = ({ baseRevision, patches }) => {
		const conflict = checkRevision(baseRevision)
		if (conflict) return { ok: false, issues: [conflict] }
		const checked = candidate(patches)
		return checked.ok ? accept(checked.value.files, checked.value.changes, true) : checked
	}
	const renamePatches = (
		values: TypstParsedProjection[],
		from: string,
		to: string,
	): TypstSourceResult<TypstSourcePatch[]> => {
		if (typeof to !== 'string' || !to || !to.isWellFormed())
			return fail('INVALID_EDIT', 'Label must be non-empty well-formed text')
		const labelSource = `<${to}>`
		const parsedLabel = projectTypstSource({
			path: 'label.typ',
			revision,
			source: labelSource,
			parser,
		})
		if (
			parsedLabel.diagnostics.some((entry) => entry.severity === 'error') ||
			parsedLabel.labels.length !== 1 ||
			parsedLabel.labels[0].label !== to ||
			parsedLabel.labels[0].from !== 0 ||
			parsedLabel.labels[0].to !== encoder.encode(labelSource).length
		)
			return fail('INVALID_EDIT', 'Expected one native Typst label name')
		const labels = values.flatMap((value) => value.labels)
		const declarations = labels.filter((label) => label.label === from)
		if (declarations.length === 0)
			return fail('NOT_FOUND', `No static label declaration for <${from}>`)
		if (declarations.length !== 1)
			return fail(
				'DUPLICATE_LABEL',
				`Cannot rename ambiguous label <${from}>`,
				declarations[0].path,
				declarations[0].from,
				declarations[0].to,
			)
		if (from === to) return { ok: true, value: [] }
		const collision = labels.find((label) => label.label === to)
		if (collision)
			return fail(
				'DUPLICATE_LABEL',
				`Label <${to}> already exists`,
				collision.path,
				collision.from,
				collision.to,
			)
		return {
			ok: true,
			value: [
				...declarations.map(({ path, from: start, to: end }) => ({
					path,
					from: start,
					to: end,
					text: `<${to}>`,
				})),
				...values
					.flatMap((value) => value.references)
					.filter((ref) => ref.label === from)
					.map(({ path, from: start, to: end, syntax }) => ({
						path,
						from: start,
						to: end,
						text: syntax === 'label' ? `<${to}>` : `@${to}`,
					})),
			],
		}
	}
	const prepareEdit: TypstSourceProject['prepareEdit'] = ({ projection, document }) => {
		const conflict = checkRevision(projection.revision as number)
		if (conflict) return { ok: false, issues: [conflict] }
		let current: TypstParsedProjection
		try {
			current = currentProjection(projection.path)
		} catch (error) {
			if (error instanceof TypstSourceProjectError)
				return fail(error.code, error.message, projection.path)
			throw error
		}
		if (current.source !== projection.source)
			return fail('CONFLICT', 'Projection source differs from the current file', projection.path)
		const prepared = prepareTypstSourceEdit(current, document)
		if (!prepared.ok) return prepared
		let patches = prepared.value
		const checked = candidate(patches)
		if (!checked.ok) return checked
		const renames = changedLabels(current.document, document)
		if (renames.length > 0) {
			const before = projections(undefined, current.path)
			const after = projections(checked.value.files, current.path)
			const additions: TypstSourcePatch[] = []
			for (const { from, to } of renames) {
				const renamed = renamePatches(before, from, to)
				if (!renamed.ok) return renamed
				for (const reference of after.flatMap((value) => value.references)) {
					if (reference.label === from)
						additions.push({
							path: reference.path,
							from: reference.from,
							to: reference.to,
							text: reference.syntax === 'label' ? `<${to}>` : `@${to}`,
						})
				}
			}
			// Compose the already validated edit and reference changes in candidate coordinates.
			const composed = { ...checked.value.files }
			for (const path of new Set(additions.map((patch) => patch.path))) {
				const bytes = encoder.encode(textFile(composed, path))
				let value = textFile(composed, path)
				for (const patch of additions
					.filter((entry) => entry.path === path)
					.sort((a, b) => b.from - a.from))
					value =
						decoder.decode(bytes.subarray(0, patch.from)) +
						patch.text +
						value.slice(decoder.decode(bytes.subarray(0, patch.to)).length)
				composed[path] = typeof composed[path] === 'string' ? value : encoder.encode(value)
			}
			patches = Object.keys(composed).flatMap((path) =>
				equalFile(files[path], composed[path])
					? []
					: [minimalPatch(path, textFile(files, path), textFile(composed, path))],
			)
		}
		const final = candidate(patches)
		if (!final.ok) return final
		const beforeCounts = new Map<string, number>()
		const beforeProjections = projections(undefined, current.path)
		for (const label of beforeProjections.flatMap((value) => value.labels))
			beforeCounts.set(label.label, (beforeCounts.get(label.label) ?? 0) + 1)
		const finalProjections = projections(final.value.files, current.path)
		const syntaxErrors = finalProjections
			.filter((value) => !equalFile(files[value.path], final.value.files[value.path]))
			.flatMap((value) => value.diagnostics)
			.filter(
				(entry) =>
					entry.severity === 'error' && !retainedSyntaxError(entry, beforeProjections, patches),
			)
		if (syntaxErrors.length > 0) return { ok: false, issues: syntaxErrors }
		const actualDocument = finalProjections.find((value) => value.path === current.path)!.document
		const opaqueSources = (root: JSONContent) => {
			const counts = new Map<string, number>()
			const visit = (node: JSONContent) => {
				if (node.type === 'typstSource' || node.type === 'typstInlineSource') {
					const source = String(node.attrs?.source)
					counts.set(source, (counts.get(source) ?? 0) + 1)
				}
				node.content?.forEach(visit)
			}
			visit(root)
			return counts
		}
		const requestedSources = opaqueSources(document)
		// Syntax-valid relocation can still shadow an import or `json`. Declared
		// controls must retain their verified module/data meaning after reprojection.
		const bindings = (root: JSONContent) => {
			const counts = new Map<string, number>()
			const visit = (node: JSONContent) => {
				const attrs = node.attrs ?? {}
				const identity =
					node.type === 'typstField'
						? [node.type, attrs.file, attrs.path]
						: node.type === 'typstComponent'
							? [
									node.type,
									attrs.module,
									attrs.name,
									Object.entries(attrs.props ?? {}).sort(([a], [b]) => a.localeCompare(b)),
									attrs.binding?.file ?? null,
								]
							: undefined
				if (identity) {
					const key = JSON.stringify(identity)
					counts.set(key, (counts.get(key) ?? 0) + 1)
				}
				node.content?.forEach(visit)
			}
			visit(root)
			return counts
		}
		const actualBindings = bindings(actualDocument)
		if ([...bindings(document)].some(([key, count]) => (actualBindings.get(key) ?? 0) < count))
			return fail(
				'UNSUPPORTED_EDIT',
				'This edit changes a declared component or field binding through its source scope; edit the native source explicitly',
				current.path,
				0,
				encoder.encode(current.source).length,
			)
		if (
			[...opaqueSources(actualDocument)].some(
				([source, count]) => (requestedSources.get(source) ?? 0) < count,
			)
		)
			return fail(
				'UNSUPPORTED_EDIT',
				'This edit creates an unconfirmed source expression, possibly through a shadowed name; edit the native source explicitly',
				current.path,
				0,
				encoder.encode(current.source).length,
			)
		const finalLabels = finalProjections.flatMap((value) => value.labels)
		const newDuplicates = finalLabels
			.filter(
				(label) =>
					finalLabels.filter((other) => other.label === label.label).length >
					Math.max(1, beforeCounts.get(label.label) ?? 0),
			)
			.map((label) =>
				issue(
					'DUPLICATE_LABEL',
					`Label <${label.label}> has multiple source declarations`,
					label.path,
					label.from,
					label.to,
				),
			)
		if (newDuplicates.length > 0) return { ok: false, issues: newDuplicates }
		return {
			ok: true,
			value: { baseRevision: revision, patches } satisfies TypstPreparedSourceEdit,
		}
	}
	const transfer = (input: {
		baseRevision: number
		path: string
		from: number
		to: number
		toPath: string
		at: number
		copy: boolean
	}): TypstSourceResult<TypstSourceSnapshot> => {
		const conflict = checkRevision(input.baseRevision)
		if (conflict) return { ok: false, issues: [conflict] }
		let source: TypstParsedProjection, destination: TypstParsedProjection
		try {
			source = currentProjection(input.path)
			destination = currentProjection(input.toPath)
		} catch (error) {
			if (error instanceof TypstSourceProjectError)
				return fail(error.code, error.message, input.path)
			throw error
		}
		const sourceBytes = encoder.encode(source.source),
			destinationBytes = encoder.encode(destination.source)
		if (
			!boundary(sourceBytes, input.from) ||
			!boundary(sourceBytes, input.to) ||
			input.from >= input.to ||
			!boundary(destinationBytes, input.at)
		)
			return fail(
				'INVALID_PATCH',
				'Move/copy requires complete UTF-8 source ranges',
				input.path,
				input.from,
				input.to,
			)
		if (!source.editable || !destination.editable)
			return fail(
				'UNSUPPORTED_EDIT',
				'Repair syntax errors before moving structured content',
				input.path,
				input.from,
				input.to,
			)
		const selected = source.origins.filter(
			(origin) => origin.from < input.to && origin.to > input.from,
		)
		if (
			selected.length === 0 ||
			selected.some((origin) => origin.from < input.from || origin.to > input.to)
		)
			return fail(
				'UNSUPPORTED_EDIT',
				'Select complete top-level source blocks to move/copy',
				input.path,
				input.from,
				input.to,
			)
		if (destination.origins.some((origin) => origin.from < input.at && input.at < origin.to))
			return fail(
				'UNSUPPORTED_EDIT',
				'Destination must be between top-level source blocks',
				input.toPath,
				input.at,
			)
		if (input.path === input.toPath) {
			if (!input.copy && (input.at === input.from || input.at === input.to))
				return { ok: true, value: snapshot() }
			if (!input.copy && input.at > input.from && input.at < input.to)
				return fail(
					'INVALID_EDIT',
					'Cannot move a target inside itself',
					input.path,
					input.from,
					input.to,
				)
			const low = Math.min(input.from, input.at),
				high = Math.max(input.to, input.at)
			if (
				source.parsed.ast.some(
					(expr) =>
						environmentKinds.has(expr.kind) &&
						expr.range &&
						expr.range[0] >= low &&
						expr.range[0] < high,
				)
			)
				return fail(
					'UNSUPPORTED_EDIT',
					'Moving across environment statements can change scope; use an explicit source edit',
					input.path,
					low,
					high,
				)
		}
		if (
			input.path !== input.toPath &&
			[
				{ projection: source, at: input.from },
				{ projection: destination, at: input.at },
			].some(({ projection, at }) =>
				projection.parsed.ast.some(
					(expr) => expr.range && expr.range[0] < at && ['setRule', 'showRule'].includes(expr.kind),
				),
			)
		)
			return fail(
				'UNSUPPORTED_EDIT',
				'Moving between different environment statements requires an explicit source edit',
				input.path,
				input.from,
				input.to,
			)

		const fragment = decoder.decode(sourceBytes.subarray(input.from, input.to))
		const fragmentParsed = parseTypstSource(fragment, parser)
		let relocation: ReturnType<typeof portableFragment>
		try {
			relocation = portableFragment(fragmentParsed.ast, input.path, input.toPath, files, {
				source,
				destination,
				from: input.from,
				at: input.at,
			})
			const bindings = new Set([
				...boundNames(source.parsed.ast, input.from),
				...boundNames(destination.parsed.ast, input.at),
			])
			if (bindings.has('*') || [...relocation.names].some((name) => bindings.has(name)))
				throw new UnsafeSourceTransfer(
					'A moved expression uses a shadowed or imported name; edit the source with its scope explicitly',
				)
		} catch (error) {
			if (error instanceof UnsafeSourceTransfer)
				return fail('UNSUPPORTED_EDIT', error.message, input.path, input.from, input.to)
			throw error
		}
		const edits = relocation.patches
		if (input.copy) {
			const known = new Set(
				projections().flatMap((value) => value.labels.map((label) => label.label)),
			)
			const renamed = new Map<string, string>()
			for (const label of source.labels
				.filter((value) => value.from >= input.from && value.to <= input.to)
				.map((value) => ({
					label: value.label,
					from: value.from - input.from,
					to: value.to - input.from,
				}))) {
				if (renamed.has(label.label))
					return fail(
						'DUPLICATE_LABEL',
						`Copied source contains duplicate <${label.label}>`,
						input.path,
						input.from + label.from,
						input.from + label.to,
					)
				let name = `${label.label}-copy`,
					suffix = 2
				while (known.has(name)) name = `${label.label}-copy-${suffix++}`
				known.add(name)
				renamed.set(label.label, name)
				edits.push({ path: input.path, from: label.from, to: label.to, text: `<${name}>` })
			}
			for (const reference of source.references
				.filter((value) => value.from >= input.from && value.to <= input.to)
				.map((value) => ({
					label: value.label,
					syntax: value.syntax,
					from: value.from - input.from,
					to: value.to - input.from,
				}))) {
				const label = renamed.get(reference.label)
				if (label)
					edits.push({
						path: input.path,
						from: reference.from,
						to: reference.to,
						text: reference.syntax === 'label' ? `<${label}>` : `@${label}`,
					})
			}
		}
		const moved = patchText(fragment, edits)
		const newline = destination.source.includes('\r\n') ? '\r\n' : '\n'
		const patches: TypstSourcePatch[] = [
			...(input.copy ? [] : [{ path: input.path, from: input.from, to: input.to, text: '' }]),
			{
				path: input.toPath,
				from: input.at,
				to: input.at,
				text: `${newline}${newline}${moved}${newline}${newline}`,
			},
		]
		const checked = candidate(patches)
		if (!checked.ok) return checked
		const errors = projections(checked.value.files)
			.filter((value) => !equalFile(files[value.path], checked.value.files[value.path]))
			.flatMap((value) => value.diagnostics)
			.filter((entry) => entry.severity === 'error')
		if (errors.length > 0) return { ok: false, issues: errors }
		return accept(checked.value.files, checked.value.changes, true)
	}
	return {
		get components() {
			return components
		},
		get revision() {
			return revision
		},
		get canUndo() {
			return past.length > 0
		},
		get canRedo() {
			return future.length > 0
		},
		snapshot,
		open: (path) => {
			const {
				path: file,
				revision: sourceRevision,
				source,
				document,
				mapping,
				diagnostics,
				labels,
				references,
				editable,
			} = currentProjection(path)
			return structuredClone({
				path: file,
				revision: sourceRevision,
				source,
				document,
				mapping,
				diagnostics,
				labels,
				references,
				editable,
			})
		},
		diagnostics: () => {
			const diagnostics = projectIssues(projections())
			for (const path of Object.keys(files).filter((entry) => entry.endsWith('.typ'))) {
				try {
					textFile(files, path)
				} catch (error) {
					if (error instanceof TypstSourceProjectError)
						diagnostics.push(issue(error.code, error.message, path))
					else throw error
				}
			}
			return diagnostics
		},
		prepareEdit,
		edit: (input) => {
			const prepared = prepareEdit(input)
			return prepared.ok ? apply(prepared.value) : prepared
		},
		apply,
		renameLabel: ({ baseRevision, from, to }) => {
			const conflict = checkRevision(baseRevision)
			if (conflict) return { ok: false, issues: [conflict] }
			const prepared = renamePatches(projections(), from, to)
			return prepared.ok ? apply({ baseRevision, patches: prepared.value }) : prepared
		},
		move: ({ baseRevision, path, label, toPath, at }) => {
			const conflict = checkRevision(baseRevision)
			if (conflict) return { ok: false, issues: [conflict] }
			const labels = projections()
				.flatMap((value) => value.labels)
				.filter((value) => value.label === label)
			if (labels.length !== 1)
				return fail(
					labels.length > 0 ? 'DUPLICATE_LABEL' : 'NOT_FOUND',
					`Expected one static target for <${label}>`,
					path,
				)
			const target = labels[0]
			if (target.path !== path || !target.target)
				return fail(
					'UNSUPPORTED_EDIT',
					'Label has no confirmed movable target in this file',
					path,
					target.from,
					target.to,
				)
			return transfer({
				baseRevision,
				path,
				from: target.target.from,
				to: target.target.to,
				toPath,
				at,
				copy: false,
			})
		},
		copy: (input) => transfer({ ...input, copy: true }),
		undo: () => {
			const changes = past.at(-1)
			if (!changes) return fail('NO_HISTORY', 'No source transaction to undo')
			const next = { ...files }
			for (const change of changes) next[change.path] = change.before
			past.pop()
			future.push(changes)
			return accept(next, changes, false)
		},
		redo: () => {
			const changes = future.at(-1)
			if (!changes) return fail('NO_HISTORY', 'No source transaction to redo')
			const next = { ...files }
			for (const change of changes) next[change.path] = change.after
			future.pop()
			past.push(changes)
			return accept(next, changes, false)
		},
		replace: ({ baseRevision, files: replacement }) => {
			const conflict = checkRevision(baseRevision)
			if (conflict) return { ok: false, issues: [conflict] }
			let next: Files
			try {
				next = copyFiles(replacement)
			} catch (error) {
				if (error instanceof TypstSourceProjectError) return fail(error.code, error.message)
				throw error
			}
			const sourceChanged = new Set([...Object.keys(files), ...Object.keys(next)])
			if (
				[...sourceChanged].some(
					(path) => path.endsWith('.typ') && !equalFile(files[path], next[path]),
				)
			)
				cache.clear()
			files = next
			revision++
			for (const [path, projection] of cache) {
				if (!Object.hasOwn(files, path) || !equalFile(files[path], projection.source))
					cache.delete(path)
			}
			past.length = 0
			future.length = 0
			const value = snapshot()
			notify()
			return { ok: true, value }
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}

/** Existing invalid syntax can coexist with edits outside its unchanged source owner. */
function retainedSyntaxError(
	issue: TypstSourceDiagnostic,
	before: TypstParsedProjection[],
	patches: readonly TypstSourcePatch[],
): boolean {
	if (issue.code !== 'SYNTAX_ERROR') return false
	const projection = before.find((value) => value.path === issue.path)
	if (!projection) return false
	const invalid: TypstParsedProjection['origins'] = []
	const visit = (origins: TypstParsedProjection['origins']) => {
		for (const origin of origins) {
			if (origin.original.attrs?.role === 'invalid') invalid.push(origin)
			visit(origin.children)
		}
	}
	visit(projection.origins)
	const edits = patches.filter((patch) => patch.path === issue.path)
	return projection.diagnostics.some((previous) => {
		if (previous.code !== issue.code || previous.message !== issue.message) return false
		const owner = invalid.find((origin) => origin.from <= previous.from && origin.to >= previous.to)
		if (!owner || edits.some((patch) => patch.from < owner.to && patch.to > owner.from))
			return false
		const shift = edits
			.filter((patch) => patch.to <= owner.from)
			.reduce(
				(total, patch) => total + encoder.encode(patch.text).length - (patch.to - patch.from),
				0,
			)
		return issue.from === previous.from + shift && issue.to === previous.to + shift
	})
}

function minimalPatch(path: string, before: string, after: string): TypstSourcePatch {
	let start = 0
	while (start < before.length && start < after.length && before[start] === after[start]) start++
	if (start > 0 && /[\uDC00-\uDFFF]/.test(before[start] ?? after[start] ?? '')) start--
	let oldEnd = before.length
	let newEnd = after.length
	while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
		oldEnd--
		newEnd--
	}
	if (/[\uDC00-\uDFFF]/.test(before[oldEnd] ?? after[newEnd] ?? '')) {
		oldEnd++
		newEnd++
	}
	return {
		path,
		from: encoder.encode(before.slice(0, start)).length,
		to: encoder.encode(before.slice(0, oldEnd)).length,
		text: after.slice(start, newEnd),
	}
}

function changedLabels(before: JSONContent, after: JSONContent): { from: string; to: string }[] {
	const oldNodes = new Map<string, JSONContent>()
	const changes: { from: string; to: string }[] = []
	const visit = (
		node: JSONContent,
		path: string,
		callback: (node: JSONContent, key: string) => void,
	) => {
		if (node.type === 'figure' || node.type === 'blockMath')
			callback(node, typeof node.attrs?.id === 'string' ? `id:${node.attrs.id}` : `path:${path}`)
		node.content?.forEach((child, index) => visit(child, `${path}.${index}`, callback))
	}
	visit(before, '', (node, key) => oldNodes.set(key, node))
	visit(after, '', (node, key) => {
		const old = oldNodes.get(key)
		if (
			!old ||
			typeof old.attrs?.label !== 'string' ||
			!old.attrs.label ||
			typeof node.attrs?.label !== 'string' ||
			!node.attrs.label ||
			old.attrs.label === node.attrs.label
		)
			return
		if (key.startsWith('path:')) {
			const withoutLabel = (value: JSONContent) => ({
				...value,
				attrs: { ...value.attrs, label: null },
			})
			if (JSON.stringify(withoutLabel(old)) !== JSON.stringify(withoutLabel(node))) return
		}
		changes.push({ from: old.attrs.label, to: node.attrs.label })
	})
	return changes
}

const environmentKinds = new Set([
	'letBinding',
	'moduleImport',
	'moduleInclude',
	'setRule',
	'showRule',
])
class UnsafeSourceTransfer extends Error {}

/** Read native import syntax; no independent dependency graph is stored. */
function importsChanged(projection: TypstParsedProjection, changed: ReadonlySet<string>): boolean {
	let affected = false
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object' || affected) return
		if (Array.isArray(value)) {
			value.forEach(visit)
			return
		}
		const node = value as AstExpr
		if (
			node.kind === 'moduleImport' &&
			node.source.kind === 'str' &&
			!node.source.value.startsWith('@')
		) {
			const parts = node.source.value.startsWith('/') ? [] : projection.path.split('/').slice(0, -1)
			for (const part of node.source.value.split('/')) {
				if (part === '..') parts.pop()
				else if (part && part !== '.') parts.push(part)
			}
			if (changed.has(parts.join('/'))) affected = true
		}
		Object.values(value).forEach(visit)
	}
	visit(projection.parsed.ast)
	return affected
}

/** Only lexical declarations preceding this top-level insertion affect its built-in names. */
function boundNames(expressions: AstExpr[], at: number): Set<string> {
	const names = new Set<string>()
	const identifiers = (value: unknown) => {
		if (!value || typeof value !== 'object') return
		const record = value as Record<string, unknown>
		if (record.kind === 'ident' && typeof record.name === 'string') names.add(record.name)
		if (typeof record.sinkIdent === 'string') names.add(record.sinkIdent)
		Object.values(record).forEach(identifiers)
	}
	for (const expr of expressions) {
		if (!expr.range || expr.range[0] >= at) continue
		if (expr.kind === 'letBinding') {
			if (expr.bindingKind?.kind === 'closure') names.add(expr.bindingKind.name)
			else if (expr.bindingKind?.kind === 'normal') identifiers(expr.bindingKind.pattern)
		} else if (expr.kind === 'moduleImport') {
			if (expr.imports?.kind === 'wildcard') names.add('*')
			else if (expr.imports?.kind === 'items') {
				for (const item of expr.imports.items)
					names.add(item.kind === 'renamed' ? item.newName : item.name)
			} else if (expr.newName) names.add(expr.newName)
			else if (expr.source.kind === 'str')
				names.add(
					expr.source.value
						.split('/')
						.at(-1)!
						.replace(/\.typ$/, ''),
				)
			else names.add('*')
		}
	}
	return names
}

function relativeResource(path: string, from: string, to: string, files: TypstSourceFiles): string {
	if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0'))
		throw new UnsafeSourceTransfer('Resource requires a literal project-relative path')
	const target = from.split('/').slice(0, -1)
	for (const segment of path.split('/')) {
		if (segment === '..') {
			if (target.length === 0) throw new UnsafeSourceTransfer('Resource escapes the project')
			target.pop()
		} else if (segment && segment !== '.') target.push(segment)
	}
	if (!Object.hasOwn(files, target.join('/')))
		throw new UnsafeSourceTransfer(`Resource is not in this project snapshot: ${target.join('/')}`)
	const destination = to.split('/').slice(0, -1)
	let common = 0
	while (
		common < target.length &&
		common < destination.length &&
		target[common] === destination[common]
	)
		common++
	return [...destination.slice(common).map(() => '..'), ...target.slice(common)].join('/')
}

/** Resolve only literal native imports already in effect at this exact top-level point. */
function transferImports(
	projection: TypstParsedProjection,
	at: number,
	files: TypstSourceFiles,
): Map<string, { module: string; name?: string }> {
	const imports = new Map<string, { module: string; name?: string }>()
	for (const expr of projection.parsed.ast) {
		if (!expr.range || expr.range[0] >= at) continue
		if (expr.kind === 'letBinding') {
			for (const name of boundNames([expr], Infinity)) imports.delete(name)
			continue
		}
		if (expr.kind !== 'moduleImport') continue
		if (expr.imports?.kind === 'wildcard') {
			imports.clear()
			continue
		}
		const locals = boundNames([expr], Infinity)
		for (const local of locals) imports.delete(local)
		if (expr.source.kind !== 'str') continue
		let module: string
		try {
			module = relativeResource(expr.source.value, projection.path, '__root__.typ', files)
		} catch {
			continue
		}
		if (expr.imports?.kind === 'items')
			for (const item of expr.imports.items)
				imports.set(item.kind === 'renamed' ? item.newName : item.name, {
					module,
					name: item.path.join('.'),
				})
		else if (!expr.imports)
			imports.set(
				expr.newName ??
					expr.source.value
						.split('/')
						.at(-1)!
						.replace(/\.typ$/, ''),
				{ module },
			)
	}
	return imports
}

/** This is a conservative syntax capability check, not evaluation or dependency inference. */
function portableFragment(
	expressions: AstExpr[],
	from: string,
	to: string,
	files: TypstSourceFiles,
	context: {
		source: TypstParsedProjection
		destination: TypstParsedProjection
		from: number
		at: number
	},
): {
	names: Set<string>
	patches: TypstSourcePatch[]
} {
	const names = new Set<string>()
	const patches: TypstSourcePatch[] = []
	const sourceImports = transferImports(context.source, context.from, files)
	const destinationImports = transferImports(context.destination, context.at, files)
	const origins: TypstParsedProjection['origins'] = []
	const collectOrigins = (values: TypstParsedProjection['origins']) => {
		for (const origin of values) {
			origins.push(origin)
			collectOrigins(origin.children)
		}
	}
	collectOrigins(context.source.origins)
	const importedCall = (node: Extract<AstExpr, { kind: 'funcCall' }>, name: string): boolean => {
		if (!node.range || !node.callee.range) return false
		const [local, field] = name.split('.')
		const imported = sourceImports.get(local!)
		const member = field ?? imported?.name
		if (!imported || !member || (field && imported.name)) return false
		const start = context.from + node.range[0],
			end = context.from + node.range[1]
		const origin = origins.find(
			(candidateOrigin) =>
				(candidateOrigin.from === start || candidateOrigin.from === start - 1) &&
				candidateOrigin.to >= end &&
				((candidateOrigin.original.type === 'typstComponent' &&
					candidateOrigin.call?.callee === name &&
					candidateOrigin.call.module === imported.module &&
					candidateOrigin.original.attrs?.name === member) ||
					(['inlineMath', 'blockMath'].includes(candidateOrigin.original.type!) &&
						member === 'latex') ||
					(candidateOrigin.original.type === 'reference' &&
						candidateOrigin.call?.callee === name &&
						member === 'reference') ||
					(candidateOrigin.original.type === 'typstField' && member === 'field')),
		)
		if (!origin) return false
		const candidates = [...destinationImports].flatMap(([destinationLocal, binding]) =>
			binding.module !== imported.module
				? []
				: binding.name
					? binding.name === member
						? [destinationLocal]
						: []
					: [`${destinationLocal}.${member}`],
		)
		const callee = candidates.includes(name) ? name : candidates[0]
		if (!callee)
			throw new UnsafeSourceTransfer(
				`Destination does not import the same ${imported.module} function ${member}`,
			)
		if (callee !== name)
			patches.push({
				path: from,
				from: node.callee.range[0],
				to: node.callee.range[1],
				text: callee,
			})
		return true
	}
	const calls = new Set([
		'figure',
		'image',
		'json',
		'table',
		'table.cell',
		'table.header',
		'table.footer',
		'text',
		'strong',
		'emph',
		'underline',
		'strike',
		'sub',
		'super',
		'highlight',
		'link',
		'raw',
		'rect',
		'circle',
		'ellipse',
		'line',
		'rgb',
		'cmyk',
		'luma',
		'align',
		'block',
		'box',
		'quote',
	])
	const constants = new Set([
		'black',
		'white',
		'gray',
		'silver',
		'red',
		'blue',
		'green',
		'yellow',
		'orange',
		'purple',
		'teal',
		'aqua',
		'fuchsia',
		'maroon',
		'navy',
		'olive',
		'lime',
		'left',
		'right',
		'center',
		'top',
		'bottom',
		'horizon',
		'start',
		'end',
	])
	const kinds = new Set([
		'text',
		'space',
		'linebreak',
		'parbreak',
		'escape',
		'shorthand',
		'smartQuote',
		'strong',
		'emph',
		'raw',
		'link',
		'label',
		'ref',
		'heading',
		'listItem',
		'enumItem',
		'termItem',
		'none',
		'auto',
		'bool',
		'int',
		'float',
		'numeric',
		'str',
		'contentBlock',
		'parenthesized',
		'array',
		'dict',
		'unary',
		'binary',
		'pos',
		'named',
		'keyed',
	])
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return
		if (Array.isArray(value)) {
			value.forEach(visit)
			return
		}
		const node = value as AstExpr
		if (node.kind === 'funcCall') {
			const name =
				node.callee.kind === 'ident'
					? node.callee.name
					: node.callee.kind === 'fieldAccess' && node.callee.target.kind === 'ident'
						? `${node.callee.target.name}.${node.callee.field}`
						: undefined
			if (!name) throw new UnsafeSourceTransfer('The selected source contains an unresolvable call')
			const imported = importedCall(node, name)
			if (!imported && !calls.has(name))
				throw new UnsafeSourceTransfer(
					'The selected source contains a call whose scope cannot be preserved automatically',
				)
			if (!imported) names.add(name.split('.')[0])
			if (!imported && (name === 'image' || name === 'json')) {
				const path = node.args.find(
					(arg) => arg.kind === 'pos' || (arg.kind === 'named' && arg.name === 'path'),
				)?.expr
				if (path?.kind !== 'str' || !path.range)
					throw new UnsafeSourceTransfer('Computed resource paths require an explicit source move')
				const replacement = relativeResource(path.value, from, to, files)
				if (from !== to && replacement !== path.value)
					patches.push({
						path: from,
						from: path.range[0],
						to: path.range[1],
						text: JSON.stringify(replacement),
					})
			}
			node.args.forEach(visit)
			return
		}
		if (node.kind === 'ident') {
			if (!constants.has(node.name))
				throw new UnsafeSourceTransfer(
					`The selected source depends on ${node.name}; move it explicitly with its scope`,
				)
			names.add(node.name)
			return
		}
		if (
			node.kind === 'binary' &&
			['assign', 'addAssign', 'subAssign', 'mulAssign', 'divAssign'].includes(node.op)
		)
			throw new UnsafeSourceTransfer('Assignments cannot be moved as ordinary content')
		if (node.kind && !kinds.has(node.kind))
			throw new UnsafeSourceTransfer(
				`Source construct ${node.kind} requires an explicit source move`,
			)
		for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child)
	}
	visit(expressions)
	return { names, patches }
}

function patchText(source: string, patches: readonly TypstSourcePatch[]): string {
	const bytes = encoder.encode(source)
	let cursor = 0,
		text = ''
	for (const patch of [...patches].sort((a, b) => a.from - b.from)) {
		text += decoder.decode(bytes.subarray(cursor, patch.from)) + patch.text
		cursor = patch.to
	}
	return text + decoder.decode(bytes.subarray(cursor))
}
