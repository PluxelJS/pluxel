import type {
	DocumentInput,
	InputWrite,
	JsonObject,
	JsonValue,
	WorkspaceSnapshot,
} from '../shared/contracts.js'
import { isDeepStrictEqual } from 'node:util'
import { pathName } from './storage-validation.js'
import { WorkspaceStore } from './store.js'
import { describeEditor, editorDraft } from './editor-config.js'

/** Validate before cloning: JSON encoding must never silently drop caller values. */
export function inputData(value: unknown): JsonObject {
	const invalid = (path: (string | number)[], message: string): never => {
		throw Object.assign(new Error(message), {
			code: 'INVALID_INPUT',
			issues: [{ path, rule: 'json', message }],
		})
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid(['data'], 'Input data must be a JSON object')
	const ancestors = new Set<object>()
	let count = 0
	function clone(item: unknown, path: (string | number)[], depth: number): JsonValue {
		if (++count > 1_000_000 || depth > 64) invalid(path, 'Input JSON exceeds complexity limits')
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
		if (typeof item === 'number' && Number.isFinite(item)) return item
		if (!item || typeof item !== 'object') invalid(path, 'Expected a finite JSON value')
		const object = item as object
		if (ancestors.has(object)) invalid(path, 'Input JSON cannot contain cycles')
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
			invalid(path, 'Input JSON objects must have ordinary or null prototypes')
		if (Object.getOwnPropertySymbols(item).length > 0)
			invalid(path, 'Input JSON cannot contain symbol keys')
		ancestors.add(object)
		try {
			if (Array.isArray(item)) {
				if (Object.keys(item).length !== item.length)
					invalid(path, 'Input JSON arrays must be dense and have no extra properties')
				return Array.from({ length: item.length }, (_, index) => {
					const property = Object.getOwnPropertyDescriptor(item, String(index))
					if (!property || !('value' in property))
						invalid([...path, index], 'Input JSON cannot contain accessors')
					return clone(property!.value, [...path, index], depth + 1)
				})
			}
			const output: JsonObject = {}
			for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
				if (!property.enumerable || !('value' in property))
					invalid([...path, key], 'Input JSON must contain enumerable data properties')
				Object.defineProperty(output, key, {
					value: clone(property.value, [...path, key], depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
			return output
		} finally {
			ancestors.delete(object)
		}
	}
	const result = clone(value, ['data'], 0) as JsonObject
	if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
		throw Object.assign(new Error('Input data exceeds 4 MiB'), { code: 'LIMIT_EXCEEDED' })
	return result
}

/** The report's raw business data is a visible, ordinary workspace JSON file. */
export function inputPath(entry: string): string {
	return pathName(entry.slice(0, entry.lastIndexOf('/') + 1) + 'data.json')
}

/** Per-report data decoding and atomic source/data writes share the workspace's sole IO queue. */
export class InputStore {
	constructor(private readonly store: WorkspaceStore) {}
	async get(id: string, entry: string): Promise<DocumentInput> {
		const snapshot = await this.store.snapshot(id)
		return decodeInput(snapshot, entry)
	}
	async set(
		id: string,
		entry: string,
		input: Pick<InputWrite, 'data' | 'editor' | 'expectedVersion'>,
	): Promise<DocumentInput> {
		const data = inputData(input.data)
		const draft = input.editor === undefined ? undefined : editorDraft(input.editor)
		const current = await this.store.snapshot(id)
		if (current.revision !== input.expectedVersion)
			throw Object.assign(new Error('Workspace source changed; reload before saving'), {
				code: 'DRAFT_VERSION_CONFLICT',
				storageVersion: current.revision,
			})
		const description = describeEditor(current, entry)
		const writable = new Set([
			...(description?.sources.map((source) => source.path) ?? []),
			inputPath(entry),
		])
		const changes: Record<string, string> = {}
		for (const [path, source] of Object.entries(draft?.files ?? {})) {
			if (source === current.files[path]) continue
			if (!writable.has(path))
				throw Object.assign(new Error(`Source file is not writable from this body: ${path}`), {
					code: 'READ_ONLY',
				})
			changes[path] = source
		}
		if (draft && Object.keys(current.files).some((path) => !Object.hasOwn(draft.files, path)))
			throw Object.assign(new Error('Source snapshot is incomplete; reload before saving'), {
				code: 'INVALID_EDITOR_DRAFT',
			})
		const dataPath = inputPath(entry)
		if (changes[dataPath] !== undefined) {
			const parsed = sourceData(changes[dataPath])
			if (!isDeepStrictEqual(parsed, data))
				throw Object.assign(new Error('Data form and JSON snapshot disagree'), {
					code: 'INVALID_INPUT',
				})
		} else if (
			current.files[dataPath] === undefined ||
			!isDeepStrictEqual(data, sourceData(current.files[dataPath]))
		)
			changes[dataPath] = JSON.stringify(data, null, 2) + '\n'
		try {
			return decodeInput(
				await this.store.writeFiles(id, { expectedRevision: current.revision, files: changes }),
				entry,
			)
		} catch (cause) {
			if (
				cause &&
				typeof cause === 'object' &&
				'code' in cause &&
				cause.code === 'REVISION_CONFLICT'
			)
				throw Object.assign(
					new Error('Workspace source changed; reload before saving', { cause }),
					{ code: 'DRAFT_VERSION_CONFLICT' },
				)
			throw cause
		}
	}
}
function sourceData(source: string | undefined): JsonObject {
	return source === undefined ? {} : inputData(JSON.parse(source))
}

function decodeInput(snapshot: WorkspaceSnapshot, entry: string): DocumentInput {
	const source = snapshot.files[inputPath(entry)]
	const data = source === undefined ? {} : inputData(JSON.parse(source))
	return {
		data,
		editor: { files: { ...snapshot.files } },
		assets: snapshot.assets.filter((asset) => /\.(?:svg|png|jpe?g|gif|webp)$/i.test(asset.path)),
		storageVersion: snapshot.revision,
	}
}
