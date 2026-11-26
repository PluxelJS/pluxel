import type { JSONContent } from '@tiptap/core'
import { fontFamilyName } from '../tiptap/text-style.js'
import { bodyNumber, bodyString, bodyText, relativeColumnWidths } from './body-values.js'

export type DocumentPath = readonly (string | number)[]
export class InvalidBodyDocument extends Error {
	constructor(
		readonly path: DocumentPath,
		message: string,
	) {
		super(message)
	}
}

type Mark = NonNullable<JSONContent['marks']>[number]
const markCalls: Readonly<Record<string, string>> = {
	bold: 'strong',
	italic: 'emph',
	strike: 'strike',
	underline: 'underline',
	subscript: 'sub',
	superscript: 'super',
}

function wrap(source: string, mark: Mark): string {
	if (Object.hasOwn(markCalls, mark.type)) return `#${markCalls[mark.type]}[${source}]`
	if (mark.type === 'link') return `#link(${bodyString(mark.attrs!.href)})[${source}]`
	if (mark.type === 'textStyle') {
		const { fontFamily, fontSize, color, backgroundColor } = mark.attrs ?? {}
		const args = []
		if (fontFamily) args.push(`font: ${bodyString(fontFamilyName(fontFamily)!)}`)
		if (fontSize) args.push(`size: ${fontSize}`)
		if (color) args.push(`fill: rgb(${bodyString(color)})`)
		if (args.length > 0) source = `#text(${args.join(', ')})[${source}]`
		if (backgroundColor) source = `#highlight(fill: rgb(${bodyString(backgroundColor)}))[${source}]`
	}
	return source
}

function inline(node: JSONContent): string {
	const attrs = node.attrs ?? {}
	const marks = node.marks ?? []
	let source: string
	switch (node.type) {
		case 'text':
			source = marks.some(({ type }) => type === 'code')
				? `#raw(${bodyString(node.text!)})`
				: bodyText(node.text!)
			break
		case 'hardBreak':
			source = '#linebreak()'
			break
		case 'inlineMath':
			source = `$${attrs.expression}$`
			break
		case 'reference':
			source =
				attrs.showCaption == null
					? `#ref(<${attrs.target}>)`
					: `#metadata((__pluxel_reference: true, target: <${attrs.target}>, show-caption: ${attrs.showCaption}))`
			break
		default:
			throw new Error(`Cannot emit inline body node ${node.type}`)
	}
	return marks.reduceRight(wrap, source)
}

function formatSize(value: number | string): string {
	return typeof value === 'number' ? bodyNumber(value * 0.75) + 'pt' : value
}

function formatImage(node: JSONContent) {
	const { src, alt, width, height } = node.attrs!
	const args = [bodyString(src)]
	if (alt != null) args.push(`alt: ${bodyString(alt)}`)
	if (width != null) args.push(`width: ${formatSize(width)}`)
	if (height != null) args.push(`height: ${formatSize(height)}`)
	return `#image(${args.join(', ')})`
}

function labelled(body: string, label: unknown) {
	return label ? body + ` <${label}>` : body
}

interface CellPlacement {
	cell: JSONContent
	col: number
	colspan: number
	rowspan: number
	path: DocumentPath
}

