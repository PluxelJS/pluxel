import {
	isTypstBlock,
	blockAttributeError,
	templateDefinitionError,
	templateDefinitions,
} from './blocks.js'
import { flattenExtensions, getSchema, type JSONContent } from '@tiptap/core'
import type { NodeType, MarkType, Schema } from '@tiptap/pm/model'
import { createTypstExtensions } from './extensions.js'
import { tableStyleOptions, tableStyleOptionsError, tableStyleError } from './table-style.js'
import { textStyleAttributes, validTextStyleValue } from './text-style.js'
import { validTextAlignment } from './text-align.js'
import { isReferenceObject, validReferenceId, validReferenceLabel } from './document-nodes.js'
import type {
	TypstDataField,
	TypstDocumentDraft,
	TypstEditorConfig,
	TypstEditorIssue,
	TypstEditorResult,
	TypstJsonObject,
	TypstRegionDefinition,
} from './types.js'

export const builtinNodes = new Set([
	'doc',
	'text',
	'paragraph',
	'heading',
	'blockquote',
	'bulletList',
	'orderedList',
	'listItem',
	'hardBreak',
	'horizontalRule',
	'codeBlock',
	'table',
	'tableRow',
	'tableCell',
	'tableHeader',
	'image',
	'dataField',
	'templateBlock',
	'typstSource',
	'figure',
	'figureCaption',
	'inlineMath',
	'blockMath',
	'reference',
])
export const builtinMarks = new Set([
	'bold',
	'italic',
	'strike',
	'underline',
	'code',
	'link',
	'textStyle',
])
// These are the attributes whose meaning is covered by the built-in serializers.
// Extending a built-in schema alone must not silently discard new authored semantics.
const builtinNodeAttributes: Readonly<Record<string, readonly string[]>> = {
	paragraph: ['textAlign'],
	heading: ['level', 'textAlign'],
	orderedList: ['start', 'type'],
	codeBlock: ['language'],
	table: ['typstTableStyle'],
	tableCell: ['colspan', 'rowspan', 'colwidth', 'align'],
	tableHeader: ['colspan', 'rowspan', 'colwidth', 'align'],
	image: ['src', 'alt', 'title', 'width', 'height'],
	dataField: ['path'],
	templateBlock: ['id', 'template', 'props', 'dataPath'],
	typstSource: ['id', 'source'],
	figure: ['id', 'label'],
	blockMath: ['latex', 'id', 'label'],
	inlineMath: ['latex'],
	reference: ['target'],
}
const builtinMarkAttributes: Readonly<Record<string, readonly string[]>> = {
	link: ['href', 'target', 'rel', 'class', 'title'],
	textStyle: textStyleAttributes,
}
export const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
export const samePath = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((part, index) => part === b[index])
export const safeFieldPath = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((part) => typeof part === 'string' && validUnicode(part))

function validUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false
		} else if (code >= 0xdc00 && code <= 0xdfff) return false
	}
	return true
}

export function fieldAt(data: unknown, path: readonly string[]): unknown {
	let current = data
	for (const segment of path) {
		if ((!isObject(current) && !Array.isArray(current)) || !Object.hasOwn(current, segment))
			return undefined
		current = (current as Record<string, unknown>)[segment]
	}
	return current
}

export function fieldDisplay(data: unknown, descriptor: TypstDataField): string | undefined {
	const value = fieldAt(data, descriptor.path)
	if (value === null) return descriptor.nullText
	return typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
		? String(value)
		: undefined
}

function jsonValue(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || typeof value === 'boolean') return true
	if (typeof value === 'string') return validUnicode(value)
	if (typeof value === 'number') return Number.isFinite(value)
	if (
		typeof value !== 'object' ||
		(!Array.isArray(value) && !isObject(value)) ||
		ancestors.has(value)
	)
		return false
	ancestors.add(value)
	const valid =
		(Array.isArray(value) || Object.keys(value).every(validUnicode)) &&
		(Array.isArray(value) ? value : Object.values(value)).every((entry) =>
			jsonValue(entry, ancestors),
		)
	ancestors.delete(value)
	return valid
}

