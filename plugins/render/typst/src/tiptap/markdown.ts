import { type JSONContent } from '@tiptap/core'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import { MarkdownManager } from '@tiptap/markdown'
import { createTypstExtensions } from './extensions.js'
import { isolatedMarked } from './base-extensions.js'
import { tableStyleOptions, tableStyleError } from './table-style.js'
import { editorSchema, tableGrid, validateTypstRegion } from './validation.js'
import { textStyleAttributes, textStyleDeclarationError } from './text-style.js'
import { textAlignmentDeclarationError } from './text-align.js'
import type { TypstEditorConfig, TypstEditorIssue, TypstEditorResult } from './types.js'

interface RegionInput {
	regionId: string
	config: TypstEditorConfig
	data?: unknown
}

function manager(config: TypstEditorConfig): MarkdownManager {
	return new MarkdownManager({
		extensions: createTypstExtensions(config),
		marked: isolatedMarked(),
		markedOptions: { gfm: true, breaks: false },
	})
}

/** Inspect upstream lexer tokens before a fallback parser could erase input. */
function inputIssues(
	value: unknown,
	regionId: string,
	issues: TypstEditorIssue[],
	path: (string | number)[] = [],
): void {
	if (!value || typeof value !== 'object') return
	if (Array.isArray(value)) {
		value.forEach((entry, index) => inputIssues(entry, regionId, issues, [...path, index]))
		return
	}
	const token = value as Record<string, unknown>
	if (token.type === 'code' || token.type === 'codespan') return
	if (token.type === 'html')
		issues.push({
			code: 'UNSUPPORTED_MARKDOWN',
			regionId,
			path,
			message:
				'Raw HTML in Markdown is not a supported portable input. Only the controlled data-field tag is supported; code examples remain literal text.',
		})
	if (token.task === true)
		issues.push({
			code: 'UNSUPPORTED_MARKDOWN',
			regionId,
			path,
			message: 'Task list checkboxes are not in the declared Markdown subset.',
		})
	for (const [key, child] of Object.entries(token))
		if (typeof child === 'object') inputIssues(child, regionId, issues, [...path, key])
}

/** The same official MarkdownManager/extension collection works with or without DOM. */
export function parseTypstMarkdown(
	options: RegionInput & { markdown: string },
): TypstEditorResult<JSONContent> {
	const checked = editorSchema(options.config)
	if (!checked.ok) return checked
	if (typeof options.markdown !== 'string')
		return {
			ok: false,
			issues: [
				{
					code: 'UNSUPPORTED_MARKDOWN',
					regionId: options.regionId,
					message: 'Markdown input must be a string.',
				},
			],
		}
	const markdown = manager(options.config)
	const issues: TypstEditorIssue[] = []
	inputIssues(markdown.instance.lexer(options.markdown), options.regionId, issues)
	if (issues.length > 0) return { ok: false, issues }
	const document = markdown.parse(options.markdown)
	if (!document.content?.length) document.content = [{ type: 'paragraph' }]
	return validateTypstRegion({ ...options, document })
}

export interface TypstMarkdownExport {
	markdown: string
	/** False means this output must never replace the authoritative JSON. */
	lossless: boolean
	issues: TypstEditorIssue[]
}

function canonical(document: JSONContent, config: TypstEditorConfig): string {
	const checked = editorSchema(config)
	if (!checked.ok)
		throw new Error('Validated editor configuration changed during Markdown conversion.')
	return JSON.stringify(checked.value.nodeFromJSON(document).toJSON())
}

