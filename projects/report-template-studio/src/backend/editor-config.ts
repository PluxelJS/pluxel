import * as v from 'valibot'
import { posix } from 'node:path'
import type { EditorDescription, EditorDraft, WorkspaceSnapshot } from '../shared/contracts.js'
import { pathName } from './storage-validation.js'

const configSchema = v.strictObject({
	sources: v.array(v.strictObject({ path: v.string(), label: v.optional(v.string()) })),
	components: v.optional(
		v.array(
			v.strictObject({
				module: v.string(),
				name: v.string(),
				label: v.string(),
				data: v.optional(v.string()),
				parameters: v.record(
					v.string(),
					v.strictObject({
						type: v.picklist(['string', 'number', 'boolean']),
						label: v.optional(v.string()),
					}),
				),
			}),
		),
	),
})

/** Paths in the authoring declaration are relative to the report entry. */
export function describeEditor(
	document: WorkspaceSnapshot,
	entry: string,
): EditorDescription | undefined {
	const configPath = entry.replace(/\.ts$/, '.editor.json')
	if (!Object.hasOwn(document.files, configPath)) return undefined
	let parsed: v.InferOutput<typeof configSchema>
	try {
		parsed = v.parse(configSchema, JSON.parse(document.files[configPath]!))
	} catch (cause) {
		throw Object.assign(new Error(`Invalid editor configuration: ${configPath}`, { cause }), {
			code: 'INVALID_EDITOR_CONFIG',
		})
	}
	const resolve = (path: string) => pathName(posix.join(posix.dirname(entry), path))
	const sources = parsed.sources.map((source) => {
		source.path = resolve(source.path)
		return source
	})
	if (
		new Set(sources.map((s) => s.path)).size !== sources.length ||
		sources.some((s) => !s.path.endsWith('.typ') || !Object.hasOwn(document.files, s.path))
	)
		throw Object.assign(new Error('Editable source paths must be unique existing Typst files'), {
			code: 'INVALID_EDITOR_CONFIG',
		})
	return {
		sources,
		...(parsed.components
			? {
					components: parsed.components.map((component) => {
						component.module = resolve(component.module)
						return component
					}),
				}
			: {}),
	}
}

/** Validate the complete transport snapshot; source text remains authoritative. */
export function validateEditorDraft(
	description: EditorDescription | undefined,
	candidate: unknown,
): EditorDraft | undefined {
	if (candidate === undefined) return undefined
	const draft = editorDraft(candidate)
	if (description?.sources.some((source) => typeof draft.files[source.path] !== 'string'))
		throw Object.assign(new Error('Source snapshot is missing an editable file'), {
			code: 'INVALID_EDITOR_DRAFT',
		})
	return draft
}

/** Validate the authored source snapshot without normalizing source text. */
export function editorDraft(value: unknown): EditorDraft {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw Object.assign(new Error('Expected a source-file snapshot'), {
			code: 'INVALID_EDITOR_DRAFT',
		})
	const candidate = value as Record<string, unknown>
	if (
		Object.keys(candidate).some((key) => key !== 'files') ||
		!candidate.files ||
		typeof candidate.files !== 'object' ||
		Array.isArray(candidate.files)
	)
		throw Object.assign(new Error('Editor drafts contain ordinary source files only'), {
			code: 'INVALID_EDITOR_DRAFT',
		})
	const files: Record<string, string> = Object.create(null)
	for (const [path, source] of Object.entries(candidate.files)) {
		pathName(path)
		if (
			typeof source !== 'string' ||
			new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(source)) !== source
		)
			throw Object.assign(new Error(`${path}: expected UTF-8 source text`), {
				code: 'INVALID_EDITOR_DRAFT',
			})
		files[path] = source
	}
	return { files }
}