/** Checks declarations and serializer coverage before accepting any document. */
export function editorSchema(config: TypstEditorConfig): TypstEditorResult<Schema> {
	const issues: TypstEditorIssue[] = []
	if (!isObject(config) || !Array.isArray(config.regions) || !Array.isArray(config.fields))
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_CONFIG',
					message: 'Editor configuration requires regions and fields arrays.',
				},
			],
		}
	if (
		(config.extensions !== undefined && !Array.isArray(config.extensions)) ||
		(config.nodeMappings !== undefined && !isObject(config.nodeMappings)) ||
		(config.markMappings !== undefined && !isObject(config.markMappings)) ||
		(config.allowLink !== undefined && typeof config.allowLink !== 'function') ||
		(config.resolveImage !== undefined && typeof config.resolveImage !== 'function')
	)
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_CONFIG',
					message:
						'Extensions, serializer mappings and resource/link callbacks have invalid shapes.',
				},
			],
		}
	const ids = new Set<string>()
	for (const region of config.regions) {
		if (
			!isObject(region) ||
			typeof region.id !== 'string' ||
			!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(region.id) ||
			ids.has(region.id)
		) {
			issues.push({
				code: 'INVALID_CONFIG',
				message:
					'Region IDs must be unique safe filenames: letter followed by up to 63 letters, digits, underscores or hyphens.',
			})
			continue
		}
		ids.add(region.id)
		if (
			Object.keys(region).some(
				(name) => !['id', 'label', 'nodes', 'marks', 'fields'].includes(name),
			) ||
			(region.label !== undefined && typeof region.label !== 'string')
		)
			issues.push({
				code: 'INVALID_CONFIG',
				regionId: region.id,
				message: 'Unknown region property or invalid region label.',
			})
		if (
			(region.nodes !== undefined &&
				(!Array.isArray(region.nodes) || region.nodes.some((name) => typeof name !== 'string'))) ||
			(region.marks !== undefined &&
				(!Array.isArray(region.marks) || region.marks.some((name) => typeof name !== 'string'))) ||
			(region.fields !== undefined &&
				(!Array.isArray(region.fields) || !region.fields.every(safeFieldPath)))
		)
			issues.push({
				code: 'INVALID_CONFIG',
				regionId: region.id,
				message: 'Region nodes, marks and fields must contain valid names or field paths.',
			})
	}
	const fieldKeys = new Set<string>()
	for (const field of config.fields) {
		if (
			!isObject(field) ||
			Object.keys(field).some((name) => !['path', 'label', 'nullText'].includes(name)) ||
			!safeFieldPath(field.path) ||
			typeof field.label !== 'string' ||
			(field.nullText !== undefined &&
				(typeof field.nullText !== 'string' || !validUnicode(field.nullText))) ||
			fieldKeys.has(JSON.stringify(field.path))
		) {
			issues.push({
				code: 'INVALID_CONFIG',
				message:
					'Fields need unique safe string-array paths, labels and optional nullText strings.',
			})
		} else fieldKeys.add(JSON.stringify(field.path))
	}
	if (issues.length > 0) return { ok: false, issues }
	const extensions = createTypstExtensions(config)
	const names = new Set<string>()
	for (const extension of flattenExtensions(extensions)) {
		if (names.has(extension.name))
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Duplicate extension name: ${extension.name}.`,
			})
		names.add(extension.name)
	}
	if (issues.length > 0) return { ok: false, issues }
	const tableOptions = tableStyleOptions(extensions)
	const tableOptionError = tableOptions && tableStyleOptionsError(tableOptions)
	if (tableOptionError)
		return { ok: false, issues: [{ code: 'INVALID_CONFIG', message: tableOptionError }] }
	const blockError = templateDefinitionError(extensions)
	if (blockError) return { ok: false, issues: [{ code: 'INVALID_CONFIG', message: blockError }] }
	const schema = getSchema(extensions)
	for (const [name, type] of Object.entries(schema.nodes))
		if (builtinNodes.has(name))
			for (const attribute of Object.keys(type.spec.attrs ?? {}))
				if (!(builtinNodeAttributes[name] ?? []).includes(attribute))
					issues.push({
						code: 'MISSING_SERIALIZER',
						message: `Built-in node ${name} has no Typst mapping for attribute ${attribute}. Use a custom node with an explicit mapping.`,
					})
	for (const [name, type] of Object.entries(schema.marks))
		if (builtinMarks.has(name))
			for (const attribute of Object.keys(type.spec.attrs ?? {}))
				if (!(builtinMarkAttributes[name] ?? []).includes(attribute))
					issues.push({
						code: 'MISSING_SERIALIZER',
						message: `Built-in Mark ${name} has no Typst mapping for attribute ${attribute}. Use a custom Mark with an explicit mapping.`,
					})
	for (const name of Object.keys(schema.nodes))
		if (!builtinNodes.has(name) && !config.nodeMappings?.[name])
			issues.push({ code: 'MISSING_SERIALIZER', message: `Node ${name} has no Typst serializer.` })
	for (const name of Object.keys(schema.marks))
		if (!builtinMarks.has(name) && !config.markMappings?.[name])
			issues.push({ code: 'MISSING_SERIALIZER', message: `Mark ${name} has no Typst serializer.` })
	for (const name of Object.keys(config.nodeMappings ?? {}))
		if (builtinNodes.has(name) || !schema.nodes[name])
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Node mapping ${name} duplicates a built-in serializer or has no extension.`,
			})
	for (const name of Object.keys(config.markMappings ?? {}))
		if (builtinMarks.has(name) || !schema.marks[name])
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Mark mapping ${name} duplicates a built-in serializer or has no extension.`,
			})
	const htmlTags = new Set<string>()
	for (const [name, mapping] of Object.entries(config.nodeMappings ?? {})) {
		if (!isObject(mapping)) {
			issues.push({ code: 'INVALID_CONFIG', message: `Invalid serializer mapping for ${name}.` })
			continue
		}
		if (
			typeof mapping.serialize !== 'function' ||
			(mapping.validateAttributes !== undefined && typeof mapping.validateAttributes !== 'function')
		)
			issues.push({ code: 'INVALID_CONFIG', message: `Invalid serializer mapping for ${name}.` })
		if (
			Object.keys(schema.nodes[name]?.spec.attrs ?? {}).length > 0 &&
			typeof mapping.validateAttributes !== 'function'
		)
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Node ${name} has custom attributes and requires validateAttributes.`,
			})
		if (mapping.html) {
			if (
				!/^[a-z][a-z0-9-]*$/.test(mapping.html.tag) ||
				!Array.isArray(mapping.html.attributes) ||
				mapping.html.attributes.some((attribute) => typeof attribute !== 'string') ||
				htmlTags.has(mapping.html.tag)
			)
				issues.push({
					code: 'INVALID_CONFIG',
					message: `Invalid or duplicate HTML admission mapping for ${name}.`,
				})
			htmlTags.add(mapping.html.tag)
		}
	}
	for (const [name, mapping] of Object.entries(config.markMappings ?? {})) {
		if (!isObject(mapping)) {
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Invalid Mark serializer mapping for ${name}.`,
			})
			continue
		}
		if (
			typeof mapping.serialize !== 'function' ||
			(mapping.validateAttributes !== undefined && typeof mapping.validateAttributes !== 'function')
		)
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Invalid Mark serializer mapping for ${name}.`,
			})
		if (
			Object.keys(schema.marks[name]?.spec.attrs ?? {}).length > 0 &&
			typeof mapping.validateAttributes !== 'function'
		)
			issues.push({
				code: 'INVALID_CONFIG',
				message: `Mark ${name} has custom attributes and requires validateAttributes.`,
			})
	}
	for (const region of config.regions) {
		for (const name of region.nodes ?? [])
			if (!schema.nodes[name])
				issues.push({
					code: 'INVALID_CONFIG',
					regionId: region.id,
					message: `Unknown allowed node: ${name}.`,
				})
		for (const name of region.marks ?? [])
			if (!schema.marks[name])
				issues.push({
					code: 'INVALID_CONFIG',
					regionId: region.id,
					message: `Unknown allowed Mark: ${name}.`,
				})
		for (const path of region.fields ?? [])
			if (!config.fields.some((field) => samePath(field.path, path)))
				issues.push({
					code: 'INVALID_CONFIG',
					regionId: region.id,
					fieldPath: path,
					message: 'Region permits an undeclared field.',
				})
	}
	return issues.length > 0 ? { ok: false, issues } : { ok: true, value: schema }
}

