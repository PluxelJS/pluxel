import * as v from 'valibot'
import { validateTypstRegions, type TypstEditorResult } from '@pluxel/plugin-typst/tiptap'
import type {
	EditorDescription,
	EditorDraft,
	JsonObject,
	JsonValue,
	WorkspaceSnapshot,
} from '../shared/contracts.js'
import { studioEditorConfig } from '../shared/editor.js'
import { editorDraft } from './inputs.js'

const path = v.array(v.pipe(v.string(), v.minLength(1)))
const jsonValue: v.GenericSchema<unknown, JsonValue> = v.lazy(() =>
	v.union([
		v.null(),
		v.boolean(),
		v.pipe(v.number(), v.finite()),
		v.string(),
		v.array(jsonValue),
		v.record(v.string(), jsonValue),
	]),
)
const tableAppearance = v.picklist(['grid', 'grid-open-sides', 'three-line', 'borderless'])
const configSchema = v.strictObject({
	templates: v.optional(
		v.array(
			v.strictObject({
				id: v.string(),
				label: v.string(),
				source: v.string(),
				defaults: v.optional(
					v.pipe(
						v.unknown(),
						v.check(
							(value) => value !== null && typeof value === 'object' && !Array.isArray(value),
							'Template defaults must be a JSON object.',
						),
						v.record(v.string(), jsonValue),
					),
				),
			}),
		),
	),
	sourceBlocks: v.optional(v.boolean()),
	table: v.optional(
		v.strictObject({
			defaultStyle: v.optional(v.nullable(tableAppearance)),
			allowedStyles: v.optional(v.array(tableAppearance)),
		}),
	),
	regions: v.array(
		v.strictObject({
			id: v.string(),
			label: v.optional(v.string()),
			nodes: v.optional(v.array(v.string())),
			marks: v.optional(v.array(v.string())),
			fields: v.optional(v.array(path)),
		}),
	),
	fields: v.array(v.strictObject({ path, label: v.string(), nullText: v.optional(v.string()) })),
	defaults: v.record(v.string(), v.unknown()),
})

export function editorResult<T>(result: TypstEditorResult<T>, code = 'INVALID_EDITOR_DRAFT'): T {
	if (result.ok) return result.value
	throw Object.assign(new Error(result.issues.map((issue) => issue.message).join('; ')), {
		code,
		issues: result.issues.map((issue) => ({
			path: [...(issue.regionId ? ['regions', issue.regionId] : []), ...(issue.path ?? [])],
			rule: issue.code,
			message: issue.message,
		})),
	})
}

/** The suffix is a Studio authoring convention, never inferred from the Typst source. */
export function describeEditor(
	document: WorkspaceSnapshot,
	entry: string,
): EditorDescription | undefined {
	const configPath = entry.replace(/\.ts$/, '.editor.json')
	if (!Object.hasOwn(document.files, configPath)) return undefined
	let candidate: unknown
	try {
		candidate = JSON.parse(document.files[configPath]!)
	} catch (cause) {
		throw Object.assign(new Error(`Invalid editor configuration: ${configPath}`, { cause }), {
			code: 'INVALID_EDITOR_CONFIG',
		})
	}
	const parsed = v.safeParse(configSchema, candidate)
	if (!parsed.success)
		throw Object.assign(new Error(`Invalid editor configuration: ${configPath}`), {
			code: 'INVALID_EDITOR_CONFIG',
			issues: parsed.issues.map((issue) => ({
				path: [
					configPath,
					...(issue.path
						?.map((part) => part.key)
						.filter(
							(key): key is string | number => typeof key === 'string' || typeof key === 'number',
						) ?? []),
				],
				rule: issue.type,
				message: issue.message,
			})),
		})
	const config = studioEditorConfig(parsed.output)
	const defaults = editorResult(
		validateTypstRegions({
			regions: parsed.output.defaults,
			config,
		}),
		'INVALID_EDITOR_CONFIG',
	)
	return {
		templateId: entry,
		templateRevision: document.revision,
		...(parsed.output.table ? { table: parsed.output.table } : {}),
		...(parsed.output.templates ? { templates: parsed.output.templates } : {}),
		...(parsed.output.sourceBlocks !== undefined
			? { sourceBlocks: parsed.output.sourceBlocks }
			: {}),
		regions: parsed.output.regions,
		fields: parsed.output.fields,
		defaults,
	}
}

/** A saved or compile-time draft never supplies its own regions, rules or template revision. */
export function validateEditorDraft(
	description: EditorDescription | undefined,
	candidate: unknown,
	data?: JsonObject,
): EditorDraft | undefined {
	if (!description) {
		if (candidate !== undefined)
			throw Object.assign(new Error('This report does not declare editable regions'), {
				code: 'EDITOR_NOT_CONFIGURED',
			})
		return undefined
	}
	if (candidate === undefined)
		throw Object.assign(
			new Error('Create a region draft explicitly from this template before saving or compiling'),
			{ code: 'EDITOR_DRAFT_REQUIRED' },
		)
	const draft = editorDraft(candidate)
	if (
		draft.templateId !== description.templateId ||
		draft.templateRevision !== description.templateRevision
	)
		throw Object.assign(
			new Error(
				'The editor draft belongs to a different template revision; preserve it and explicitly adopt the current template',
			),
			{
				code: 'TEMPLATE_REVISION_CONFLICT',
			},
		)
	editorResult(
		validateTypstRegions({
			regions: draft.regions,
			config: studioEditorConfig(description),
			...(data ? { data } : {}),
		}),
	)
	return draft
}
