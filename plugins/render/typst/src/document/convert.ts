import { parse, parseAst } from '@r4ai/typst-ast-node'
import { getSchema, type JSONContent } from '@tiptap/core'
import { Fragment, Mark, type Node, type Schema } from '@tiptap/pm/model'
import { parseTypstSource } from '../source/parse.js'
import type { TypstSourceMapping } from '../source/types.js'
import { createTypstDocumentExtensions } from '../tiptap/document-extensions.js'
import { validReferenceLabel } from '../tiptap/document-nodes.js'
import { fontSizeInPoints } from '../tiptap/text-style.js'
import { bodyMath } from './body-math.js'
import { readTypstBody, UnsupportedBodySyntax } from './body-read.js'
import {
	bodyColor,
	bodyFont,
	bodyImagePath,
	bodyLanguage,
	bodyLink,
	bodyNumber,
	bodyPixels,
	positiveNumber,
} from './body-values.js'
import { InvalidBodyDocument, writeTypstBody, type DocumentPath } from './body-write.js'

export type TypstDocumentIssue =
	| {
			readonly code: 'INVALID_TYPST' | 'UNSUPPORTED_SYNTAX'
			/** Half-open UTF-8 byte range in the supplied chapter. */
			readonly from: number
			readonly to: number
			readonly message: string
	  }
	| {
			readonly code: 'INVALID_DOCUMENT'
			readonly path: DocumentPath
			readonly message: string
	  }

export type TypstDocumentResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly TypstDocumentIssue[] }

let cachedSchema: Schema | undefined
function bodySchema() {
	return (cachedSchema ??= getSchema(createTypstDocumentExtensions()))
}