/** Grid positions preserve row/column spans; no Markdown conversion is involved. */
export function tableGrid(
	table: JSONContent,
):
	| { columns: number; cells: { node: JSONContent; x: number; y: number }[]; widths: number[] }
	| string {
	const rows = table.content ?? []
	if (rows.length === 0) return 'A table needs at least one row.'
	const grid: boolean[][] = rows.map(() => [])
	const cells: { node: JSONContent; x: number; y: number }[] = []
	const widths: number[] = []
	for (let y = 0; y < rows.length; y++) {
		let x = 0
		for (const cell of rows[y]!.content ?? []) {
			while (grid[y]![x]) x++
			const colspan = cell.attrs?.colspan ?? 1
			const rowspan = cell.attrs?.rowspan ?? 1
			if (
				!Number.isSafeInteger(colspan) ||
				colspan < 1 ||
				!Number.isSafeInteger(rowspan) ||
				rowspan < 1 ||
				y + rowspan > rows.length
			)
				return 'Invalid table span or a rowspan extends beyond the last row.'
			const colwidth = cell.attrs?.colwidth
			if (
				colwidth !== undefined &&
				colwidth !== null &&
				(!Array.isArray(colwidth) ||
					colwidth.length !== colspan ||
					colwidth.some((width) => !Number.isSafeInteger(width) || width < 0))
			)
				return 'colwidth must contain one non-negative integer per spanned column.'
			for (let dy = 0; dy < rowspan; dy++)
				for (let dx = 0; dx < colspan; dx++) {
					if (grid[y + dy]![x + dx]) return 'Table cells overlap.'
					grid[y + dy]![x + dx] = true
				}
			if (Array.isArray(colwidth))
				for (let dx = 0; dx < colspan; dx++) {
					const width = colwidth[dx] as number
					if (width > 0 && widths[x + dx] !== undefined && widths[x + dx] !== width)
						return 'Conflicting colwidth values for the same table column.'
					if (width > 0) widths[x + dx] = width
				}
			cells.push({ node: cell, x, y })
			x += colspan
		}
	}
	const columns = grid[0]!.length
	if (
		!columns ||
		grid.some(
			(row) =>
				row.length !== columns ||
				Array.from({ length: columns }, (_, x) => row[x]).some((filled) => !filled),
		)
	)
		return 'Table rows do not form a complete rectangular grid.'
	return { columns, cells, widths: Array.from({ length: columns }, (_, x) => widths[x] ?? 100) }
}