/** Both the layout and canonical Tiptap widths come from the same checked grid. */
function table(node: JSONContent, path: DocumentPath): string {
	const rows = node.content!
	const occupied = new Map<number, Set<number>>()
	const widths: number[] = []
	const placements: CellPlacement[] = []
	let width = 0
	let headerRows = 0
	let lastHeaderSpan = 0
	for (const [row, current] of rows.entries()) {
		let col = 0
		const cells = current.content ?? []
		const hasHeaders = cells.some(({ type }) => type === 'tableHeader')
		if (hasHeaders && (row > headerRows || cells.some(({ type }) => type !== 'tableHeader')))
			throw new InvalidBodyDocument(
				[...path, 'content', row],
				'Table heading rows must come first and contain only headings',
			)
		if (hasHeaders || (row === headerRows && cells.length === 0 && row < lastHeaderSpan))
			headerRows++
		for (const [index, cell] of cells.entries()) {
			const cellPath = [...path, 'content', row, 'content', index]
			const { colspan, rowspan, colwidth } = cell.attrs!
			while (occupied.get(row)?.has(col)) col++
			if (row + rowspan > rows.length || col + colspan > 256)
				throw new InvalidBodyDocument(
					cellPath,
					'Table cell spans exceed a bounded rectangular grid',
				)
			if (hasHeaders) lastHeaderSpan = Math.max(lastHeaderSpan, row + rowspan)
			else if (row < lastHeaderSpan)
				throw new InvalidBodyDocument(cellPath, 'Heading cells must not span into body rows')
			for (let y = row; y < row + rowspan; y++) {
				let places = occupied.get(y)
				if (!places) occupied.set(y, (places = new Set()))
				for (let x = col; x < col + colspan; x++) {
					if (places.has(x)) throw new InvalidBodyDocument(cellPath, 'Overlapping table cells')
					places.add(x)
				}
			}
			for (const [offset, value] of ((colwidth ?? []) as number[]).entries()) {
				if (value && widths[col + offset] && value !== widths[col + offset])
					throw new InvalidBodyDocument(cellPath, 'Conflicting widths in one table column')
				if (value) widths[col + offset] = value
			}
			placements.push({ cell, col, colspan, rowspan, path: cellPath })
			col += colspan
			width = Math.max(width, col)
		}
	}
	if (
		width === 0 ||
		rows.length * width > 65536 ||
		rows.some((_, row) => occupied.get(row)?.size !== width)
	)
		throw new InvalidBodyDocument(path, 'Expected a complete table grid')
	const relative: string[] | null = node.attrs?.columnWidths ?? null
	if (relative && relative.length !== 1 && relative.length !== width)
		throw new InvalidBodyDocument(
			[...path, 'attrs', 'columnWidths'],
			'Expected one width per table column',
		)
	const columns = Array.from({ length: width }, (_, i) =>
		widths[i] ? 'auto' : (relative?.[relative.length === 1 ? 0 : i] ?? 'auto'),
	)
	node.attrs!.columnWidths = relativeColumnWidths(columns)
	const dimensions = columns.map((value, i) => (widths[i] ? formatSize(widths[i]!) : value))
	const count = dimensions.some((value) => value !== 'auto')
		? `(${dimensions.join(', ')}${dimensions.length === 1 ? ',' : ''})`
		: String(width)
	const formatCell = ({ cell, colspan, rowspan, col, path: cellPath }: CellPlacement) => {
		const measured = Array.from({ length: colspan }, (_, offset) => widths[col + offset] ?? 0)
		cell.attrs!.colwidth = measured.some(Boolean) ? measured : null
		const args = []
		if (colspan > 1) args.push(`colspan: ${colspan}`)
		if (rowspan > 1) args.push(`rowspan: ${rowspan}`)
		if (cell.attrs?.align) args.push(`align: ${cell.attrs.align}`)
		const body = `[${blocks(cell.content!, [...cellPath, 'content'])}]`
		return args.length > 0 ? `table.cell(${args.join(', ')})${body}` : body
	}
	const header = placements.filter(({ cell }) => cell.type === 'tableHeader').map(formatCell)
	const body = placements.filter(({ cell }) => cell.type === 'tableCell').map(formatCell)
	const stroke =
		node.attrs?.tableStyle === 'borderless'
			? ', stroke: none'
			: node.attrs?.tableStyle === 'grid'
				? ', stroke: 1pt'
				: ''
	const cells = header.length > 0 ? [`table.header(${header.join(', ')})`, ...body] : body
	return `#table(columns: ${count}${stroke},\n  ${cells.join(',\n  ')},\n)`
}

function block(node: JSONContent, path: DocumentPath): string {
	const attrs = node.attrs ?? {}
	const inlineBody = () => (node.content ?? []).map(inline).join('')
	switch (node.type) {
		case 'paragraph': {
			const body = inlineBody()
			if (attrs.textAlign === 'justify') return `#par(justify: true)[${body}]`
			if (attrs.textAlign) return `#align(${attrs.textAlign})[#par[${body}]]`
			return body || '#par[]'
		}
		case 'heading': {
			const body = inlineBody()
			if (attrs.textAlign === 'justify')
				return labelled(
					`#heading(level: ${attrs.level})[#par(justify: true)[${body}]]`,
					attrs.label,
				)
			if (attrs.textAlign)
				return `#align(${attrs.textAlign})[${labelled(`#heading(level: ${attrs.level})[${body}]`, attrs.label)}]`
			return labelled(
				body ? `${'='.repeat(attrs.level)} ${body}` : `#heading(level: ${attrs.level})[]`,
				attrs.label,
			)
		}
		case 'blockquote':
			return `#quote(block: true)[${blocks(node.content!, [...path, 'content'])}]`
		case 'codeBlock': {
			const text = (node.content ?? []).map((child) => child.text).join('')
			const lang = attrs.language ? `, lang: ${bodyString(attrs.language)}` : ''
			return `#raw(${bodyString(text)}, block: true${lang})`
		}
		case 'horizontalRule':
			return '#line(length: 100%)'
		case 'bulletList':
		case 'orderedList': {
			const args: string[] = []
			if (node.type === 'orderedList') {
				if (attrs.start !== 1) args.push(`start: ${attrs.start}`)
				if (attrs.type) args.push(`numbering: ${bodyString(attrs.type + '.')}`)
			}
			const items = node.content!.map(
				(item, index) => `[${blocks(item.content!, [...path, 'content', index, 'content'])}]`,
			)
			return `#${node.type === 'bulletList' ? 'list' : 'enum'}(\n  ${[...args, ...items].join(',\n  ')},\n)`
		}
		case 'image':
			return formatImage(node)
		case 'table':
			return table(node, path)
		case 'figure': {
			const [body, caption] = node.content!
			const rendered = block(body!, [...path, 'content', 0]).slice(1)
			const text = caption?.content?.map(inline).join('') ?? ''
			return labelled(`#figure(${rendered}, caption: [${text}])`, attrs.label)
		}
		case 'blockMath':
			return labelled(`$ ${attrs.expression} $`, attrs.label)
		default:
			throw new Error(`Cannot emit block body node ${node.type}`)
	}
}

function blocks(nodes: JSONContent[], path: DocumentPath) {
	return nodes.map((node, index) => block(node, [...path, index])).join('\n\n')
}

export function writeTypstBody(document: JSONContent): string {
	const content = document.content!
	const first = content[0]
	if (
		content.length === 1 &&
		first?.type === 'paragraph' &&
		!first.content?.length &&
		!first.attrs?.textAlign
	)
		return ''
	return blocks(content, ['content']) + '\n'
}