/** JSON stays authoritative; representability is checked by a real round trip. */
export function exportTypstMarkdown(
	options: RegionInput & { document: unknown },
): TypstEditorResult<TypstMarkdownExport> {
	const checked = validateTypstRegion(options)
	if (!checked.ok) return checked
	const issues: TypstEditorIssue[] = []
	const inspect = (node: JSONContent, path: (string | number)[]) => {
		if ((node.type === 'paragraph' || node.type === 'heading') && node.attrs?.textAlign != null)
			issues.push({
				code: 'COMPLEX_CONTENT',
				regionId: options.regionId,
				path: [...path, 'attrs', 'textAlign'],
				message: 'Paragraph and heading alignment cannot round-trip through Markdown.',
			})
		node.marks?.forEach((mark, index) => {
			if (
				mark.type === 'textStyle' &&
				textStyleAttributes.some((attribute) => mark.attrs?.[attribute] != null)
			)
				issues.push({
					code: 'COMPLEX_CONTENT',
					regionId: options.regionId,
					path: [...path, 'marks', index],
					message:
						'Font family, font size and text/background colors cannot round-trip through Markdown.',
				})
		})
		if (node.type === 'table' && node.attrs?.typstTableStyle != null)
			issues.push({
				code: 'COMPLEX_CONTENT',
				regionId: options.regionId,
				path: [...path, 'attrs', 'typstTableStyle'],
				message: 'Typst table appearance cannot round-trip through Markdown.',
			})
		if (node.type === 'tableCell' || node.type === 'tableHeader') {
			if (
				(node.attrs?.colspan ?? 1) !== 1 ||
				(node.attrs?.rowspan ?? 1) !== 1 ||
				node.content?.length !== 1 ||
				node.content?.[0]?.type !== 'paragraph' ||
				(node.attrs?.colwidth !== null && node.attrs?.colwidth !== undefined)
			)
				issues.push({
					code: 'COMPLEX_CONTENT',
					regionId: options.regionId,
					path,
					message:
						'Merged cells, explicit column widths and multi-block cells cannot round-trip through GFM.',
				})
		}
		node.content?.forEach((child, index) => inspect(child, [...path, 'content', index]))
	}
	inspect(checked.value, [])
	const markdown = manager(options.config).serialize(checked.value)
	const parsed = parseTypstMarkdown({ ...options, markdown })
	if (!parsed.ok) issues.push(...parsed.issues)
	else if (canonical(checked.value, options.config) !== canonical(parsed.value, options.config))
		issues.push({
			code: 'COMPLEX_CONTENT',
			regionId: options.regionId,
			path: [],
			message:
				'This document contains nodes, Marks or attributes that the declared Markdown mappings cannot preserve.',
		})
	return { ok: true, value: { markdown, lossless: issues.length === 0, issues } }
}

const htmlTags: Record<string, readonly string[]> = {
	html: [],
	head: [],
	body: [],
	meta: ['charset'],
	p: ['style'],
	h1: ['style'],
	h2: ['style'],
	h3: ['style'],
	h4: ['style'],
	h5: ['style'],
	h6: ['style'],
	blockquote: [],
	ul: [],
	ol: ['start', 'type'],
	li: [],
	br: [],
	hr: [],
	pre: [],
	code: ['class'],
	strong: [],
	b: [],
	em: [],
	i: [],
	s: [],
	strike: [],
	del: [],
	u: [],
	span: ['style'],
	a: ['href', 'target', 'rel', 'class'],
	table: ['style'],
	thead: [],
	tbody: [],
	tfoot: [],
	tr: [],
	td: ['colspan', 'rowspan', 'colwidth', 'align', 'style'],
	th: ['colspan', 'rowspan', 'colwidth', 'align', 'style'],
	colgroup: [],
	col: ['width', 'style'],
	img: ['src', 'alt', 'title', 'width', 'height'],
	'data-field': ['path'],
}

function htmlAttributes(tag: string, config: TypstEditorConfig): readonly string[] | undefined {
	if (tag === 'table' && tableStyleOptions(config.extensions))
		return [...htmlTags.table!, 'data-typst-table-style', 'data-typst-table-appearance']
	return (
		htmlTags[tag] ??
		Object.values(config.nodeMappings ?? {}).find((mapping) => mapping.html?.tag === tag)?.html
			?.attributes
	)
}

/** Admission scans the original syntax because DOMParser repairs malformed tables
 * and removes duplicate attributes before callers can inspect the DOM. */