export function allowedLink(config: TypstEditorConfig, value: unknown): boolean {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		Array.from(value).some((character) => {
			const code = character.codePointAt(0)!
			return code <= 0x20 || code === 0x7f
		})
	)
		return false
	if (config.allowLink) return config.allowLink(value)
	if (/^https?:\/\//i.test(value)) {
		try {
			// Validate the destination without rewriting the author's URL.
			const parsed = new URL(value)
			return parsed.protocol === 'http:' || parsed.protocol === 'https:'
		} catch {
			return false
		}
	}
	return /^(?:mailto:|tel:|#)/i.test(value)
}

function inspectNode(
	value: unknown,
	options: {
		config: TypstEditorConfig
		schema: Schema
		region: TypstRegionDefinition
		context: ValidationContext
		data?: unknown
	},
	path: (string | number)[],
	issues: TypstEditorIssue[],
	ancestors = new Set<object>(),
): void {
	const { config, schema, region, data } = options
	const issueStart = issues.length
	const issue = (
		code: TypstEditorIssue['code'],
		message: string,
		suffix: (string | number)[] = [],
		fieldPath?: readonly string[],
	) =>
		issues.push({
			code,
			message,
			regionId: region.id,
			path: [...path, ...suffix],
			...(fieldPath ? { fieldPath } : {}),
		})
	if (!isObject(value) || typeof value.type !== 'string') {
		issue('INVALID_JSON', 'Expected a native Tiptap node with a type.')
		return
	}
	if (ancestors.has(value)) {
		issue('INVALID_JSON', 'Circular node content is not JSON.')
		return
	}
	for (const key of Object.keys(value))
		if (!['type', 'attrs', 'content', 'text', 'marks'].includes(key))
			issue('INVALID_JSON', `Unknown node property: ${key}.`, [key])
	const type = schema.nodes[value.type]
	if (!type) {
		issue('UNKNOWN_NODE', `Unknown node: ${value.type}.`)
		return
	}
	ancestors.add(value)
	if (value.type !== 'doc' && region.nodes && !region.nodes.includes(value.type))
		issue('REGION_RULE', `Node ${value.type} is not allowed in this region.`)
	const attrs = inspectAttrs(value.attrs, type, path, region.id, issues)
	if (isReferenceObject(value.type)) {
		if (attrs.id != null && !validReferenceId(attrs.id))
			issue('INVALID_ATTRIBUTE', 'Object id must be a stable alphanumeric identifier or null.', [
				'attrs',
				'id',
			])
		if (attrs.label != null && !validReferenceLabel(attrs.label))
			issue(
				'INVALID_ATTRIBUTE',
				'Label must start with a letter or digit and contain only letters, combining marks, digits, colon, dot, underscore or hyphen (up to 128 characters), or be null.',
				['attrs', 'label'],
			)
		if (attrs.label != null && !validReferenceId(attrs.id))
			issue('INVALID_ATTRIBUTE', 'A labeled object requires a stable id.', ['attrs', 'id'])
	}
	if (
		(value.type === 'inlineMath' || value.type === 'blockMath') &&
		(typeof attrs.latex !== 'string' || !validUnicode(attrs.latex))
	)
		issue('INVALID_ATTRIBUTE', 'Math latex must be a well-formed string.', ['attrs', 'latex'])
	if (value.type === 'reference' && !validReferenceId(attrs.target))
		issue('INVALID_REFERENCE', 'A reference target must be a stable object id.', [
			'attrs',
			'target',
		])
	if (
		(value.type === 'paragraph' || value.type === 'heading') &&
		!validTextAlignment(attrs.textAlign)
	)
		issue(
			'INVALID_ATTRIBUTE',
			'Text alignment must be left, center, right, justify or null (template inheritance).',
			['attrs', 'textAlign'],
		)
	const customValidation = config.nodeMappings?.[value.type]?.validateAttributes?.(attrs)
	if (customValidation !== undefined && customValidation !== true)
		issue(
			'INVALID_ATTRIBUTE',
			typeof customValidation === 'string' ? customValidation : `Invalid ${value.type} attributes.`,
			['attrs'],
		)
	if (
		value.type === 'heading' &&
		(!Number.isInteger(attrs.level) || (attrs.level as number) < 1 || (attrs.level as number) > 6)
	)
		issue('INVALID_ATTRIBUTE', 'Heading level must be between 1 and 6.', ['attrs', 'level'])
	if (
		value.type === 'orderedList' &&
		(!Number.isSafeInteger(attrs.start) || (attrs.start as number) < 1)
	)
		issue('INVALID_ATTRIBUTE', 'Ordered list start must be a positive integer.', ['attrs', 'start'])
	if (
		value.type === 'orderedList' &&
		![null, undefined, '1', 'a', 'A', 'i', 'I'].includes(attrs.type as string)
	)
		issue('INVALID_ATTRIBUTE', 'Ordered list type must be 1, a, A, i, I or null.', [
			'attrs',
			'type',
		])
	if (
		value.type === 'codeBlock' &&
		attrs.language !== null &&
		attrs.language !== undefined &&
		typeof attrs.language !== 'string'
	)
		issue('INVALID_ATTRIBUTE', 'Code language must be a string or null.', ['attrs', 'language'])
	if (isTypstBlock(value.type)) {
		const error = blockAttributeError(
			value.type,
			attrs,
			config.extensions,
			data,
			options.context.templates,
		)
		if (error) issue('INVALID_ATTRIBUTE', error, ['attrs'])
	}
	if (value.type === 'table') {
		const tableOptions = options.context.table
		const error = tableOptions && tableStyleError(attrs.typstTableStyle, tableOptions)
		if (error) issue('INVALID_ATTRIBUTE', error, ['attrs', 'typstTableStyle'])
	}
	if (value.type === 'dataField') {
		const fieldPath = attrs.path
		if (!safeFieldPath(fieldPath))
			issue('INVALID_FIELD', 'A data field path must be a safe non-empty string array.', [
				'attrs',
				'path',
			])
		else {
			const field = options.context.fields.get(JSON.stringify(fieldPath))
			if (
				!field ||
				(region.fields && !region.fields.some((allowed) => samePath(allowed, fieldPath)))
			)
				issue(
					'INVALID_FIELD',
					'This field is not declared or not allowed in this region.',
					['attrs', 'path'],
					fieldPath,
				)
			else if (data !== undefined && fieldDisplay(data, field) === undefined)
				issue(
					'INVALID_FIELD',
					'The parsed field is missing, non-scalar or null without a nullText declaration.',
					['attrs', 'path'],
					fieldPath,
				)
		}
	}
	if (value.type === 'image') {
		if (
			typeof attrs.src !== 'string' ||
			!attrs.src ||
			/^(?:[a-z]+:|\/|\\)/i.test(attrs.src) ||
			attrs.src.split(/[/\\]/).includes('..')
		)
			issue('INVALID_RESOURCE', 'Image src must be a host-assigned logical resource ID.', [
				'attrs',
				'src',
			])
		for (const key of ['alt', 'title'])
			if (attrs[key] !== null && attrs[key] !== undefined && typeof attrs[key] !== 'string')
				issue('INVALID_ATTRIBUTE', `Image ${key} must be a string or null.`, ['attrs', key])
		for (const key of ['width', 'height'])
			if (
				attrs[key] !== null &&
				attrs[key] !== undefined &&
				(typeof attrs[key] !== 'number' ||
					!Number.isFinite(attrs[key]) ||
					(attrs[key] as number) <= 0)
			)
				issue('INVALID_ATTRIBUTE', `Image ${key} must be a positive finite number or null.`, [
					'attrs',
					key,
				])
	}
	if (
		(value.type === 'tableCell' || value.type === 'tableHeader') &&
		![undefined, null, 'left', 'center', 'right'].includes(attrs.align as string)
	)
		issue('INVALID_ATTRIBUTE', 'Cell alignment must be left, center, right or null.', [
			'attrs',
			'align',
		])
	if (
		value.text !== undefined &&
		(value.type !== 'text' ||
			typeof value.text !== 'string' ||
			value.text.length === 0 ||
			!validUnicode(value.text))
	)
		issue(
			'INVALID_STRUCTURE',
			'Text must be a non-empty well-formed Unicode string on a text node.',
			['text'],
		)
	if (value.type === 'text' && typeof value.text !== 'string')
		issue('INVALID_STRUCTURE', 'Text nodes require text.', ['text'])
	if (value.content !== undefined && !Array.isArray(value.content))
		issue('INVALID_STRUCTURE', 'Node content must be an array.', ['content'])
	if (value.type === 'text' && Array.isArray(value.content) && value.content.length > 0)
		issue('INVALID_STRUCTURE', 'Text nodes cannot contain child content.', ['content'])
	if (Array.isArray(value.content))
		value.content.forEach((child, index) =>
			inspectNode(child, options, [...path, 'content', index], issues, ancestors),
		)
	if (value.marks !== undefined && !Array.isArray(value.marks))
		issue('INVALID_STRUCTURE', 'Node marks must be an array.', ['marks'])
	const markNames = new Set<string>()
	if (Array.isArray(value.marks))
		for (let index = 0; index < value.marks.length; index++) {
			const mark: unknown = value.marks[index]
			if (!isObject(mark) || typeof mark.type !== 'string') {
				issue('INVALID_JSON', 'Expected a Mark type.', ['marks', index])
				continue
			}
			for (const key of Object.keys(mark))
				if (key !== 'type' && key !== 'attrs')
					issue('INVALID_JSON', `Unknown Mark property: ${key}.`, ['marks', index, key])
			const markType = schema.marks[mark.type]
			if (!markType) {
				issue('UNKNOWN_MARK', `Unknown Mark: ${mark.type}.`, ['marks', index])
				continue
			}
			if (markNames.has(mark.type))
				issue('INVALID_STRUCTURE', `Duplicate Mark: ${mark.type}.`, ['marks', index])
			markNames.add(mark.type)
			if (region.marks && !region.marks.includes(mark.type))
				issue('REGION_RULE', `Mark ${mark.type} is not allowed in this region.`, ['marks', index])
			const markAttrs = inspectAttrs(
				mark.attrs,
				markType,
				[...path, 'marks', index],
				region.id,
				issues,
			)
			if (mark.type === 'textStyle')
				for (const attribute of textStyleAttributes)
					if (!validTextStyleValue(attribute, markAttrs[attribute]))
						issue('INVALID_ATTRIBUTE', `Invalid portable text style ${attribute}.`, [
							'marks',
							index,
							'attrs',
							attribute,
						])
			if (mark.type === 'link' && !allowedLink(config, markAttrs.href))
				issue('INVALID_ATTRIBUTE', 'Link destination is not permitted.', [
					'marks',
					index,
					'attrs',
					'href',
				])
			for (const key of ['target', 'rel', 'class', 'title'])
				if (
					mark.type === 'link' &&
					markAttrs[key] !== null &&
					markAttrs[key] !== undefined &&
					typeof markAttrs[key] !== 'string'
				)
					issue('INVALID_ATTRIBUTE', `Link ${key} must be a string or null.`, [
						'marks',
						index,
						'attrs',
						key,
					])
			const validation = config.markMappings?.[mark.type]?.validateAttributes?.(markAttrs)
			if (validation !== undefined && validation !== true)
				issue(
					'INVALID_ATTRIBUTE',
					typeof validation === 'string' ? validation : `Invalid ${mark.type} attributes.`,
					['marks', index, 'attrs'],
				)
		}
	if (value.type === 'table' && issues.length === issueStart) {
		const grid = tableGrid(value as JSONContent)
		if (typeof grid === 'string') issue('INVALID_TABLE', grid)
	}
	ancestors.delete(value)
}

