import type { AstContentBlock, AstExpr, AstFuncCall, SyntaxNode } from '@r4ai/typst-ast-node'
import type { JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { sourceSlice } from '../source/parse.js'
import type { TypstParsedSource, TypstSourceMapping } from '../source/types.js'
import { validReferenceLabel } from '../tiptap/document-nodes.js'
import { bodyMath } from './body-math.js'
import {
	bodyColor,
	bodyFont,
	bodyImagePath,
	bodyLanguage,
	bodyLink,
	bodyNumber,
	bodyPixels,
	relativeColumnWidths,
} from './body-values.js'

type Range = [from: number, to: number]
type Mark = NonNullable<JSONContent['marks']>[number]
type TextPart = { text: string; range: Range }
interface Projected {
	json: JSONContent & { type: string }
	range: Range
	children: Projected[]
	parts?: TextPart[]
}

export class UnsupportedBodySyntax extends Error {
	constructor(
		readonly range: Range,
		message: string,
	) {
		super(message)
	}
}

const styleMarks: Readonly<Record<string, string>> = {
	strong: 'bold',
	emph: 'italic',
	strike: 'strike',
	underline: 'underline',
	sub: 'subscript',
	super: 'superscript',
}
const colors: Readonly<Record<string, string>> = {
	black: '#000000',
	white: '#ffffff',
	gray: '#aaaaaa',
	red: '#ff4136',
	green: '#2ecc40',
	blue: '#0074d9',
}

function callee(call: AstFuncCall): string | undefined {
	const target = call.callee
	if (target.kind === 'ident') return target.name
	if (target.kind === 'fieldAccess' && target.target.kind === 'ident')
		return target.target.name + '.' + target.field
	return undefined
}

function comment(node: SyntaxNode): SyntaxNode | undefined {
	if (node.kind === 'LineComment' || node.kind === 'BlockComment') return node
	for (const child of node.children) {
		const found = comment(child)
		if (found) return found
	}
	return undefined
}

function projected(
	type: string,
	range: Range,
	children: Projected[] = [],
	attrs?: Record<string, unknown>,
): Projected {
	return { json: { type, ...(attrs && { attrs }) }, range, children }
}

function utf8Width(character: string): number {
	const point = character.codePointAt(0)!
	return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
}

function characters(text: string, range: Range): TextPart[] {
	const parts: TextPart[] = []
	let byte = range[0]
	for (const character of text) {
		const to = byte + utf8Width(character)
		parts.push({ text: character, range: [byte, to] })
		byte = to
	}
	return byte === range[1] ? parts : [{ text, range }]
}

function append(output: Projected[], next: Projected) {
	const previous = output.at(-1)
	if (
		previous?.parts &&
		next.parts &&
		JSON.stringify(previous.json.marks) === JSON.stringify(next.json.marks)
	) {
		previous.json.text += next.json.text!
		previous.range = [previous.range[0], next.range[1]]
		for (const part of next.parts) previous.parts.push(part)
	} else output.push(next)
}

class BodyReader {
	private readonly rank: readonly string[]

	constructor(
		private readonly source: TypstParsedSource,
		private readonly schema: Schema,
	) {
		this.rank = Object.keys(schema.marks)
	}

	range(expr: AstExpr, leadingHash = false): Range {
		const [from, to] = expr.range ?? this.source.cst.range
		return [
			leadingHash &&
			this.source.byteToUtf16.has(from - 1) &&
			sourceSlice(this.source, from - 1, from) === '#'
				? from - 1
				: from,
			to,
		]
	}

	private fail(expr: AstExpr, message: string): never {
		throw new UnsupportedBodySyntax(this.range(expr, expr.kind === 'funcCall'), message)
	}

	private args(call: AstFuncCall, keys: readonly string[], arity: number | [number, number]) {
		const named = new Map<string, AstExpr>()
		const positional: AstExpr[] = []
		for (const arg of call.args) {
			if (arg.kind === 'pos') positional.push(arg.expr)
			else if (arg.kind === 'named' && keys.includes(arg.name) && !named.has(arg.name))
				named.set(arg.name, arg.expr)
			else this.fail(arg.expr, 'Unexpected or repeated argument in a body function')
		}
		const [min, max] = typeof arity === 'number' ? [arity, arity] : arity
		if (positional.length < min || positional.length > max)
			this.fail(call, 'Unexpected number of arguments in a body function')
		return { named, positional }
	}

	private content(value: AstExpr): AstContentBlock {
		if (value.kind === 'contentBlock') return value
		return this.fail(value, 'Expected a literal content block')
	}

	private color(expr: AstExpr): string {
		if (expr.kind === 'ident' && Object.hasOwn(colors, expr.name)) return colors[expr.name]!
		if (expr.kind === 'funcCall' && callee(expr) === 'rgb') {
			const { positional } = this.args(expr, [], [1, 4])
			if (
				positional.length === 1 &&
				positional[0]?.kind === 'str' &&
				/^#[\da-f]+$/i.test(positional[0].value)
			) {
				const color = bodyColor(positional[0].value)
				if (color) return color
			}
			const [red, green, blue, alpha] = positional
			if (
				[red, green, blue].every(
					(arg) => arg?.kind === 'int' && arg.value >= 0 && arg.value <= 255,
				) &&
				(!alpha ||
					(alpha.kind === 'numeric' &&
						alpha.unit === 'percent' &&
						alpha.value >= 0 &&
						alpha.value <= 100))
			) {
				const channels = [red, green, blue] as { value: number }[]
				const opacity = alpha?.kind === 'numeric' ? Math.round((alpha.value / 100) * 255) : 255
				return (
					'#' +
					[...channels.map(({ value }) => value), ...(opacity === 255 ? [] : [opacity])]
						.map((value) => value.toString(16).padStart(2, '0'))
						.join('')
				)
			}
		}
		return this.fail(expr, 'Expected a supported literal color')
	}

	private textStyle(named: ReadonlyMap<string, AstExpr>) {
		const result: Record<string, unknown> = {}
		const font = named.get('font')
		if (font) {
			const family = font.kind === 'str' ? bodyFont('"' + font.value + '"') : undefined
			if (!family) this.fail(font, 'Expected one literal font family')
			result.fontFamily = family
		}
		const size = named.get('size')
		if (size) {
			if (
				size.kind !== 'numeric' ||
				size.unit !== 'pt' ||
				!(size.value > 0 && Number.isFinite(size.value))
			)
				this.fail(size, 'Expected a positive literal font size in pt')
			result.fontSize = bodyNumber(size.value) + 'pt'
		}
		const fill = named.get('fill')
		if (fill) result.color = this.color(fill)
		return result
	}

	private marked(marks: Mark[], type: string, attrs?: Record<string, unknown>): Mark[] {
		const previous = marks.find((mark) => mark.type === type)
		const mark =
			type === 'textStyle'
				? { type, attrs: { ...previous?.attrs, ...attrs } }
				: { type, ...(attrs ? { attrs } : {}) }
		const canonical = this.schema.mark(type, mark.attrs).toJSON() as Mark
		return [...marks.filter((item) => item.type !== type), canonical].sort(
			(a, b) => this.rank.indexOf(a.type) - this.rank.indexOf(b.type),
		)
	}

	private text(value: string, range: Range, marks: Mark[], direct = false): Projected[] {
		if (!value) return []
		return [
			{
				json: { type: 'text', text: value, ...(marks.length > 0 && { marks }) },
				range,
				children: [],
				parts: direct ? characters(value, range) : [{ text: value, range }],
			},
		]
	}

	private literal(value: string, range: Range, marks: Mark[]): Projected[] {
		const body = sourceSlice(this.source, range[0] + 1, range[1] - 1)
		const result = this.text(value, range, marks)
		if (!result[0]) return result
		const parts: TextPart[] = []
		let byte = range[0] + 1
		for (const match of body.matchAll(/\\u\{[0-9a-fA-F]+\}|\\[\s\S]|[\s\S]/gu)) {
			const token = match[0]
			let text = token
			if (token.startsWith('\\')) {
				if (token.startsWith('\\u{')) {
					const code = Number.parseInt(token.slice(3, -1), 16)
					if (code > 0x10ffff) return result
					text = String.fromCodePoint(code)
				} else {
					const character = token[1]!
					text =
						({ n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' } as Record<string, string>)[
							character
						] ?? token
				}
			}
			let to = byte
			for (const character of token) to += utf8Width(character)
			parts.push({ text, range: [byte, to] })
			byte = to
		}
		if (parts.map(({ text }) => text).join('') === value) result[0].parts = parts
		return result
	}

	private label(value: AstExpr): string {
		if (value.kind === 'label' && validReferenceLabel(value.name)) return value.name
		return this.fail(value, 'Expected a literal Typst label')
	}

	private reference(expr: AstExpr, target: unknown, showCaption: boolean | null, marks: Mark[]) {
		if (!validReferenceLabel(target)) return this.fail(expr, 'Expected a literal reference label')
		const node = projected('reference', this.range(expr, expr.kind === 'funcCall'), [], {
			target,
			showCaption,
		})
		if (marks.length > 0) node.json.marks = marks
		return node
	}

	private metadata(expr: AstFuncCall, marks: Mark[]) {
		const {
			positional: [payload],
		} = this.args(expr, [], 1)
		if (payload?.kind !== 'dict' || payload.items.length !== 3)
			this.fail(expr, 'Expected the literal caption-reference metadata')
		const fields = new Map<string, AstExpr>()
		for (const item of payload.items) {
			if (item.kind !== 'named' || fields.has(item.name))
				this.fail(payload, 'Unexpected reference metadata field')
			fields.set(item.name, item.expr)
		}
		const flag = fields.get('__pluxel_reference')
		const target = fields.get('target')
		const caption = fields.get('show-caption')
		if (flag?.kind !== 'bool' || !flag.value || !target || caption?.kind !== 'bool')
			this.fail(payload, 'Expected the literal caption-reference metadata')
		return this.reference(expr, this.label(target), caption.value, marks)
	}

	private equation(expr: Extract<AstExpr, { kind: 'equation' }>) {
		const range = this.range(expr)
		const expression = bodyMath(sourceSlice(this.source, range[0] + 1, range[1] - 1), expr.block)
		if (!expression) this.fail(expr, 'Expected a supported native math expression')
		return projected(expr.block ? 'blockMath' : 'inlineMath', range, [], { expression })
	}

	private inline(expr: AstExpr, marks: Mark[]): Projected[] {
		const range = this.range(expr)
		switch (expr.kind) {
			case 'text':
				return this.text(expr.text, range, marks, sourceSlice(this.source, ...range) === expr.text)
			case 'escape':
			case 'shorthand':
				return this.text(expr.character, range, marks)
			case 'space':
				return this.text(' ', range, marks)
			case 'strong':
				return this.inlines(expr.body, this.marked(marks, 'bold'))
			case 'emph':
				return this.inlines(expr.body, this.marked(marks, 'italic'))
			case 'linebreak': {
				const node = projected('hardBreak', range)
				if (marks.length > 0) node.json.marks = marks
				return [node]
			}
			case 'raw':
				if (!expr.block && !expr.lang)
					return this.text(expr.lines.join('\n'), range, this.marked(marks, 'code'))
				break
			case 'link':
				if (bodyLink(expr.url))
					return this.text(expr.url, range, this.marked(marks, 'link', { href: expr.url }), true)
				break
			case 'ref':
				if (!expr.supplement) return [this.reference(expr, expr.target, null, marks)]
				break
			case 'equation': {
				if (expr.block) break
				const node = this.equation(expr)
				if (marks.length > 0) node.json.marks = marks
				return [node]
			}
			case 'funcCall':
				return this.inlineCall(expr, marks)
		}
		return this.fail(expr, 'Unsupported Typst syntax in inline body content')
	}

	private inlineCall(expr: AstFuncCall, marks: Mark[]): Projected[] {
		const name = callee(expr)
		if (name && Object.hasOwn(styleMarks, name)) {
			const { positional } = this.args(expr, [], 1)
			return this.inlines(this.content(positional[0]!).body, this.marked(marks, styleMarks[name]!))
		}
		if (name === 'text' || name === 'highlight') {
			const {
				named,
				positional: [body],
			} = this.args(expr, name === 'text' ? ['font', 'size', 'fill'] : ['fill'], 1)
			const fill = named.get('fill')
			if (name === 'highlight' && !fill)
				this.fail(expr, 'A highlight requires a literal fill color')
			const style = name === 'text' ? this.textStyle(named) : { backgroundColor: this.color(fill!) }
			const next = Object.keys(style).length > 0 ? this.marked(marks, 'textStyle', style) : marks
			if (name === 'text' && body?.kind === 'str')
				return this.literal(body.value, this.range(body), next)
			return this.inlines(this.content(body!).body, next)
		}
		if (name === 'ref') {
			const { positional } = this.args(expr, [], 1)
			return [this.reference(expr, this.label(positional[0]!), null, marks)]
		}
		if (name === 'metadata') return [this.metadata(expr, marks)]
		if (name === 'link') {
			const {
				positional: [target, body],
			} = this.args(expr, [], 2)
			if (target?.kind !== 'str' || !bodyLink(target.value))
				this.fail(target!, 'Expected a supported literal link')
			if (marks.some(({ type }) => type === 'link')) this.fail(expr, 'Links must not be nested')
			return this.inlines(
				this.content(body!).body,
				this.marked(marks, 'link', { href: target.value }),
			)
		}
		if (name === 'raw') {
			const {
				positional: [body],
			} = this.args(expr, [], 1)
			if (body?.kind !== 'str') this.fail(body!, 'Expected literal raw text')
			return this.literal(body.value, this.range(body), this.marked(marks, 'code'))
		}
		if (name === 'linebreak') {
			this.args(expr, [], 0)
			const node = projected('hardBreak', this.range(expr, true))
			if (marks.length > 0) node.json.marks = marks
			return [node]
		}
		return this.fail(expr, 'Unsupported Typst body function')
	}

	private inlines(expressions: AstExpr[], marks: Mark[] = []): Projected[] {
		const result: Projected[] = []
		let space: AstExpr | undefined
		for (const expr of expressions) {
			if (expr.kind === 'space') {
				if (result.length > 0 && result.at(-1)?.json.type !== 'hardBreak') space = expr
				continue
			}
			const nodes = this.inline(expr, marks)
			if (space && nodes.length > 0 && nodes[0]?.json.type !== 'hardBreak')
				for (const node of this.inline(space, marks)) append(result, node)
			for (const node of nodes) append(result, node)
			space = undefined
		}
		return result
	}

	private dimension(expr: AstExpr | undefined): number | string | null {
		if (!expr) return null
		if (expr.kind === 'numeric' && expr.value > 0 && Number.isFinite(expr.value)) {
			if (expr.unit === 'pt' && Number.isFinite(expr.value / 0.75))
				return bodyPixels(expr.value / 0.75)
			if (expr.unit === 'percent') return bodyNumber(expr.value) + '%'
		}
		return this.fail(expr, 'Expected a positive literal size in pt or %')
	}

	private image(expr: AstFuncCall): Projected {
		const {
			named,
			positional: [source],
		} = this.args(expr, ['alt', 'width', 'height'], 1)
		const alt = named.get('alt')
		if (source?.kind !== 'str' || !bodyImagePath(source.value))
			this.fail(source!, 'Expected a literal project-local image path')
		if (alt && alt.kind !== 'str') this.fail(alt, 'Expected literal image alternative text')
		return projected('image', this.range(expr, true), [], {
			src: source.value,
			alt: alt?.value ?? null,
			width: this.dimension(named.get('width')),
			height: this.dimension(named.get('height')),
		})
	}

	private table(expr: AstFuncCall): Projected {
		const { named, positional } = this.args(expr, ['columns', 'stroke'], [1, Infinity])
		const columns = named.get('columns')
		let widths: string[] | null = null
		if (columns?.kind === 'array') {
			widths = columns.items.map((item) => {
				const value = item.expr
				if (item.kind !== 'pos') this.fail(value, 'Expected a literal column width')
				if (value.kind === 'auto') return 'auto'
				if (
					value.kind === 'numeric' &&
					value.value > 0 &&
					Number.isFinite(value.value) &&
					['pt', 'fr', 'percent'].includes(value.unit)
				)
					return bodyNumber(value.value) + (value.unit === 'percent' ? '%' : value.unit)
				return this.fail(value, 'Expected a literal column width in pt, fr, or %')
			})
		}
		const count = widths?.length ?? (columns?.kind === 'int' ? columns.value : 1)
		if (
			!Number.isSafeInteger(count) ||
			count < 1 ||
			count > 256 ||
			(columns && columns.kind !== 'int' && !widths)
		)
			this.fail(columns ?? expr, 'Expected 1–256 table columns')
		const stroke = named.get('stroke')
		const appearance =
			stroke?.kind === 'none'
				? 'borderless'
				: stroke?.kind === 'numeric' && stroke.unit === 'pt' && stroke.value === 1
					? 'grid'
					: null
		if (stroke && !appearance) this.fail(stroke, 'Expected a supported table stroke')

		const rows: Projected[][] = []
		const occupied = new Set<number>()
		const types = new Map<number, string>()
		let cursor = 0
		let rowCount = 0
		const cell = (candidate: AstExpr, type: 'tableCell' | 'tableHeader') => {
			let body: AstContentBlock
			let colspan = 1
			let rowspan = 1
			let align: string | null = null
			if (candidate.kind === 'funcCall' && callee(candidate) === 'table.cell') {
				const {
					named: cellArgs,
					positional: [value],
				} = this.args(candidate, ['rowspan', 'colspan', 'align'], 1)
				body = this.content(value!)
				for (const [key, span] of cellArgs) {
					if (key === 'align') {
						if (span.kind !== 'ident' || !['left', 'center', 'right'].includes(span.name))
							this.fail(span, 'Expected left, center, or right alignment')
						align = span.name
					} else {
						if (
							span.kind !== 'int' ||
							!Number.isSafeInteger(span.value) ||
							span.value < 1 ||
							span.value > 256
						)
							this.fail(span, 'Expected a cell span between 1 and 256')
						if (key === 'rowspan') rowspan = span.value
						else colspan = span.value
					}
				}
			} else body = this.content(candidate)
			while (occupied.has(cursor)) cursor++
			const row = Math.floor(cursor / count)
			const col = cursor % count
			if (col + colspan > count || (row + rowspan) * count > 65536)
				this.fail(candidate, 'Table cells must fit a bounded rectangular grid')
			rowCount = Math.max(rowCount, row + rowspan)
			for (let y = row; y < row + rowspan; y++) {
				if (types.has(y) && types.get(y) !== type)
					this.fail(candidate, 'Table heading rows and body rows must be separate')
				types.set(y, type)
				for (let x = col; x < col + colspan; x++) {
					const index = y * count + x
					if (occupied.has(index)) this.fail(candidate, 'Table cells cannot overlap')
					occupied.add(index)
				}
			}
			const measured = widths?.slice(col, col + colspan)
			const colwidth = measured?.map((width) =>
				width.endsWith('pt') ? bodyPixels(Number(width.slice(0, -2)) / 0.75) : 0,
			)
			const range = this.range(candidate)
			;(rows[row] ??= []).push(
				projected(type, range, this.blocks(body.body, this.range(body)), {
					colspan,
					rowspan,
					colwidth: colwidth?.some(Boolean) ? colwidth : null,
					align,
				}),
			)
			cursor += colspan
		}
		for (const [index, item] of positional.entries()) {
			if (item.kind === 'funcCall' && callee(item) === 'table.header') {
				if (index !== 0) this.fail(item, 'Table heading rows must come first')
				const header = this.args(item, [], [1, Infinity])
				for (const value of header.positional) cell(value, 'tableHeader')
			} else cell(item, 'tableCell')
		}
		if (occupied.size !== count * rowCount) this.fail(expr, 'Expected a complete table grid')
		const range = this.range(expr, true)
		const children = Array.from({ length: rowCount }, (_, index) => {
			const cells = rows[index] ?? []
			return projected(
				'tableRow',
				cells.length > 0 ? [cells[0]!.range[0], cells.at(-1)!.range[1]] : range,
				cells,
			)
		})
		// Absolute widths live in native cell colwidth attributes. Keep only the
		// remaining relative specification as a table attribute.
		const relative = widths?.map((width) => (width.endsWith('pt') ? 'auto' : width))
		return projected('table', range, children, {
			columnWidths: relativeColumnWidths(relative),
			...(appearance && { tableStyle: appearance }),
		})
	}

	private list(
		ordered: boolean,
		range: Range,
		items: { body: AstExpr[]; range: Range }[],
		attrs?: Record<string, unknown>,
	): Projected {
		const content = items.map(({ body, range: itemRange }) => {
			const children = this.blocks(body, itemRange)
			if (children[0]?.json.type !== 'paragraph')
				throw new UnsupportedBodySyntax(itemRange, 'Each list item must start with a paragraph')
			return projected('listItem', itemRange, children)
		})
		return projected(ordered ? 'orderedList' : 'bulletList', range, content, attrs)
	}

	private blockCall(expr: AstFuncCall): Projected | undefined {
		const name = callee(expr)
		const range = this.range(expr, true)
		if (name === 'par' || name === 'heading' || name === 'quote') {
			const key = name === 'par' ? 'justify' : name === 'heading' ? 'level' : 'block'
			const {
				named,
				positional: [value],
			} = this.args(expr, [key], 1)
			const body = this.content(value!)
			const option = named.get(key)
			if (name === 'heading') {
				if (option && (option.kind !== 'int' || option.value < 1 || option.value > 6))
					this.fail(option, 'Expected a heading level between 1 and 6')
				return this.heading(range, option?.value ?? 1, body.body)
			}
			if (name === 'quote') {
				if (option?.kind !== 'bool' || !option.value) this.fail(expr, 'Expected a block quote')
				return projected('blockquote', range, this.blocks(body.body, this.range(body)))
			}
			if (option && (option.kind !== 'bool' || !option.value))
				this.fail(option, 'Expected justify: true')
			return projected(
				'paragraph',
				range,
				this.inlines(body.body),
				option ? { textAlign: 'justify' } : undefined,
			)
		}
		if (name === 'align') {
			const {
				positional: [alignment, value],
			} = this.args(expr, [], 2)
			if (alignment?.kind !== 'ident' || !['left', 'center', 'right'].includes(alignment.name))
				this.fail(alignment!, 'Expected left, center, or right alignment')
			const body = this.content(value!)
			const children = this.blocks(body.body, this.range(body))
			const node = children[0]!
			if (
				children.length !== 1 ||
				!['paragraph', 'heading'].includes(node.json.type) ||
				node.json.attrs?.textAlign
			)
				this.fail(expr, 'Alignment applies to exactly one paragraph or heading')
			node.json.attrs = { ...node.json.attrs, textAlign: alignment.name }
			node.range = range
			return node
		}
		if (name === 'line') {
			const length = this.args(expr, ['length'], 0).named.get('length')
			if (length?.kind !== 'numeric' || length.unit !== 'percent' || length.value !== 100)
				this.fail(expr, 'Expected a full-width rule')
			return projected('horizontalRule', range)
		}
		if (name === 'raw') {
			if (!expr.args.some((arg) => arg.kind === 'named' && arg.name === 'block')) return
			const {
				named,
				positional: [body],
			} = this.args(expr, ['block', 'lang'], 1)
			const block = named.get('block')
			const lang = named.get('lang')
			if (
				block?.kind !== 'bool' ||
				!block.value ||
				body?.kind !== 'str' ||
				(lang && (lang.kind !== 'str' || !bodyLanguage(lang.value)))
			)
				this.fail(expr, 'Expected a literal raw code block')
			return projected('codeBlock', range, this.literal(body.value, this.range(body), []), {
				language: lang?.value ?? null,
			})
		}
		if (name === 'image') return this.image(expr)
		if (name === 'table') return this.table(expr)
		if (name === 'figure') {
			const {
				named,
				positional: [body],
			} = this.args(expr, ['caption'], 1)
			if (body?.kind !== 'funcCall' || !['image', 'table'].includes(callee(body) ?? ''))
				this.fail(body!, 'Expected a supported image or table in a figure')
			const value = named.get('caption')
			if (!value) this.fail(expr, 'Editable figures require an explicit caption content block')
			const caption = this.content(value)
			return projected('figure', range, [
				callee(body) === 'image' ? this.image(body) : this.table(body),
				projected('figureCaption', this.range(caption), this.inlines(caption.body)),
			])
		}
		if (name === 'list' || name === 'enum') {
			const ordered = name === 'enum'
			const { named, positional } = this.args(expr, ordered ? ['start', 'numbering'] : [], [
				1,
				Infinity,
			])
			const start = named.get('start')
			if (start && (start.kind !== 'int' || !Number.isSafeInteger(start.value) || start.value < 1))
				this.fail(start, 'Expected a positive list starting number')
			const numbering = named.get('numbering')
			if (numbering && (numbering.kind !== 'str' || !/^[1aAiI]\.$/.test(numbering.value)))
				this.fail(numbering, 'Expected a supported list numbering pattern')
			const attrs = ordered
				? {
						start: start?.value ?? 1,
						type: numbering ? numbering.value[0] : null,
					}
				: undefined
			return this.list(
				ordered,
				range,
				positional.map((item) => ({
					body: this.content(item).body,
					range: this.range(item),
				})),
				attrs,
			)
		}
		return undefined
	}

	private heading(range: Range, level: number, body: AstExpr[]): Projected {
		const content = body.filter((expression) => expression.kind !== 'space')
		const child = content[0]
		if (content.length === 1 && child?.kind === 'funcCall' && callee(child) === 'par') {
			const paragraph = this.blockCall(child)!
			if (paragraph.json.attrs?.textAlign !== 'justify')
				this.fail(child, 'A heading can only contain a paragraph with explicit justification')
			return projected('heading', range, paragraph.children, { level, textAlign: 'justify' })
		}
		return projected('heading', range, this.inlines(body), { level })
	}

	private blocks(expressions: AstExpr[], range: Range): Projected[] {
		const result: Projected[] = []
		let inline: AstExpr[] = []
		let labelOwner: Projected | undefined
		const flush = () => {
			const content = this.inlines(inline)
			if (content.length > 0)
				result.push(
					projected('paragraph', [content[0]!.range[0], content.at(-1)!.range[1]], content),
				)
			inline = []
		}
		for (let index = 0; index < expressions.length; index++) {
			const expr = expressions[index]!
			if (expr.kind === 'space' && inline.length === 0) continue
			if (expr.kind === 'parbreak' || (expr.kind === 'funcCall' && callee(expr) === 'parbreak')) {
				if (expr.kind === 'funcCall') this.args(expr, [], 0)
				flush()
				labelOwner = undefined
				continue
			}
			if (expr.kind === 'label') {
				if (!labelOwner || labelOwner.json.attrs?.label)
					this.fail(expr, 'Place one label after a heading, figure, or block equation')
				labelOwner.json.attrs = { ...labelOwner.json.attrs, label: this.label(expr) }
				labelOwner.range[1] = this.range(expr)[1]
				labelOwner = undefined
				continue
			}
			let block: Projected | undefined
			const itemRange = this.range(expr)
			if (expr.kind === 'heading') {
				if (expr.depth < 1 || expr.depth > 6)
					this.fail(expr, 'Expected a heading level between 1 and 6')
				block = this.heading(itemRange, expr.depth, expr.body)
			} else if (expr.kind === 'equation' && expr.block) block = this.equation(expr)
			else if (expr.kind === 'raw' && expr.block) {
				if (expr.lang && !bodyLanguage(expr.lang))
					this.fail(expr, 'Expected a literal code language')
				block = projected('codeBlock', itemRange, this.text(expr.lines.join('\n'), itemRange, []), {
					language: expr.lang ?? null,
				})
			} else if (expr.kind === 'listItem' || expr.kind === 'enumItem') {
				const ordered = expr.kind === 'enumItem'
				const start = expr.kind === 'enumItem' ? (expr.number ?? 1) : 1
				if (!Number.isSafeInteger(start) || start < 1)
					this.fail(expr, 'Expected a positive list starting number')
				const items = [{ body: expr.body, range: itemRange }]
				for (let next = index + 1; next < expressions.length; next++) {
					const item = expressions[next]!
					if (item.kind === 'space') continue
					if (item.kind === 'parbreak') {
						let after = next + 1
						while (expressions[after]?.kind === 'space' || expressions[after]?.kind === 'parbreak')
							after++
						if (expressions[after]?.kind === expr.kind)
							this.fail(
								item,
								'Blank lines between items form a loose list outside the editable subset',
							)
					}
					if (item.kind !== expr.kind) break
					if (
						item.kind === 'enumItem' &&
						item.number != null &&
						item.number !== start + items.length
					)
						this.fail(item, 'List item numbers must be consecutive')
					items.push({ body: item.body, range: this.range(item) })
					index = next
				}
				block = this.list(
					ordered,
					[itemRange[0], items.at(-1)!.range[1]],
					items,
					ordered ? { start } : undefined,
				)
			} else if (expr.kind === 'funcCall') block = this.blockCall(expr)

			if (block) {
				if (block.json.type === 'image') {
					let next = index + 1
					while (expressions[next]?.kind === 'space') next++
					const following = expressions[next]
					if (inline.length > 0 || (following && following.kind !== 'parbreak'))
						this.fail(expr, 'Separate an editable image from other content with a blank line')
				}
				flush()
				result.push(block)
				labelOwner = ['heading', 'figure', 'blockMath'].includes(block.json.type)
					? block
					: undefined
			} else {
				inline.push(expr)
				labelOwner = undefined
			}
		}
		flush()
		return result.length > 0 ? result : [projected('paragraph', [range[0], range[0]])]
	}

	read(): { document: JSONContent; mapping: TypstSourceMapping[] } {
		const found = comment(this.source.cst)
		if (found)
			throw new UnsupportedBodySyntax(found.range, 'Comments are not part of the editable body')
		const mapping: TypstSourceMapping[] = []
		const assemble = (
			node: Projected,
			position: number,
			nodePath: number[],
		): {
			json: JSONContent
			size: number
		} => {
			const [from, to] = node.range
			if (node.parts) {
				let current = position
				for (const {
					range: [start, end],
					text,
				} of node.parts) {
					const next = current + text.length
					mapping.push({
						kind: 'text',
						from: start,
						to: end,
						position: current,
						endPosition: next,
						nodePath,
					})
					current = next
				}
				return { json: node.json, size: current - position }
			}
			const leaf = this.schema.nodes[node.json.type]?.isLeaf
			let end = position + (leaf ? 0 : 1)
			const content = node.children.map((child, index) => {
				const result = assemble(child, end, [...nodePath, index])
				end += result.size
				return result.json
			})
			const size = end + 1 - position
			mapping.push({ kind: 'node', from, to, position, endPosition: end + 1, nodePath })
			return { json: { ...node.json, ...(content.length > 0 && { content }) }, size }
		}
		let position = 0
		const content = this.blocks(this.source.ast, this.source.cst.range).map((node, index) => {
			const assembled = assemble(node, position, [index])
			position += assembled.size
			return assembled.json
		})
		return { document: { type: 'doc', content }, mapping }
	}
}

export function readTypstBody(parsed: TypstParsedSource, schema: Schema) {
	return new BodyReader(parsed, schema).read()
}