function inspectOriginalHtml(
	html: string,
	config: TypstEditorConfig,
	regionId: string,
	originalTags: Map<string, number>,
): TypstEditorIssue[] {
	const issues: TypstEditorIssue[] = []
	let cursor = 0
	while ((cursor = html.indexOf('<', cursor)) !== -1) {
		if (html.startsWith('<!--', cursor)) {
			const end = html.indexOf('-->', cursor + 4)
			if (end < 0) {
				issues.push({ code: 'UNSUPPORTED_HTML', regionId, message: 'Unclosed HTML comment.' })
				break
			}
			cursor = end + 3
			continue
		}
		const opening = /^<\/?([a-z][a-z0-9:-]*)\b/i.exec(html.slice(cursor))
		if (!opening) {
			cursor++
			continue
		}
		const tag = opening[1]!.toLowerCase()
		if (html[cursor + 1] !== '/' && !['html', 'head', 'body', 'meta'].includes(tag))
			originalTags.set(tag, (originalTags.get(tag) ?? 0) + 1)
		let end = cursor + opening[0].length
		let quote = ''
		for (; end < html.length; end++) {
			const character = html[end]!
			if (quote) {
				if (character === quote) quote = ''
			} else if (character === '"' || character === "'") quote = character
			else if (character === '>') break
		}
		if (end === html.length) {
			issues.push({ code: 'UNSUPPORTED_HTML', regionId, message: `Unclosed HTML tag: ${tag}.` })
			break
		}
		const allowed = htmlAttributes(tag, config)
		if (!allowed)
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId,
				message: `HTML tag ${tag} has no supported input mapping.`,
			})
		let rest = html.slice(cursor + opening[0].length, end).replace(/\s*\/\s*$/, '')
		const names = new Set<string>()
		while (rest.trim()) {
			const attr = /^\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(rest)
			if (!attr) {
				issues.push({
					code: 'UNSUPPORTED_HTML',
					regionId,
					message: `Malformed HTML attributes on ${tag}.`,
				})
				break
			}
			const name = attr[1]!.toLowerCase()
			if (names.has(name))
				issues.push({
					code: 'UNSUPPORTED_HTML',
					regionId,
					path: [tag, name],
					message: `Duplicate original HTML attribute: ${name}.`,
				})
			names.add(name)
			if (name !== 'data-pm-slice' && !allowed?.includes(name))
				issues.push({
					code: 'UNSUPPORTED_HTML',
					regionId,
					path: [tag, name],
					message: `Unsupported original ${tag} attribute: ${name}.`,
				})
			rest = rest.slice(attr[0].length)
		}
		cursor = end + 1
	}
	return issues
}

/** Project supported HTML column widths into the official native cell attrs. */
function projectHtmlColumnWidths(document: Document, regionId: string): TypstEditorIssue[] {
	const issues: TypstEditorIssue[] = []
	for (const table of Array.from(document.body.querySelectorAll('table'))) {
		const columns = Array.from(table.querySelectorAll(':scope > colgroup > col'))
		if (columns.length === 0) continue
		const widths = columns.map((column) => {
			const attribute = column.getAttribute('width')
			const style = (column as HTMLElement).style.width
			return attribute !== null
				? Number(attribute.replace(/px$/, ''))
				: style
					? Number(style.replace(/px$/, ''))
					: 0
		})
		if (widths.some((width) => !Number.isSafeInteger(width) || width < 0)) {
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId,
				message: 'HTML column widths must be non-negative integer pixels.',
			})
			continue
		}
		const rows = Array.from(
			table.querySelectorAll(
				':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr',
			),
		)
		const cellElements: Element[] = []
		const structure: JSONContent = {
			type: 'table',
			content: rows.map((row) => ({
				type: 'tableRow',
				content: Array.from(row.children)
					.filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
					.map((cell) => {
						cellElements.push(cell)
						return {
							type: cell.tagName === 'TH' ? 'tableHeader' : 'tableCell',
							attrs: {
								colspan: Number(cell.getAttribute('colspan') ?? 1),
								rowspan: Number(cell.getAttribute('rowspan') ?? 1),
							},
						}
					}),
			})),
		}
		const grid = tableGrid(structure)
		if (typeof grid === 'string' || grid.columns !== widths.length) {
			issues.push({
				code: 'INVALID_TABLE',
				regionId,
				message:
					typeof grid === 'string' ? grid : 'HTML colgroup width does not match the table grid.',
			})
			continue
		}
		for (let index = 0; index < grid.cells.length; index++) {
			const cell = cellElements[index]!
			if (cell.hasAttribute('colwidth')) continue
			const { x, node } = grid.cells[index]!
			const span = node.attrs!.colspan as number
			const cellWidths = widths.slice(x, x + span)
			if (cellWidths.some((width) => width > 0)) cell.setAttribute('colwidth', cellWidths.join(','))
		}
	}
	return issues
}