function inspectAttrs(
	value: unknown,
	type: NodeType | MarkType,
	path: (string | number)[],
	regionId: string,
	issues: TypstEditorIssue[],
): Record<string, unknown> {
	if (value !== undefined && !isObject(value)) {
		issues.push({
			code: 'INVALID_ATTRIBUTE',
			regionId,
			path: [...path, 'attrs'],
			message: 'Attributes must be an object.',
		})
		return {}
	}
	const attrs = (value ?? {}) as Record<string, unknown>
	const specs = type.spec.attrs ?? {}
	const resolved: Record<string, unknown> = {}
	for (const [name, spec] of Object.entries(specs)) {
		if (Object.hasOwn(attrs, name)) resolved[name] = attrs[name]
		else if (Object.hasOwn(spec as object, 'default')) resolved[name] = spec.default
		else
			issues.push({
				code: 'INVALID_ATTRIBUTE',
				regionId,
				path: [...path, 'attrs', name],
				message: `Missing required attribute ${name}.`,
			})
	}
	for (const [name, entry] of Object.entries(attrs)) {
		if (!Object.hasOwn(specs, name))
			issues.push({
				code: 'UNKNOWN_ATTRIBUTE',
				regionId,
				path: [...path, 'attrs', name],
				message: `Unknown ${type.name} attribute: ${name}.`,
			})
		else if (!jsonValue(entry))
			issues.push({
				code: 'INVALID_ATTRIBUTE',
				regionId,
				path: [...path, 'attrs', name],
				message: 'Attribute values must be JSON encodable.',
			})
	}
	return resolved
}

