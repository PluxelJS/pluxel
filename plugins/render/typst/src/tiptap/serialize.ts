import { templateDefinitions } from './blocks.js'
import type { JSONContent } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { tableHeaderRows, tableStyleOptions } from './table-style.js'
import type { TypstNavigation } from '../preview-contract.js'
import { fontFamilyName, fontSizeInPoints, textStyleColor } from './text-style.js'
import type {
	TypstDraftRevision,
	TypstEditorConfig,
	TypstEditorIssue,
	TypstEditorResult,
	TypstGeneratedMapping,
	TypstGeneratedRegions,
	TypstSerializerContext,
} from './types.js'
import {
	editorSchema,
	samePath,
	tableGrid,
	validateTypstData,
	validateTypstRegions,
} from './validation.js'

/** This is a Typst string literal, not JSON or HTML encoding. */
function typstString(value: string): string {
	let encoded = '"'
	for (const character of value) {
		const code = character.codePointAt(0)!
		if (code >= 0xd800 && code <= 0xdfff)
			throw new TypeError('Typst string encoding requires well-formed Unicode.')
		if (character === '"' || character === '\\') encoded += `\\${character}`
		else if (character === '\n') encoded += '\\n'
		else if (character === '\r') encoded += '\\r'
		else if (character === '\t') encoded += '\\t'
		else if (code < 0x20 || code === 0x7f) encoded += `\\u{${code.toString(16)}}`
		else encoded += character
	}
	return `${encoded}"`
}

const typstText = (value: string): string => `#text(${typstString(value)})`
function sourcePoints(source: string) {
	const lines = [0]
	for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1))
		lines.push(index + 1)
	return (offset: number) => {
		let low = 0
		let high = lines.length
		while (low + 1 < high) {
			const middle = Math.floor((low + high) / 2)
			if (lines[middle]! <= offset) low = middle
			else high = middle
		}
		return { line: low + 1, column: offset - lines[low]! + 1 }
	}
}