/** Browser HTML intake checks original tags/attrs before ProseMirror normalization. */
export function parseTypstHtml(
	options: RegionInput & { html: string },
): TypstEditorResult<JSONContent> {
	const checked = editorSchema(options.config)
	if (!checked.ok) return checked
	if (typeof globalThis.DOMParser === 'undefined')
		throw new TypeError(
			'HTML intake requires the browser DOMParser. Use parseTypstMarkdown for portable no-DOM input.',
		)
	const originalTags = new Map<string, number>()
	const originalIssues = inspectOriginalHtml(
		options.html,
		options.config,
		options.regionId,
		originalTags,
	)
	if (originalIssues.length > 0) return { ok: false, issues: originalIssues }
	const document = new globalThis.DOMParser().parseFromString(options.html, 'text/html')
	const issues: TypstEditorIssue[] = []
	for (const [tag, count] of originalTags)
		if (document.body.querySelectorAll(tag).length < count)
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId: options.regionId,
				path: [tag],
				message: `The browser discarded original ${tag} elements while repairing malformed HTML.`,
			})
	const inspect = (element: Element, path: (string | number)[]) => {
		const tag = element.tagName.toLowerCase()
		const custom = Object.values(options.config.nodeMappings ?? {}).find(
			(mapping) => mapping.html?.tag === tag,
		)?.html
		const allowed = htmlAttributes(tag, options.config)
		if (!allowed)
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId: options.regionId,
				path,
				message: `HTML tag ${tag} has no supported input mapping.`,
			})
		const rawAttributes = Object.fromEntries(
			Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]),
		)
		if (tag === 'table') {
			const tableOptions = tableStyleOptions(options.config.extensions)
			const style = rawAttributes['data-typst-table-style']
			const appearance = rawAttributes['data-typst-table-appearance']
			const error =
				tableOptions && tableStyleError(style === 'inherit' ? null : style, tableOptions)
			if (
				error ||
				(appearance !== undefined &&
					!['grid', 'grid-open-sides', 'three-line', 'borderless'].includes(appearance))
			)
				issues.push({
					code: 'UNSUPPORTED_HTML',
					regionId: options.regionId,
					path,
					message: error ?? 'Invalid table appearance metadata.',
				})
		}
		const admission = custom?.validateAttributes?.(rawAttributes)
		if (admission !== undefined && admission !== true)
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId: options.regionId,
				path,
				message:
					typeof admission === 'string' ? admission : 'Custom HTML attributes failed admission.',
			})
		for (const attribute of Array.from(element.attributes)) {
			if (attribute.name === 'data-pm-slice') continue
			if (!allowed?.includes(attribute.name))
				issues.push({
					code: 'UNSUPPORTED_HTML',
					regionId: options.regionId,
					path: [...path, attribute.name],
					message: `Unsupported ${tag} attribute: ${attribute.name}.`,
				})
			if (attribute.name === 'style' && !custom) {
				const declarations = attribute.value
					.split(';')
					.map((part) => part.trim())
					.filter(Boolean)
				const textBlock = tag === 'p' || /^h[1-6]$/.test(tag)
				const styleError =
					tag === 'span'
						? textStyleDeclarationError(attribute.value)
						: textBlock
							? textAlignmentDeclarationError(attribute.value)
							: undefined
				const valid =
					tag === 'span' || textBlock
						? styleError === undefined
						: declarations.every((declaration) =>
								tag === 'td' || tag === 'th'
									? /^text-align\s*:\s*(?:left|center|right)$/i.test(declaration)
									: /^(?:min-width|width)\s*:\s*\d+(?:\.\d+)?px$/i.test(declaration),
							)
				if (!valid)
					issues.push({
						code: 'UNSUPPORTED_HTML',
						regionId: options.regionId,
						path: [...path, 'style'],
						message:
							styleError ??
							'HTML styles must map to supported inline text styles, table column widths or cell alignment.',
					})
			}
			if (
				attribute.name === 'class' &&
				tag === 'code' &&
				(!/^language-[\w.+-]+$/.test(attribute.value) ||
					element.parentElement?.tagName.toLowerCase() !== 'pre')
			)
				issues.push({
					code: 'UNSUPPORTED_HTML',
					regionId: options.regionId,
					path: [...path, 'class'],
					message: 'Only a code block language class is supported.',
				})
		}
		if (tag === 'data-field' && (element.children.length > 0 || element.textContent?.trim()))
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId: options.regionId,
				path,
				message: 'A controlled data-field tag must be empty.',
			})
		Array.from(element.children).forEach((child, index) => inspect(child, [...path, index]))
	}
	Array.from(document.body.children).forEach((element, index) => inspect(element, [index]))
	if (
		Array.from(document.head.children).some(
			(element) =>
				element.tagName !== 'META' ||
				Array.from(element.attributes).some((attribute) => attribute.name !== 'charset'),
		)
	)
		issues.push({
			code: 'UNSUPPORTED_HTML',
			regionId: options.regionId,
			path: [],
			message: 'HTML metadata, scripts and styles are not editable content.',
		})
	if (issues.length > 0) return { ok: false, issues }
	issues.push(...projectHtmlColumnWidths(document, options.regionId))
	if (issues.length > 0) return { ok: false, issues }
	const parsed = ProseMirrorDOMParser.fromSchema(checked.value)
		.parse(document.body, { preserveWhitespace: 'full' })
		.toJSON() as JSONContent
	const nodeCounts = new Map<string, number>()
	const countNodes = (node: JSONContent) => {
		// Official TextStyleKit parseHTML returns '' for absent CSS properties.
		// Original declarations have already passed strict admission above, so only
		// these missing-property placeholders are projected to native null defaults.
		for (const mark of node.marks ?? [])
			if (mark.type === 'textStyle')
				for (const attribute of textStyleAttributes)
					if (mark.attrs?.[attribute] === '') mark.attrs[attribute] = null
		nodeCounts.set(node.type!, (nodeCounts.get(node.type!) ?? 0) + 1)
		node.content?.forEach(countNodes)
	}
	countNodes(parsed)
	for (const [name, mapping] of Object.entries(options.config.nodeMappings ?? {}))
		if (mapping.html && (nodeCounts.get(name) ?? 0) < (originalTags.get(mapping.html.tag) ?? 0))
			issues.push({
				code: 'UNSUPPORTED_HTML',
				regionId: options.regionId,
				path: [mapping.html.tag],
				message: `The ${name} extension did not preserve its admitted HTML nodes.`,
			})
	if (issues.length > 0) return { ok: false, issues }
	return validateTypstRegion({ ...options, document: parsed })
}

/** Ordinary paste preserves plain text; only explicit GFM tables are auto-detected. */
export function parseTypstClipboard(
	options: RegionInput & { html?: string; text: string; asMarkdown?: boolean },
): TypstEditorResult<JSONContent> {
	if (options.asMarkdown) return parseTypstMarkdown({ ...options, markdown: options.text })
	if (options.html?.trim()) return parseTypstHtml({ ...options, html: options.html })
	const checked = editorSchema(options.config)
	if (!checked.ok) return checked
	const markdown = manager(options.config)
	const tokens = markdown.instance.lexer(options.text)
	const hasTableToken = (value: unknown): boolean => {
		if (!value || typeof value !== 'object') return false
		if (Array.isArray(value)) return value.some(hasTableToken)
		const token = value as Record<string, unknown>
		if (token.type === 'code' || token.type === 'codespan') return false
		return token.type === 'table' || Object.values(token).some(hasTableToken)
	}
	const hasTable = hasTableToken(tokens)
	if (hasTable) return parseTypstMarkdown({ ...options, markdown: options.text })
	const document: JSONContent = {
		type: 'doc',
		content: options.text
			.split(/\r?\n/)
			.map((text) =>
				text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' },
			),
	}
	return validateTypstRegion({ ...options, document })
}