/** Private, synchronous preparation. Never retained between public calls. */
export function prepareTypstValidation(config: TypstEditorConfig) {
	const checked = editorSchema(config)
	if (!checked.ok) return checked
	return {
		ok: true as const,
		value: {
			config,
			schema: checked.value,
			regions: new Map(config.regions.map((region) => [region.id, region])),
			fields: new Map(config.fields.map((field) => [JSON.stringify(field.path), field])),
			templates: templateDefinitions(config.extensions),
			table: tableStyleOptions(config.extensions),
		},
	}
}
export type ValidationContext = Extract<
	ReturnType<typeof prepareTypstValidation>,
	{ ok: true }
>['value']

export function validateTypstRegion(options: {
	document: unknown
	regionId: string
	config: TypstEditorConfig
	data?: unknown
}): TypstEditorResult<JSONContent> {
	const context = prepareTypstValidation(options.config)
	if (!context.ok) return context
	return validateRegionWithContext(options, context.value)
}

export function validateRegionWithContext(
	options: {
		document: unknown
		regionId: string
		data?: unknown
	},
	context: ValidationContext,
): TypstEditorResult<JSONContent> {
	const region = context.regions.get(options.regionId)
	if (!region)
		return {
			ok: false,
			issues: [{ code: 'REGION_RULE', regionId: options.regionId, message: 'Unknown region.' }],
		}
	const issues: TypstEditorIssue[] = []
	if (!isObject(options.document) || options.document.type !== 'doc')
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_STRUCTURE',
					regionId: region.id,
					path: [],
					message: 'A region must contain a complete native Tiptap doc.',
				},
			],
		}
	inspectNode(
		options.document,
		{ ...options, config: context.config, schema: context.schema, region, context },
		[],
		issues,
	)
	if (issues.length > 0) return { ok: false, issues }
	const blockIds = new Set<string>()
	const checkIds = (node: JSONContent, path: (string | number)[]) => {
		if (isTypstBlock(node.type!)) {
			const id = node.attrs!.id as string
			if (blockIds.has(id))
				issues.push({
					code: 'INVALID_ATTRIBUTE',
					regionId: region.id,
					path: [...path, 'attrs', 'id'],
					message: 'Typst block instance IDs must be unique within a region.',
				})
			blockIds.add(id)
		}
		node.content?.forEach((child, index) => checkIds(child, [...path, 'content', index]))
	}
	checkIds(options.document as JSONContent, [])
	issues.push(...referenceIdentityIssues({ [region.id]: options.document as JSONContent }))
	if (issues.length > 0) return { ok: false, issues }
	try {
		const node = context.schema.nodeFromJSON(options.document)
		node.check()
	} catch (error) {
		if (!(error instanceof RangeError)) throw error
		return {
			ok: false,
			issues: [
				{ code: 'INVALID_STRUCTURE', regionId: region.id, path: [], message: error.message },
			],
		}
	}
	// Return the original JSON: validation never deletes attrs or rewrites saved content.
	return { ok: true, value: options.document as JSONContent }
}