const nodeKeys = new Set(['type', 'attrs', 'content', 'marks', 'text'])
const numericLayout = /^(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?(pt|fr|%)$/
const maxDocumentNodes = 1_000_000
const text = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed()
const integer = (value: unknown, from: number, to: number): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= from && value <= to

function invalid(path: DocumentPath, message: string): never {
	throw new InvalidBodyDocument(path, message)
}

/** Copy data fields before consuming an unknown candidate, including candidates from JS callers. */
function dataRecord(value: unknown, path: DocumentPath, message: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== 'object' ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		return invalid(path, message)
	return Object.fromEntries(
		Reflect.ownKeys(value).map((key) => {
			if (typeof key !== 'string') return invalid(path, 'Expected JSON field names')
			const property = Object.getOwnPropertyDescriptor(value, key)
			if (!property?.enumerable || !('value' in property))
				return invalid([...path, key], 'Expected a JSON data field')
			return [key, property.value]
		}),
	)
}

function dataList(value: unknown, path: DocumentPath, limit: number, message: string): unknown[] {
	if (!Array.isArray(value) || value.length > limit) return invalid(path, message)
	if (Reflect.ownKeys(value).length !== value.length + 1)
		return invalid(path, 'Expected a dense JSON array of data values')
	return Array.from({ length: value.length }, (_, index) => {
		const property = Object.getOwnPropertyDescriptor(value, index)
		if (!property?.enumerable || !('value' in property))
			return invalid([...path, index], 'Expected a JSON data value')
		return property.value
	})
}

function length(value: string): string | undefined {
	const unit = numericLayout.exec(value)?.[1]
	if (!unit) return
	const amount = Number(value.slice(0, -unit.length))
	if (positiveNumber(amount)) return bodyNumber(amount) + unit
	return undefined
}

function normalizeAttribute(
	type: string,
	name: string,
	value: unknown,
	fallback: unknown,
	path: DocumentPath,
	attrs: Record<string, unknown>,
): unknown {
	const key = type + '.' + name
	switch (key) {
		case 'heading.label':
		case 'figure.label':
		case 'blockMath.label':
			if (value === null || validReferenceLabel(value)) return value
			return invalid(path, 'Expected a literal Typst label')
		case 'reference.target':
			if (validReferenceLabel(value)) return value
			return invalid(path, 'Expected a literal reference label')
		case 'reference.showCaption':
			if (value === null || typeof value === 'boolean') return value
			return invalid(path, 'Expected true, false, or null for the reference caption')
		case 'heading.level':
			if (integer(value, 1, 6)) return value
			return invalid(path, 'Expected heading level 1–6')
		case 'heading.textAlign':
		case 'paragraph.textAlign':
			if (value === null || value === 'left' || value === 'center' || value === 'right')
				return value
			if (value === 'justify') return value
			return invalid(path, 'Expected an alignment represented by the body')
		case 'orderedList.start':
			if (integer(value, 1, Number.MAX_SAFE_INTEGER)) return value
			return invalid(path, 'Expected a positive list starting number')
		case 'orderedList.type':
			if (value === null || (typeof value === 'string' && /^[1aAiI]$/.test(value))) return value
			return invalid(path, 'Expected a supported list numbering type')
		case 'image.src':
			if (bodyImagePath(value)) return value
			return invalid(path, 'Expected a literal project-local image path')
		case 'image.alt':
			if (value === null || text(value)) return value
			return invalid(path, 'Expected literal image alternative text')
		case 'image.width':
		case 'image.height':
			if (value === null) return null
			if (positiveNumber(value) && value * 0.75 > 0) return bodyPixels(value)
			if (typeof value === 'string' && value.endsWith('%')) {
				const dimension = length(value)
				if (dimension) return dimension
			}
			return invalid(path, 'Expected a positive pixel or percentage dimension')
		case 'codeBlock.language':
			if (value === null || bodyLanguage(value)) return value
			return invalid(path, 'Expected a literal code language')
		case 'inlineMath.expression':
		case 'blockMath.expression': {
			const expression = bodyMath(value, type === 'blockMath')
			if (expression) return expression
			return invalid(path, 'Expected a supported native math expression')
		}
		case 'link.href':
			if (bodyLink(value)) return value
			return invalid(path, 'Expected a supported literal link URL')
		case 'textStyle.fontFamily': {
			const font = value === null ? null : bodyFont(value)
			if (font !== undefined) return font
			return invalid(path, 'Expected one literal font family')
		}
		case 'textStyle.fontSize': {
			if (value === null) return null
			const size =
				fontSizeInPoints(value) ??
				(typeof value === 'string' && value.endsWith('pt') && length(value)
					? Number(value.slice(0, -2))
					: undefined)
			if (positiveNumber(size)) return bodyNumber(size) + 'pt'
			return invalid(path, 'Expected a positive font size in pt or px')
		}
		case 'textStyle.color':
		case 'textStyle.backgroundColor': {
			const color = value === null ? null : bodyColor(value)
			if (color !== undefined) return color
			return invalid(path, 'Expected a literal RGB color')
		}
		case 'table.tableStyle':
			if (value === null || value === 'grid' || value === 'borderless') return value
			return invalid(path, 'Expected a supported table style')
		case 'table.columnWidths':
			if (value === null) return null
			if (Array.isArray(value) && value.length > 0) {
				return dataList(value, path, 256, 'Expected at most 256 table column widths').map(
					(column, index) => {
						if (column === 'auto') return column
						if (typeof column === 'string' && !column.endsWith('pt')) {
							const dimension = length(column)
							if (dimension) return dimension
						}
						return invalid([...path, index], 'Expected auto or one relative Typst column width')
					},
				)
			}
			return invalid(path, 'Expected an array of relative Typst column widths')
		case 'tableCell.colspan':
		case 'tableCell.rowspan':
		case 'tableHeader.colspan':
		case 'tableHeader.rowspan':
			if (integer(value, 1, 256)) return value
			return invalid(path, 'Expected a cell span between 1 and 256')
		case 'tableCell.align':
		case 'tableHeader.align':
			if (value === null || value === 'left' || value === 'center' || value === 'right')
				return value
			return invalid(path, 'Expected an alignment represented by the body')
		case 'tableCell.colwidth':
		case 'tableHeader.colwidth':
			if (value === null) return null
			if (Array.isArray(value) && value.length === (attrs.colspan ?? 1)) {
				return dataList(value, path, 256, 'Expected measured widths for the spanned columns').map(
					(column, index) => {
						if (column === 0) return 0
						if (positiveNumber(column) && column * 0.75 > 0) return bodyPixels(column)
						return invalid([...path, index], 'Expected a nonnegative finite column width')
					},
				)
			}
			return invalid(path, 'Expected one measured width per spanned column')
		default:
			if (value === fallback) return value
			return invalid(path, 'This attribute has no equivalent in Typst body content')
	}
}

function attributes(
	name: string,
	value: unknown,
	spec: Readonly<Record<string, { default?: unknown }>> | undefined,
	path: DocumentPath,
): Record<string, unknown> {
	const input = value === undefined ? {} : dataRecord(value, path, 'Expected an attributes object')
	for (const key of Object.keys(input))
		if (!spec || !Object.hasOwn(spec, key)) invalid([...path, key], 'Unknown attribute')
	return Object.fromEntries(
		Object.entries(spec ?? {}).map(([key, attribute]) => [
			key,
			normalizeAttribute(
				name,
				key,
				Object.hasOwn(input, key) ? input[key] : attribute.default,
				attribute.default,
				[...path, key],
				input,
			),
		]),
	)
}

function checkedMarks(value: unknown, schema: Schema, path: DocumentPath): readonly Mark[] {
	if (value === undefined) return Mark.none
	let result = Mark.none
	const seen = new Set<string>()
	for (const [index, candidate] of dataList(
		value,
		path,
		schema.spec.marks.size,
		'Expected a list of body marks',
	).entries()) {
		const markPath = [...path, index]
		const item = dataRecord(candidate, markPath, 'Expected a body mark object')
		if (
			typeof item.type !== 'string' ||
			!Object.hasOwn(schema.marks, item.type) ||
			seen.has(item.type)
		)
			invalid(markPath, 'Unsupported or repeated body mark')
		for (const key of Object.keys(item))
			if (key !== 'type' && key !== 'attrs') invalid([...markPath, key], 'Unknown mark field')
		seen.add(item.type)
		const type = schema.marks[item.type]!
		const attrs = attributes(item.type, item.attrs, type.spec.attrs, [...markPath, 'attrs'])
		if (item.type === 'textStyle' && Object.values(attrs).every((attribute) => attribute === null))
			continue
		const mark = type.create(attrs)
		const next = mark.addToSet(result)
		if (next.length !== result.length + 1) invalid(markPath, 'These body marks cannot be combined')
		result = next
	}
	return result
}

function documentTree(input: unknown, schema: Schema): Node {
	let count = 0
	function read(value: unknown, path: DocumentPath, depth: number): Node {
		if (depth > 128 || ++count > maxDocumentNodes)
			return invalid(path, 'The body exceeds the supported document size or depth')
		const candidate = dataRecord(value, path, 'Expected a body node object')
		const { type, text: sourceText, content, marks, attrs } = candidate
		if (typeof type !== 'string' || !Object.hasOwn(schema.nodes, type))
			return invalid([...path, 'type'], 'Unsupported body node')
		const nodeType = schema.nodes[type]!
		if ((depth === 0) !== (nodeType === schema.topNodeType))
			return invalid([...path, 'type'], 'Expected a doc at the root and body nodes within it')
		for (const key of Object.keys(candidate))
			if (!nodeKeys.has(key)) invalid([...path, key], 'Unknown node field')
		const attributesPath = [...path, 'attrs']
		const checkedAttrs = attributes(type, attrs, nodeType.spec.attrs, attributesPath)
		const nodeMarks = checkedMarks(marks, schema, [...path, 'marks'])
		if (type === 'text') {
			if (!text(sourceText) || !sourceText)
				invalid([...path, 'text'], 'Expected nonempty well-formed text')
			if (content !== undefined) invalid([...path, 'content'], 'Text cannot contain body nodes')
			return schema.text(sourceText, nodeMarks)
		}
		if (sourceText !== undefined) invalid([...path, 'text'], 'Only text nodes have text')
		if (nodeMarks.some((mark) => mark.type.name === 'code'))
			invalid([...path, 'marks'], 'Code marks are allowed on text only')
		const children =
			content === undefined
				? []
				: dataList(
						content,
						[...path, 'content'],
						maxDocumentNodes - count,
						'Expected a bounded list of child nodes',
					).map((item, index) => read(item, [...path, 'content', index], depth + 1))
		if (type === 'doc' && children.length === 0) children.push(schema.nodes.paragraph!.create())
		const fragment = Fragment.fromArray(children)
		if (!nodeType.validContent(fragment))
			invalid([...path, 'content'], 'These children or marks do not fit the body node')
		if (!nodeType.isInline && nodeMarks.length > 0)
			invalid([...path, 'marks'], 'Marks are allowed on inline body nodes only')
		return nodeType.create(checkedAttrs, fragment, nodeMarks)
	}
	return read(input, [], 0)
}

/** Convert one chapter in the editable Typst subset. This operation does not evaluate Typst. */
export function parseTypstDocument(source: string): TypstDocumentResult<{
	document: JSONContent
	mapping: readonly TypstSourceMapping[]
}> {
	if (typeof source !== 'string')
		return {
			ok: false,
			issues: [
				{ code: 'INVALID_TYPST', from: 0, to: 0, message: 'Expected a Typst source string' },
			],
		}
	if (!source.isWellFormed()) {
		const prefix = source.slice(0, source.search(/[\uD800-\uDFFF]/u))
		const offset = new TextEncoder().encode(prefix).length
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_TYPST',
					from: offset,
					to: offset,
					message: 'Expected well-formed Unicode',
				},
			],
		}
	}
	const parsed = parseTypstSource(source, { parse, parseAst })
	if (parsed.errors.length > 0) {
		return {
			ok: false,
			issues: parsed.errors.map(({ message, range: [from, to] }) => ({
				code: 'INVALID_TYPST',
				from,
				to,
				message,
			})),
		}
	}
	let locations: readonly TypstSourceMapping[] = []
	try {
		const schema = bodySchema()
		const { document, mapping } = readTypstBody(parsed, schema)
		locations = mapping
		const node = documentTree(document, schema)
		return { ok: true, value: { document: node.toJSON(), mapping } }
	} catch (error) {
		if (error instanceof UnsupportedBodySyntax) {
			const [from, to] = error.range
			return {
				ok: false,
				issues: [{ code: 'UNSUPPORTED_SYNTAX', from, to, message: error.message }],
			}
		}
		if (error instanceof InvalidBodyDocument) {
			const nodePath = error.path.filter(
				(part, index) => typeof part === 'number' && error.path[index - 1] === 'content',
			)
			const found = locations.find(
				(location) =>
					location.nodePath.length === nodePath.length &&
					location.nodePath.every((part, index) => part === nodePath[index]),
			)
			const [from, to] = found ? [found.from, found.to] : parsed.cst.range
			return {
				ok: false,
				issues: [{ code: 'UNSUPPORTED_SYNTAX', from, to, message: error.message }],
			}
		}
		throw error
	}
}

/** Validate a candidate tree and emit canonical native Typst only from its checked fields. */
export function printTypstDocument(candidate: unknown): TypstDocumentResult<{
	source: string
	document: JSONContent
}> {
	try {
		const document = documentTree(candidate, bodySchema()).toJSON() as JSONContent
		const source = writeTypstBody(document)
		return { ok: true, value: { source, document } }
	} catch (error) {
		if (error instanceof InvalidBodyDocument)
			return {
				ok: false,
				issues: [{ code: 'INVALID_DOCUMENT', path: error.path, message: error.message }],
			}
		throw error
	}
}