/** Pure generation; the host owns schema parsing, file IO, session and resources. */
export function generateTypstRegions(options: {
	regions: unknown
	config: TypstEditorConfig
	data: unknown
	snapshotRevision: TypstDraftRevision
}): TypstEditorResult<TypstGeneratedRegions> {
	if (!validateTypstData(options.data))
		return {
			ok: false,
			issues: [
				{ code: 'INVALID_DATA', message: 'Parsed editor data must be a JSON-encodable object.' },
			],
		}
	if (
		(typeof options.snapshotRevision !== 'string' &&
			typeof options.snapshotRevision !== 'number') ||
		(typeof options.snapshotRevision === 'number' && !Number.isFinite(options.snapshotRevision))
	)
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_DATA',
					message: 'A host snapshot revision must be a string or finite number.',
				},
			],
		}
	const checked = validateTypstRegions(options)
	if (!checked.ok) return checked
	const schema = editorSchema(options.config)
	if (!schema.ok) return schema
	const nativeSchema = schema.value
	const issues: TypstEditorIssue[] = []
	const imagePaths = new Map<string, string>()
	const inspectResources = (node: JSONContent, regionId: string, path: (string | number)[]) => {
		if (node.type === 'image') {
			const id = node.attrs!.src as string
			const resource = options.config.resolveImage?.(id)
			if (
				!resource ||
				!/^\/inputs\/(?!editor(?:\/|$))[^\\]+$/.test(resource.path) ||
				resource.path.includes('\0') ||
				resource.path.split('/').some((part) => part === '..' || part === '.')
			)
				issues.push({
					code: 'INVALID_RESOURCE',
					regionId,
					path: [...path, 'attrs', 'src'],
					message: `Host did not resolve image resource ${id} to an allowed /inputs/ resource.`,
				})
			else imagePaths.set(id, resource.path)
		}
		node.content?.forEach((child, index) =>
			inspectResources(child, regionId, [...path, 'content', index]),
		)
	}
	for (const [id, document] of Object.entries(checked.value)) inspectResources(document, id, [])
	if (issues.length > 0) return { ok: false, issues }
	const templateFiles: Record<string, string> = {}
	const inputFiles: Record<string, string> = {
		'/inputs/editor/data.json': JSON.stringify(options.data),
	}
	const mapping: TypstGeneratedMapping[] = []
	for (const region of options.config.regions) {
		const document = checked.value[region.id]!
		const path = `_editor/regions/${region.id}.typ`
		let source = '#let _editor_data = json("/inputs/editor/data.json")\n'
		// The temporary markers retain identity through arbitrary trusted wrappers and
		// repeated context.children() strings. They never reach the generated files.
		let markerPrefix = '/*pluxel-editor-map:'
		const literalInputs = JSON.stringify([
			document,
			options.config.fields,
			[...imagePaths.values()],
		])
		while (literalInputs.includes(markerPrefix)) markerPrefix += ':'
		const anchors: Pick<TypstGeneratedMapping, 'kind' | 'from' | 'to'>[] = []
		function mapped(
			content: string,
			kind: TypstGeneratedMapping['kind'],
			from: number,
			to: number,
		) {
			const id = anchors.push({ kind, from, to }) - 1
			return `${markerPrefix}${id}:start*/${content}${markerPrefix}${id}:end*/`
		}
		function mappedText(value: string, position: number, raw = false): string {
			let literal = ''
			for (const character of value) {
				literal += mapped(
					raw ? character : typstString(character).slice(1, -1),
					'text',
					position,
					position + character.length,
				)
				position += character.length
			}
			return literal
		}
		function textLiteral(value: string, position: number): string {
			return `"${mappedText(value, position)}"`
		}
		function childrenAt(node: JSONContent, position: number): string {
			let offset = position + (node.type === 'doc' ? 0 : 1)
			return (node.content ?? [])
				.map((child) => {
					const content = serialize(child, offset)
					offset += nodeSize(child, nativeSchema)
					return content
				})
				.join('')
		}
		function serialize(node: JSONContent, position: number): string {
			const childCalls = new Map<JSONContent, number>()
			const context: TypstSerializerContext = {
				regionId: region.id,
				children: (target) => {
					if (target === node) return childrenAt(target, position)
					const positions = descendantPositions(node, position, target, nativeSchema)
					if (positions.length === 0)
						throw new TypeError('Serializer children must belong to the current node.')
					const call = childCalls.get(target) ?? 0
					childCalls.set(target, call + 1)
					return childrenAt(target, positions[call % positions.length]!)
				},
				text: typstText,
				string: typstString,
			}

			const attrs = node.attrs ?? {}
			let content: string
			switch (node.type) {
				case 'doc':
					content = context.children(node)
					break
				case 'text':
					content = node.marks?.some((mark) => mark.type === 'code')
						? `#raw(${textLiteral(node.text!, position)})`
						: `#text(${textLiteral(node.text!, position)})`
					break
				case 'paragraph':
					content = `#par[${context.children(node)}]\n`
					break
				case 'heading':
					content = `#heading(level: ${attrs.level ?? 1})[${context.children(node)}]\n`
					break
				case 'blockquote':
					content = `#quote(block: true)[${context.children(node)}]\n`
					break
				case 'bulletList':
					content = `#list(${(node.content ?? []).map((item) => `[${context.children(item)}]`).join(', ')})\n`
					break
				case 'orderedList':
					content = `#enum(start: ${attrs.start ?? 1}${attrs.type ? `, numbering: ${typstString(`${attrs.type}.`)}` : ''}, ${(node.content ?? []).map((item) => `[${context.children(item)}]`).join(', ')})\n`
					break
				case 'listItem':
					content = context.children(node)
					break
				case 'hardBreak':
					content = '#linebreak()'
					break
				case 'horizontalRule':
					content = '#line(length: 100%)\n'
					break
				case 'codeBlock': {
					const text = (node.content ?? []).map((child) => child.text ?? '').join('')
					let fenceLength = 3
					for (const match of text.matchAll(/`+/g))
						fenceLength = Math.max(fenceLength, match[0].length + 1)
					const fence = '`'.repeat(fenceLength)
					// Native raw syntax retains distinct line spans, unlike raw("line1\\nline2").
					content = `${fence}\n${mappedText(text, position + 1, true)}\n${fence}\n`
					if (attrs.language)
						content = `#[#set raw(lang: ${typstString(attrs.language as string)})\n${content}]\n`
					break
				}

				case 'dataField': {
					const field = options.config.fields.find((entry) =>
						samePath(entry.path, attrs.path as string[]),
					)!
					// Resolve against the current data: numeric dictionary keys stay strings,
					// and data-only updates may change a parent between an array and an object.
					const access = `(${field.path.map(typstString).join(', ')},).fold(_editor_data, (value, key) => if type(value) == array and key == "length" { value.len() } else { value.at(if type(value) == array { int(key) } else { key }) })`
					const display =
						field.nullText !== undefined
							? `if ${access} == none { ${typstString(field.nullText)} } else { str(${access}) }`
							: `str(${access})`
					content = `#${node.marks?.some((mark) => mark.type === 'code') ? 'raw' : 'text'}(${display})`
					break
				}
				case 'templateBlock':
				case 'typstSource': {
					const blockPath = `_editor/blocks/${region.id}/${attrs.id}.typ`
					let blockSource: string
					if (node.type === 'templateBlock') {
						const definition = templateDefinitions(options.config.extensions).find(
							(item) => item.id === attrs.template,
						)!
						const inputPath = `/inputs/editor/blocks/${region.id}/${attrs.id}.json`
						inputFiles[inputPath] = JSON.stringify({
							props: attrs.props ?? {},
							dataPath: attrs.dataPath ?? [],
						})
						blockSource = `#let _editor_instance = json(${typstString(inputPath)})\n#let props = _editor_instance.props\n#let data = _editor_instance.dataPath.fold(json("/inputs/editor/data.json"), (value, key) => if type(value) == array and key == "length" { value.len() } else { value.at(if type(value) == array { int(key) } else { key }) })\n${definition.source}\n`
					} else
						blockSource = `#let data = json("/inputs/editor/data.json")\n${attrs.source ?? ''}\n`
					templateFiles[blockPath] = blockSource
					mapping.push({
						snapshotRevision: options.snapshotRevision,
						regionId: region.id,
						path: blockPath,
						kind: 'atom',
						...(node.type === 'typstSource' ? { sourceStartLine: 2 } : {}),
						from: position,
						to: position + 1,
						startOffset: 0,
						endOffset: blockSource.length,
						range: {
							start: { line: 1, column: 1 },
							end: sourcePoints(blockSource)(blockSource.length),
						},
					})
					content = `#include ${typstString(`../blocks/${region.id}/${attrs.id}.typ`)}\n`
					break
				}
				case 'image':
					content = `#image(${typstString(imagePaths.get(attrs.src as string)!)}${attrs.width ? `, width: ${(attrs.width as number) * 0.75}pt` : ''}${attrs.height ? `, height: ${(attrs.height as number) * 0.75}pt` : ''}${attrs.alt ? `, alt: ${typstString(attrs.alt as string)}` : ''})\n`
					break
				case 'table': {
					const grid = tableGrid(node)
					if (typeof grid === 'string') throw new Error('Validated table lost its grid.')
					const headerRows = tableHeaderRows(node)
					const appearance =
						attrs.typstTableStyle ?? tableStyleOptions(options.config.extensions)?.defaultStyle
					const openSides = appearance === 'grid-open-sides'
					const border =
						appearance === 'grid' || openSides ? '.5pt + black' : appearance ? 'none' : undefined
					const cellSource = ({ node: cell, x, y }: (typeof grid.cells)[number]) => {
						const cellAttrs = cell.attrs ?? {}
						const body = context.children(cell)
						const stroke = openSides
							? `(top: ${border}, bottom: ${border}, left: ${x === 0 ? 'none' : border}, right: ${x + (cellAttrs.colspan ?? 1) === grid.columns ? 'none' : border})`
							: border
						return `table.cell(x: ${x}, y: ${y}, colspan: ${cellAttrs.colspan ?? 1}, rowspan: ${cellAttrs.rowspan ?? 1}${stroke ? `, stroke: ${stroke}` : ''}${cellAttrs.align ? `, align: ${cellAttrs.align}` : ''})[${cell.type === 'tableHeader' ? `#strong[${body}]` : body}]`
					}
					const headers = grid.cells.filter((cell) => cell.y < headerRows)
					const body = grid.cells.filter((cell) => cell.y >= headerRows)
					const lines = appearance === 'three-line'
					const stroke = border ? `stroke: ${border}, ` : ''
					const top = lines ? 'table.hline(y: 0, stroke: 1pt + black),\n' : ''
					const divider =
						lines && headerRows > 0 ? `,\ntable.hline(y: ${headerRows}, stroke: .5pt + black)` : ''
					const header =
						headers.length > 0
							? `table.header(${top}${headers.map(cellSource).join(',\n')}${divider}),\n`
							: top
					const bottom = lines
						? `table.hline(y: ${node.content!.length}, stroke: 1pt + black),\n`
						: ''
					content = `#table(${stroke}columns: (${grid.widths.map((width) => `${width}fr`).join(', ')},),\n${header}${body.map(cellSource).join(',\n')}${body.length > 0 ? ',' : ''}\n${bottom})\n`
					break
				}
				case 'tableRow':
				case 'tableCell':
				case 'tableHeader':
					content = context.children(node)
					break
				default:
					content = options.config.nodeMappings![node.type!]!.serialize(node, context)
			}
			for (const mark of (node.marks ?? []).toReversed()) {
				switch (mark.type) {
					case 'bold':
						content = `#strong[${content}]`
						break
					case 'italic':
						content = `#emph[${content}]`
						break
					case 'strike':
						content = `#strike[${content}]`
						break
					case 'underline':
						content = `#underline[${content}]`
						break
					case 'code':
						break
					case 'link':
						content = `#link(${typstString(mark.attrs!.href as string)})[${content}]`
						break
					case 'textStyle': {
						const style = mark.attrs ?? {}
						const arguments_: string[] = []
						if (style.fontFamily !== undefined && style.fontFamily !== null)
							arguments_.push(`font: ${typstString(fontFamilyName(style.fontFamily)!)}`)
						if (style.fontSize !== undefined && style.fontSize !== null)
							arguments_.push(`size: ${fontSizeInPoints(style.fontSize)!}pt`)
						const color = (value: unknown) => {
							const rgba = textStyleColor(value)!
							return `rgb(${rgba.red}, ${rgba.green}, ${rgba.blue}, ${rgba.alpha * 100}%)`
						}
						if (style.color !== undefined && style.color !== null)
							arguments_.push(`fill: ${color(style.color)}`)
						if (arguments_.length > 0) content = `#text(${arguments_.join(', ')})[${content}]`
						if (style.backgroundColor !== undefined && style.backgroundColor !== null)
							content = `#highlight(fill: ${color(style.backgroundColor)})[${content}]`
						break
					}
					default:
						content = options.config.markMappings![mark.type]!.serialize(content, mark, context)
				}
			}
			if (node.type === 'text') return content
			const range = nodeRange(node, position, nativeSchema)
			return mapped(
				content,
				nativeSchema.nodes[node.type!]!.isAtom ? 'atom' : 'block',
				range.from,
				range.to,
			)
		}
		let position = 0
		for (const node of document.content ?? []) {
			source += serialize(node, position)
			position += nodeSize(node, nativeSchema)
		}
		const markerPattern = new RegExp(
			`${markerPrefix.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+):(start|end)\\*/`,
			'g',
		)
		const starts = new Map<number, number[]>()
		const ranges: (Pick<TypstGeneratedMapping, 'kind' | 'from' | 'to'> & {
			startOffset: number
			endOffset: number
		})[] = []
		let output = ''
		let cursor = 0
		for (const match of source.matchAll(markerPattern)) {
			output += source.slice(cursor, match.index)
			cursor = match.index + match[0].length
			const id = Number(match[1])
			if (!anchors[id]) throw new Error('Unknown generated mapping marker.')
			if (match[2] === 'start') {
				const stack = starts.get(id) ?? []
				stack.push(output.length)
				starts.set(id, stack)
			} else {
				const startOffset = starts.get(id)?.pop()
				if (startOffset === undefined) throw new Error('Unbalanced generated mapping marker.')
				ranges.push({ ...anchors[id]!, startOffset, endOffset: output.length })
			}
		}
		output += source.slice(cursor)
		if ([...starts.values()].some((stack) => stack.length))
			throw new Error('Unclosed generated mapping marker.')
		source = output
		const pointAt = sourcePoints(source)
		for (const range of ranges.sort(
			(a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset,
		))
			mapping.push({
				snapshotRevision: options.snapshotRevision,
				regionId: region.id,
				path,
				...range,
				range: { start: pointAt(range.startOffset), end: pointAt(range.endOffset) },
			})
		templateFiles[path] = source
	}
	return {
		ok: true,
		value: {
			templateFiles,
			inputFiles,
			mapping,
		},
	}
}

function descendantPositions(
	node: JSONContent,
	position: number,
	target: JSONContent,
	schema: Schema,
): number[] {
	const positions: number[] = []
	let offset = position + (node.type === 'doc' ? 0 : 1)
	for (const child of node.content ?? []) {
		if (child === target) positions.push(offset)
		positions.push(...descendantPositions(child, offset, target, schema))
		offset += nodeSize(child, schema)
	}
	return positions
}

function nodeRange(
	node: JSONContent,
	position: number,
	schema: Schema,
): { from: number; to: number } {
	if (node.type === 'text' || schema.nodes[node.type!]!.isAtom)
		return { from: position, to: position + nodeSize(node, schema) }
	const children = node.content ?? []
	if (children.length === 0) return { from: position + 1, to: position + 1 }
	const first = nodeRange(children[0]!, position + 1, schema)
	let lastPosition = position + 1
	for (const child of children.slice(0, -1)) lastPosition += nodeSize(child, schema)
	return { from: first.from, to: nodeRange(children.at(-1)!, lastPosition, schema).to }
}

function nodeSize(node: JSONContent, schema: Schema): number {
	if (node.type === 'text') return node.text!.length
	if (schema.nodes[node.type!]!.isLeaf) return 1
	return 2 + (node.content ?? []).reduce((size, child) => size + nodeSize(child, schema), 0)
}

function comparePoint(
	a: { line: number; column: number },
	b: { line: number; column: number },
): number {
	return a.line - b.line || a.column - b.column
}

/** Generated source hit → the smallest character/atom interval in this exact snapshot. */
export function findTypstRegionPosition(options: {
	mapping: readonly TypstGeneratedMapping[]
	position: { path: string; line: number; column: number }
	snapshotRevision: TypstDraftRevision
}):
	| { regionId: string; from: number; to: number; source?: { line: number; column: number } }
	| undefined {
	const path = options.position.path.replace(/^\//, '')
	const rank = { text: 0, atom: 1, block: 2 }
	const entry = options.mapping
		.filter(
			(item) =>
				item.snapshotRevision === options.snapshotRevision &&
				item.path === path &&
				comparePoint(options.position, item.range.start) >= 0 &&
				comparePoint(options.position, item.range.end) < 0,
		)
		.sort(
			(a, b) =>
				rank[a.kind] - rank[b.kind] || a.endOffset - a.startOffset - (b.endOffset - b.startOffset),
		)[0]
	return entry
		? {
				regionId: entry.regionId,
				from: entry.from,
				to: entry.to,
				...(entry.sourceStartLine && options.position.line >= entry.sourceStartLine
					? {
							source: {
								line: options.position.line - entry.sourceStartLine + 1,
								column: options.position.column,
							},
						}
					: {}),
			}
		: undefined
}

/** Direct ProseMirror position → a real glyph, including clusters spanning several characters. */
export function findTypstGeneratedPosition(options: {
	mapping: readonly TypstGeneratedMapping[]
	/** From the successful compilation of this exact host snapshot. */
	navigation: TypstNavigation
	regionId: string
	position: number
	snapshotRevision: TypstDraftRevision
}): { path: string; line: number; column: number } | undefined {
	const candidates = options.mapping.filter(
		(entry) =>
			entry.snapshotRevision === options.snapshotRevision && entry.regionId === options.regionId,
	)
	if (candidates.length === 0) return undefined
	const block = candidates
		.filter(
			(entry) =>
				entry.kind === 'block' && options.position >= entry.from && options.position <= entry.to,
		)
		.sort(
			(a, b) =>
				a.to - a.from - (b.to - b.from) ||
				a.endOffset - a.startOffset - (b.endOffset - b.startOffset),
		)[0]
	const distance = (entry: TypstGeneratedMapping) =>
		options.position < entry.from
			? entry.from - options.position
			: options.position >= entry.to
				? options.position - entry.to
				: 0
	const contains = (entry: TypstGeneratedMapping) =>
		options.position >= entry.from && options.position < entry.to
	const leaves = candidates
		.filter(
			(entry) =>
				entry.kind !== 'block' && (!block || (entry.from >= block.from && entry.to <= block.to)),
		)
		.sort(
			(a, b) =>
				Number(contains(b)) - Number(contains(a)) ||
				distance(a) - distance(b) ||
				Math.abs(a.from - options.position) - Math.abs(b.from - options.position),
		)
	// Whitespace or structural positions use the nearest rendered character in their
	// own content range, never the first unrelated glyph in the enclosing paragraph.
	for (const entry of [...leaves, ...(block ? [block] : [])]) {
		const point = options.navigation.points
			.filter(
				(item) =>
					item.path.replace(/^\//, '') === entry.path &&
					comparePoint(item, entry.range.end) < 0 &&
					comparePoint({ line: item.endLine, column: item.endColumn }, entry.range.start) > 0,
			)
			.sort(
				(a, b) =>
					a.endLine - a.line - (b.endLine - b.line) ||
					a.endColumn - a.column - (b.endColumn - b.column),
			)[0]
		if (point) return { path: point.path, line: point.line, column: point.column }
	}
	return undefined
}