export function validateTypstRegions(options: {
	regions: unknown
	config: TypstEditorConfig
	data?: unknown
}): TypstEditorResult<Record<string, JSONContent>> {
	const context = prepareTypstValidation(options.config)
	if (!context.ok) return context
	return validateRegionsWithContext(options, context.value)
}

export function validateRegionsWithContext(
	options: {
		regions: unknown
		data?: unknown
	},
	context: ValidationContext,
): TypstEditorResult<Record<string, JSONContent>> {
	if (!isObject(options.regions))
		return {
			ok: false,
			issues: [
				{
					code: 'REGION_SET',
					message: 'Regions must be an object containing every declared region.',
				},
			],
		}
	const regions = options.regions
	const expected = [...context.regions.keys()]
	if (
		Object.keys(regions).length !== expected.length ||
		expected.some((id) => !Object.hasOwn(regions, id))
	)
		return {
			ok: false,
			issues: [
				{
					code: 'REGION_SET',
					message: 'Draft regions must exactly match the template region declarations.',
				},
			],
		}
	const issues: TypstEditorIssue[] = []
	for (const id of expected) {
		const result = validateRegionWithContext(
			{
				document: options.regions[id],
				regionId: id,
				data: options.data,
			},
			context,
		)
		if (!result.ok) issues.push(...result.issues)
	}
	if (issues.length === 0)
		issues.push(...referenceIdentityIssues(options.regions as Record<string, JSONContent>))
	return issues.length > 0
		? { ok: false, issues }
		: { ok: true, value: options.regions as Record<string, JSONContent> }
}

function referenceIdentityIssues(
	regions: Readonly<Record<string, JSONContent>>,
): TypstEditorIssue[] {
	const issues: TypstEditorIssue[] = []
	const ids = new Set<string>()
	const labels = new Set<string>()
	for (const [regionId, document] of Object.entries(regions)) {
		const visit = (node: JSONContent, path: (string | number)[]) => {
			if (isReferenceObject(node.type!)) {
				for (const [name, values] of [
					['id', ids],
					['label', labels],
				] as const) {
					const value = node.attrs?.[name]
					if (typeof value !== 'string') continue
					if (values.has(value))
						issues.push({
							code: 'INVALID_REFERENCE',
							regionId,
							path: [...path, 'attrs', name],
							message: `Object ${name} must be unique across the whole document: ${value}.`,
						})
					values.add(value)
				}
			}
			node.content?.forEach((child, index) => visit(child, [...path, 'content', index]))
		}
		visit(document, [])
	}
	return issues
}

export function validateTypstDraft(options: {
	draft: unknown
	config: TypstEditorConfig
	templateId: string
	templateRevision: string
}): TypstEditorResult<TypstDocumentDraft> {
	const draft = options.draft
	if (
		!isObject(draft) ||
		Object.keys(draft).some(
			(key) =>
				!['formatVersion', 'templateId', 'templateRevision', 'data', 'regions'].includes(key),
		) ||
		draft.formatVersion !== 1 ||
		typeof draft.templateId !== 'string' ||
		typeof draft.templateRevision !== 'string' ||
		!isObject(draft.data) ||
		!jsonValue(draft.data)
	)
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_DRAFT',
					message: 'Expected a version 1 draft with raw JSON data and complete region documents.',
				},
			],
		}
	if (
		draft.templateId !== options.templateId ||
		draft.templateRevision !== options.templateRevision
	)
		return {
			ok: false,
			issues: [
				{
					code: 'TEMPLATE_CONFLICT',
					message:
						'Draft template identity or revision differs from the current template. Keep the draft and explicitly resolve the template revision.',
				},
			],
		}
	const regions = validateTypstRegions({ regions: draft.regions, config: options.config })
	if (!regions.ok) return regions
	return { ok: true, value: draft as unknown as TypstDocumentDraft }
}

export function validateTypstData(data: unknown): data is TypstJsonObject {
	return isObject(data) && jsonValue(data)
}
