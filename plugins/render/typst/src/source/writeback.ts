import type { JSONContent } from '@tiptap/core'
import { fontFamilyName, fontSizeInPoints, textStyleColor } from '../tiptap/text-style.js'
import { sourceSlice } from './parse.js'
import type {
	TypstSourceNodeOrigin,
	TypstParsedProjection,
	TypstSourcePatch,
	TypstSourceResult,
	TypstSourceRange,
} from './types.js'

type Mark = NonNullable<JSONContent['marks']>[number]
const ignoredAttrs = new Set(['id'])
/** Native schemas insert default attributes. They are not authored modifications. */
function clean(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) {
		const items = value.map((entry) => clean(entry))
		return key === 'marks'
			? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
			: items
	}
	if (!value || typeof value !== 'object') return value
	const object: Record<string, unknown> = {}
	for (const [name, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (child === undefined || child === null || (key === 'attrs' && ignoredAttrs.has(name)))
			continue
		if (name === 'content' && Array.isArray(child) && child.length === 0) continue
		const normalized = clean(child, name)
		if (
			normalized &&
			typeof normalized === 'object' &&
			!Array.isArray(normalized) &&
			Object.keys(normalized).length === 0
		)
			continue
		object[name] = normalized
	}
	return object
}
const equal = (a: unknown, b: unknown) => JSON.stringify(clean(a)) === JSON.stringify(clean(b))
const nodeAttributes = (node: JSONContent) =>
	clean(node.attrs ?? {}, 'attrs') as Record<string, unknown>
const marks = (node: JSONContent) => node.marks ?? []
function textEscape(value: string, leadingSpace = false, trailingSpace = false): string {
	const characters = [...value]
	return characters
		.map((character, index) => {
			const code = character.codePointAt(0)!
			if (
				code < 0x20 ||
				code === 0x7f ||
				(character === ' ' &&
					(characters[index - 1] === ' ' ||
						characters[index + 1] === ' ' ||
						(index === 0 && leadingSpace) ||
						(index === characters.length - 1 && trailingSpace)))
			)
				return `\\u{${code.toString(16)}}`
			return /[\\*_`#@<>$[\]=+\-/]/.test(character) ? `\\${character}` : character
		})
		.join('')
}

const string = (value: unknown): string => {
	if (typeof value !== 'string') return JSON.stringify(value)
	if (!value.isWellFormed()) throw new Error('Typst strings require well-formed Unicode')
	let output = '"'
	for (const character of value) {
		const code = character.codePointAt(0)!
		output +=
			character === '"' || character === '\\'
				? `\\${character}`
				: character === '\n'
					? '\\n'
					: character === '\r'
						? '\\r'
						: character === '\t'
							? '\\t'
							: code < 0x20 || code === 0x7f
								? `\\u{${code.toString(16)}}`
								: character
	}
	return output + '"'
}
const namedColors = new Set([
	'black',
	'gray',
	'silver',
	'white',
	'navy',
	'blue',
	'aqua',
	'teal',
	'red',
	'maroon',
	'yellow',
	'olive',
	'lime',
	'green',
	'fuchsia',
	'purple',
	'orange',
])
function color(value: unknown): string {
	if (typeof value === 'string' && namedColors.has(value)) return value
	const rgba = textStyleColor(value)
	if (!rgba) throw new Error('Color must be a Typst named color, hex, RGB or RGBA value')
	return `rgb(${rgba.red}, ${rgba.green}, ${rgba.blue}, ${rgba.alpha * 100}%)`
}
function font(value: unknown): string {
	const name = fontFamilyName(value)
	if (!name) throw new Error('Invalid font family')
	return string(name)
}
function size(value: unknown): string {
	const points = fontSizeInPoints(value)
	if (!points) throw new Error('Invalid font size')
	return `${points}pt`
}
function imageSize(value: unknown): string {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
		throw new Error('Image dimensions must be positive finite pixels')
	return `${value * 0.75}pt`
}

function wrap(content: string, mark: Mark): string {
	switch (mark.type) {
		case 'bold':
			return `*${content}*`
		case 'italic':
			return `_${content}_`
		case 'strike':
			return `#strike[${content}]`
		case 'underline':
			return `#underline[${content}]`
		case 'subscript':
			return `#sub[${content}]`
		case 'superscript':
			return `#super[${content}]`
		case 'code':
			throw new Error('Code rendering requires literal text or an explicitly bound data field')
		case 'link':
			return `#link(${string(mark.attrs?.href)})[${content}]`
		case 'textStyle': {
			const a = mark.attrs ?? {},
				params: string[] = []
			if (a.fontFamily) params.push(`font: ${font(a.fontFamily)}`)
			if (a.fontSize) params.push(`size: ${size(a.fontSize)}`)
			if (a.color) params.push(`fill: ${color(a.color)}`)
			if (params.length > 0) content = `#text(${params.join(', ')})[${content}]`
			if (a.backgroundColor) content = `#highlight(fill: ${color(a.backgroundColor)})[${content}]`
			return content
		}
		default:
			throw new Error(`Unsupported mark ${mark.type}`)
	}
}
function serializeNode(node: JSONContent, indent = '', libraryAlias?: string): string {
	const children = () =>
		(node.content ?? []).map((child) => serialize(child, indent, libraryAlias)).join('')
	const blocks = () =>
		(node.content ?? []).map((child) => serialize(child, indent, libraryAlias)).join('\n\n')
	switch (node.type) {
		case 'text':
			return marks(node)
				.filter((mark) => mark.type !== 'code')
				.reduceRight(
					(text, mark) => wrap(text, mark),
					marks(node).some((mark) => mark.type === 'code')
						? `#raw(${string(node.text ?? '')})`
						: textEscape(node.text ?? ''),
				)
		case 'paragraph': {
			const body = children() || '#par[]'
			return node.attrs?.textAlign
				? `#align(${node.attrs.textAlign === 'justify' ? 'start' : node.attrs.textAlign})[#set par(justify: ${node.attrs.textAlign === 'justify'})\n${body}]`
				: body
		}
		case 'heading': {
			const body = `${'='.repeat(node.attrs?.level ?? 1)} ${children()}${node.attrs?.label ? ` <${node.attrs.label}>` : ''}`
			return node.attrs?.textAlign
				? `#align(${node.attrs.textAlign === 'justify' ? 'start' : node.attrs.textAlign})[#set par(justify: ${node.attrs.textAlign === 'justify'})\n${body}]`
				: body
		}
		case 'hardBreak':
			return '\\\n'
		case 'horizontalRule':
			return '#line(length: 100%)'
		case 'blockquote':
			return `#quote(block: true)[${blocks()}]`
		case 'bulletList':
		case 'orderedList': {
			if (node.type === 'orderedList' && node.attrs?.type)
				return `#enum(start: ${node.attrs.start ?? 1}, numbering: ${string(`${node.attrs.type}.`)}, ${(node.content ?? []).map((item) => `[${serialize(item, indent, libraryAlias)}]`).join(', ')})`
			return (node.content ?? [])
				.map((item, index) => {
					const marker =
						node.type === 'bulletList'
							? '-'
							: index === 0 && node.attrs?.start && node.attrs.start !== 1
								? `${node.attrs.start}.`
								: '+'
					const body = (item.content ?? [])
						.map((child) => serialize(child, indent + '  ', libraryAlias))
						.join('\n\n')
					return `${marker} ${body.replaceAll('\n', '\n  ')}`
				})
				.join('\n')
		}
		case 'listItem':
			return blocks()
		case 'codeBlock': {
			const value = (node.content ?? []).map((child) => child.text ?? '').join('')
			const fence = '`'.repeat(
				Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1)),
			)
			return `${fence}${node.attrs?.language ?? ''}\n${value}\n${fence}`
		}
		case 'image':
			return `#image(${string(node.attrs?.src)}${node.attrs?.width != null ? `, width: ${imageSize(node.attrs.width)}` : ''}${node.attrs?.height != null ? `, height: ${imageSize(node.attrs.height)}` : ''}${node.attrs?.alt != null ? `, alt: ${string(node.attrs.alt)}` : ''})`
		case 'figureCaption':
			return children()
		case 'figure':
			return `#figure(${serialize(node.content![0]!, '', libraryAlias).replace(/^#/, '')}, caption: [${serialize(node.content![1]!, '', libraryAlias)}])${node.attrs?.label ? ` <${node.attrs.label}>` : ''}`
		case 'reference': {
			const target = node.attrs?.target
			if (typeof target !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_:.-]*$/u.test(target))
				throw new Error('Reference target must be a native label')
			if (node.attrs?.showCaption != null) {
				if (!libraryAlias)
					throw new Error(
						'Import lib/pluxel.typ as a module before inserting a reference caption policy',
					)
				return `#${libraryAlias}.reference(<${target}>, caption: ${node.attrs.showCaption})`
			}
			return `@${target}`
		}
		case 'inlineMath':
		case 'blockMath': {
			if (!libraryAlias) throw new Error('Import lib/pluxel.typ as a module before inserting LaTeX')
			return `#${libraryAlias}.latex(${string(node.attrs?.latex ?? '')}, block: ${node.type === 'blockMath'})${node.attrs?.label ? ` <${node.attrs.label}>` : ''}`
		}
		case 'typstComponent':
		case 'typstField': {
			if (typeof node.attrs?.source !== 'string')
				throw new Error('This declared source call requires its authored source')
			return node.attrs.source
		}
		case 'table': {
			const rows = node.content ?? []
			const count = Math.max(
				...rows.map((row) =>
					(row.content ?? []).reduce((total, cell) => total + (cell.attrs?.colspan ?? 1), 0),
				),
			)
			const cells = rows.flatMap((row) =>
				(row.content ?? []).map((cell) => {
					const value = serialize(cell, '', libraryAlias)
					return cell.type === 'tableHeader' ? `table.header(${value})` : value
				}),
			)
			return `#table(columns: ${count},\n  ${cells.join(',\n  ')},\n)`
		}
		case 'tableCell':
		case 'tableHeader': {
			const params: string[] = []
			if (node.attrs?.colspan > 1) params.push(`colspan: ${node.attrs!.colspan}`)
			if (node.attrs?.rowspan > 1) params.push(`rowspan: ${node.attrs!.rowspan}`)
			if (node.attrs?.align) params.push(`align: ${node.attrs.align}`)
			return `${params.length > 0 ? `table.cell(${params.join(', ')})` : ''}[${blocks()}]`
		}
		case 'typstInlineSource':
		case 'typstSource': {
			if (typeof node.attrs?.source !== 'string')
				throw new Error('A source node requires its authored source')
			return node.attrs.source
		}
		default:
			throw new Error(`Unsupported node ${node.type}`)
	}
}

function serialize(node: JSONContent, indent = '', libraryAlias?: string): string {
	let source = serializeNode(node, indent, libraryAlias)
	if (node.type === 'text') return source
	if (node.type === 'typstField' && marks(node).some((mark) => mark.type === 'code'))
		source = `#raw(${source.replace(/^#/, '')})`
	return marks(node)
		.filter((mark) => mark.type !== 'code')
		.reduceRight((value, mark) => wrap(value, mark), source)
}

/** Prepares UTF-8 patches only. The project owner checks revision and atomically accepts them. */
export function prepareTypstSourceEdit(
	projection: TypstParsedProjection,
	document: JSONContent,
): TypstSourceResult<TypstSourcePatch[]> {
	const patches: TypstSourcePatch[] = []
	const changedLinks = new Set<string>()
	const serial = (node: JSONContent) => serialize(node, '', projection.libraryAlias)
	const raw = (range: TypstSourceRange) => sourceSlice(projection.parsed, range.from, range.to)
	const patch = (range: TypstSourceRange, text: string) => {
		if (!text.isWellFormed()) throw new Error('Edited text contains an unpaired UTF-16 surrogate')
		if (raw(range) !== text) patches.push({ path: projection.path, ...range, text })
	}
	let failed: TypstSourceRange = { from: 0, to: projection.parsed.cst.range[1] }
	const reject = (origin: TypstSourceNodeOrigin, message: string): never => {
		failed = origin
		throw new Error(message)
	}
	const changeCallParameters = (
		origin: TypstSourceNodeOrigin,
		changes: Record<string, string | null>,
	) => {
		const call = origin.call!
		const added: string[] = []
		for (const [name, value] of Object.entries(changes)) {
			const range = call.parameters[name]
			if (range) {
				if (value != null) patch(range, value)
				else {
					const remove = call.removableParameters?.[name]
					if (!remove) reject(origin, 'Removing this argument would detach source comments')
					patch(remove!, '')
				}
			} else if (value != null) added.push(`${name}: ${value}`)
		}
		if (added.length > 0)
			patch(
				{ from: call.insertAt, to: call.insertAt },
				`${call.insertPrefix ?? ', '}${added.join(', ')}${call.insertSuffix ?? ''}`,
			)
	}
	const textChange = (origin: TypstSourceNodeOrigin, before: JSONContent, after: JSONContent) => {
		const oldText = before.text ?? '',
			newText = after.text ?? ''
		if (oldText === newText) return
		const oldChars = [...oldText],
			newChars = [...newText]
		let prefix = 0,
			suffix = 0
		while (
			prefix < oldChars.length &&
			prefix < newChars.length &&
			oldChars[prefix] === newChars[prefix]
		)
			prefix++
		while (
			suffix < oldChars.length - prefix &&
			suffix < newChars.length - prefix &&
			oldChars.at(-1 - suffix) === newChars.at(-1 - suffix)
		)
			suffix++
		const spans = origin.textSpans
		if (!spans?.length) {
			patch(origin, serial(after))
			return
		}
		const starts = new Map<number, number>(),
			ends = new Map<number, number>()
		let count = 0
		ends.set(0, spans[0]!.from)
		for (const span of spans) {
			starts.set(count, span.from)
			count += [...span.text].length
			ends.set(count, span.to)
		}
		starts.set(count, spans.at(-1)!.to)
		const from = starts.get(prefix),
			to = prefix === oldChars.length - suffix ? from : ends.get(oldChars.length - suffix)
		if (from === undefined || to === undefined)
			reject(origin, 'This edit splits an encoded source token; edit the complete token in source')
		// A local replacement must not eat comments or another nontext expression between text spans.
		const touched = spans.filter((span) => span.to > from! && span.from < to!)
		for (let i = 1; i < touched.length; i++)
			if (touched[i - 1]!.to !== touched[i]!.from)
				reject(
					origin,
					'This edit crosses preserved source syntax; edit the text on either side separately',
				)
		patch(
			{ from: from!, to: to! },
			textEscape(
				newChars.slice(prefix, newChars.length - suffix).join(''),
				oldChars[prefix - 1] === ' ',
				oldChars[oldChars.length - suffix] === ' ',
			),
		)
	}
	const markChange = (origin: TypstSourceNodeOrigin, before: JSONContent, after: JSONContent) => {
		const oldMarks = marks(before),
			newMarks = marks(after),
			extraStyle: Record<string, unknown> = {}
		for (const old of oldMarks) {
			const next = newMarks.find((mark) => mark.type === old.type)
			if (equal(old, next)) continue
			const owners = origin.markOrigins?.filter((owner) => owner.mark.type === old.type) ?? []
			if (
				old.type === 'link' &&
				owners.length > 0 &&
				owners.every((owner) => owner.attributes?.href)
			) {
				for (const owner of owners) {
					const key = `${owner.from}:${owner.to}`
					if (changedLinks.has(key)) continue
					if (owner.shared) {
						const consistent = (previous: TypstSourceNodeOrigin): boolean => {
							if (
								previous.markOrigins?.some(
									(entry) =>
										entry.mark.type === 'link' &&
										entry.from === owner.from &&
										entry.to === owner.to,
								)
							) {
								let candidate: JSONContent | undefined = document
								for (const index of previous.nodePath) candidate = candidate?.content?.[index]
								if (
									!candidate ||
									!equal(
										{ ...previous.original, marks: undefined },
										{ ...candidate, marks: undefined },
									) ||
									!equal(
										marks(candidate).find((mark) => mark.type === 'link'),
										next,
									)
								)
									return false
							}
							return previous.children.every(consistent)
						}
						if (!projection.origins.every(consistent))
							reject(
								origin,
								'Change this complete shared link or edit its enclosing source expression',
							)
					}
					if (next) patch(owner.attributes!.href!, string(next.attrs?.href))
					else {
						patch({ from: owner.from, to: owner.contentRange.from }, '')
						patch({ from: owner.contentRange.to, to: owner.to }, '')
					}
					changedLinks.add(key)
				}
				continue
			}
			if (owners.length === 0 || owners.some((owner) => owner.shared))
				reject(
					origin,
					'Changing this shared format requires editing its enclosing source expression',
				)
			if (old.type === 'textStyle') {
				const oldAttrs = old.attrs ?? {},
					nextAttrs = next?.attrs ?? {},
					insertions = new Map<(typeof owners)[number], string[]>()
				for (const key of new Set([...Object.keys(oldAttrs), ...Object.keys(nextAttrs)])) {
					if (equal(oldAttrs[key], nextAttrs[key])) continue
					const matching = owners.filter((owner) => owner.attributes?.[key]),
						value = nextAttrs[key]
					if (value == null) {
						for (const owner of matching) {
							if (owner.callee === 'highlight') {
								if (owner.preserve)
									reject(
										origin,
										'Removing this highlight would discard its additional source parameters',
									)
								patch({ from: owner.from, to: owner.contentRange.from }, '')
								patch({ from: owner.contentRange.to, to: owner.to }, '')
							} else {
								const range = owner.argumentRanges?.[key]
								if (!range) reject(origin, 'Removing this parameter would detach source comments')
								patch(range!, '')
							}
						}
					} else {
						const encoded =
								key === 'fontFamily'
									? font(value)
									: key === 'fontSize'
										? size(value)
										: color(value),
							owner =
								matching[0] ??
								owners.find(
									(candidateOwner) =>
										candidateOwner.callee === (key === 'backgroundColor' ? 'highlight' : 'text'),
								)
						if (!owner) {
							extraStyle[key] = value
							continue
						}
						if (matching.length > 0) patch(owner.attributes![key]!, encoded)
						else {
							const added = insertions.get(owner) ?? []
							added.push(
								`${key === 'fontFamily' ? 'font' : key === 'fontSize' ? 'size' : 'fill'}: ${encoded}`,
							)
							insertions.set(owner, added)
						}
					}
				}
				for (const [owner, added] of insertions) {
					const insertion = owner.insertion
					if (!insertion) reject(origin, 'Adding this parameter requires a source edit')
					patch(
						{ from: insertion!.insertAt, to: insertion!.insertAt },
						`${insertion!.insertPrefix}${added.join(', ')}${insertion!.insertSuffix}`,
					)
				}
			} else {
				// A simple wrapper can be removed at its delimiters without regenerating its body.
				for (const owner of owners) {
					if (owner.preserve)
						reject(origin, 'This format owns additional source parameters; edit its source')
					const marker = '\u0000CONTENT\u0000',
						replacement = next ? wrap(marker, next) : marker
					const [prefix, suffix] = replacement.split(marker)
					patch({ from: owner.from, to: owner.contentRange.from }, prefix!)
					patch({ from: owner.contentRange.to, to: owner.to }, suffix!)
				}
			}
		}
		const added = [
			...newMarks.filter((mark) => !oldMarks.some((old) => old.type === mark.type)),
			...(Object.keys(extraStyle).length > 0 ? [{ type: 'textStyle', attrs: extraStyle }] : []),
		]
		if (added.length > 0) {
			const marker = '\u0000CONTENT\u0000',
				replacement = added.reduceRight((body, mark) => wrap(body, mark), marker)
			const [prefix, suffix] = replacement.split(marker)
			patch({ from: origin.from, to: origin.from }, prefix!)
			patch({ from: origin.to, to: origin.to }, suffix!)
		}
	}

	const rewriteSequence = (
		old: TypstSourceNodeOrigin[],
		next: JSONContent[],
		owner: TypstSourceNodeOrigin | undefined,
	) => {
		let prefix = 0,
			suffix = 0
		while (
			prefix < old.length &&
			prefix < next.length &&
			equal(old[prefix]!.original, next[prefix])
		)
			prefix++
		while (
			suffix < old.length - prefix &&
			suffix < next.length - prefix &&
			equal(old.at(-1 - suffix)!.original, next.at(-1 - suffix))
		)
			suffix++
		const removed = old.slice(prefix, old.length - suffix),
			inserted = next.slice(prefix, next.length - suffix)
		if (removed.length === 0 && inserted.length === 0) return
		const ownerRange =
			owner?.contentRange ??
			(owner ? { from: owner.from, to: owner.to } : { from: 0, to: projection.parsed.cst.range[1] })
		if (!owner && removed.some((origin) => origin.fixed)) {
			// An import and an inline call may be inserted in one transaction. Keep
			// unchanged environment statements as ordered anchors between both edits.
			const anchors = removed.flatMap((origin, index) =>
				origin.fixed
					? [
							{
								origin,
								index,
								matches: inserted.flatMap((node, candidateIndex) =>
									equal(origin.original, node) ? [candidateIndex] : [],
								),
							},
						]
					: [],
			)
			if (
				anchors.some(
					(anchor, index) =>
						anchor.matches.length !== 1 ||
						(index > 0 && anchor.matches[0]! <= anchors[index - 1]!.matches[0]!),
				)
			)
				reject(
					removed.find((origin) => origin.fixed)!,
					'Environment declarations must retain their authored order and scope',
				)
			let oldStart = 0,
				nextStart = 0,
				previous: TypstSourceNodeOrigin | undefined
			const segment = (
				before: TypstSourceNodeOrigin[],
				after: JSONContent[],
				following?: TypstSourceNodeOrigin,
			) => {
				if (before.length === 0) {
					if (after.length === 0) return
					const at = previous?.to ?? following?.from ?? ownerRange.from
					patch(
						{ from: at, to: at },
						`${previous ? '\n\n' : ''}${after.map(serial).join('\n\n')}${following ? '\n\n' : ''}`,
					)
				} else if (
					before.length === after.length &&
					after.every(
						(node, index) =>
							node.type === before[index]!.original.type &&
							!(node.type === 'figure' && node.attrs?.id !== before[index]!.original.attrs?.id),
					)
				)
					before.forEach((origin, index) => visit(origin, after[index]!))
				else rewriteSequence(before, after, undefined)
			}
			for (const anchor of anchors) {
				segment(
					removed.slice(oldStart, anchor.index),
					inserted.slice(nextStart, anchor.matches[0]!),
					anchor.origin,
				)
				oldStart = anchor.index + 1
				nextStart = anchor.matches[0]! + 1
				previous = anchor.origin
			}
			segment(removed.slice(oldStart), inserted.slice(nextStart))
			return
		}
		if (
			owner &&
			['paragraph', 'heading', 'figureCaption'].includes(owner.original.type!) &&
			removed.length > 0
		) {
			let from = removed[0]!.from,
				to = removed.at(-1)!.to
			const wrappers = new Map<string, NonNullable<TypstSourceNodeOrigin['markOrigins']>[number]>()
			for (const child of removed)
				for (const wrapper of child.markOrigins ?? [])
					wrappers.set(`${wrapper.from}:${wrapper.to}`, wrapper)
			const retained: Mark[] = []
			for (const wrapper of wrappers.values()) {
				const covers = wrapper.contentRange.from <= from && wrapper.contentRange.to >= to
				if (
					covers &&
					inserted.every((node) =>
						marks(node).some(
							(mark) =>
								mark.type === wrapper.mark.type &&
								(mark.type === 'textStyle' || equal(mark, wrapper.mark)),
						),
					)
				) {
					retained.push(wrapper.mark)
					continue
				}
				if (
					wrapper.preserve ||
					(wrapper.shared &&
						old.some(
							(child) =>
								!removed.includes(child) &&
								child.from >= wrapper.contentRange.from &&
								child.to <= wrapper.contentRange.to,
						))
				)
					reject(
						owner,
						'This format change crosses an enclosing source expression; edit its source',
					)
				from = Math.min(from, wrapper.from)
				to = Math.max(to, wrapper.to)
			}
			const commentInRange = (node: typeof projection.parsed.cst): boolean => {
				if (node.range[1] <= from || node.range[0] >= to) return false
				return (
					['LineComment', 'BlockComment'].includes(node.kind) || node.children.some(commentInRange)
				)
			}
			if (commentInRange(projection.parsed.cst))
				reject(owner, 'This format change crosses preserved comments; edit each side separately')
			const adjusted = inserted.map((node) => ({
				...node,
				marks: marks(node).flatMap((mark) => {
					if (mark.type !== 'textStyle')
						return retained.some((value) => equal(value, mark)) ? [] : [mark]
					const attrs = { ...mark.attrs }
					for (const inherited of retained.filter((value) => value.type === 'textStyle'))
						for (const [key, value] of Object.entries(inherited.attrs ?? {}))
							if (equal(attrs[key], value)) delete attrs[key]
					return Object.keys(attrs).length > 0 ? [{ type: 'textStyle', attrs }] : []
				}),
			}))
			patch({ from, to }, adjusted.map((node) => serial(node)).join(''))
			return
		}
		if (owner?.preserve && !owner.rewriteBody)
			reject(
				owner,
				'Changing this structure would discard preserved call parameters or comments; edit its source',
			)
		for (const origin of removed) {
			if (origin.fixed)
				reject(
					origin,
					'Environment declarations stay in their authored scope; edit the source to move them',
				)
			if (
				origin.original.type === 'typstSource' &&
				!inserted.some((node, index) => equal(node, origin.original) && removed[index] === origin)
			)
				reject(
					origin,
					'Moving an unknown source block requires a source edit with scope and relative paths checked',
				)
		}
		for (let index = 1; index < removed.length; index++)
			if (raw({ from: removed[index - 1]!.to, to: removed[index]!.from }).trim())
				reject(removed[index]!, 'Reordering would detach intervening source comments')
		const from = removed[0]?.from ?? old[prefix]?.from ?? old.at(-1)?.to ?? ownerRange.from
		const to = removed.at(-1)?.to ?? from
		const separator =
			owner && ['paragraph', 'heading', 'figureCaption'].includes(owner.original.type!)
				? ''
				: '\n\n'
		const result = inserted
			.map((node) => {
				const original = removed.find((origin) => equal(origin.original, node))
				return original ? raw(original) : serial(node)
			})
			.join(separator)
		const leading = removed.length === 0 && prefix > 0 ? separator : ''
		const trailing = removed.length === 0 && prefix < old.length ? separator : ''
		patch({ from, to }, leading + result + trailing)
	}
	const listShape = (node: JSONContent): unknown => [
		node.type,
		node.type === 'text' ? undefined : node.content?.map(listShape),
	]
	const rewriteList = (origin: TypstSourceNodeOrigin, next: JSONContent) => {
		if (!origin.list) {
			if (origin.preserve)
				reject(origin, 'Changing this list structure would detach preserved comments')
			patch(origin, serial(next))
			return
		}
		const hasFixed = (node: TypstSourceNodeOrigin): boolean =>
			!!node.fixed || node.children.some(hasFixed)
		if (!origin.list.canRebuild || hasFixed(origin))
			reject(
				origin,
				'Changing this list structure would detach preserved source declarations or comments',
			)
		if (
			origin.original.type !== next.type &&
			origin.list.parameters.some(
				(value) => !/^(?:start|numbering|tight|indent|body-indent|spacing)\s*:/.test(value),
			)
		)
			reject(
				origin,
				'Changing list kind would change the meaning of its additional source parameters',
			)
		const parameters = origin.list.parameters.filter(
			(value) => !/^(?:start|numbering)\s*:/.test(value),
		)
		if (next.type === 'orderedList') {
			parameters.push(`start: ${next.attrs?.start ?? 1}`)
			if (next.attrs?.type) parameters.push(`numbering: ${string(`${next.attrs.type}.`)}`)
		}
		const items = (next.content ?? []).map((item) => {
			const existing = origin.children.find((child) => equal(child.original, item))
			return existing ? raw(existing) : `[${serial(item)}]`
		})
		patch(
			origin,
			`#${next.type === 'orderedList' ? 'enum' : 'list'}(${[...parameters, ...items].join(', ')})`,
		)
	}
	const tableShape = (node: JSONContent): unknown => [
		node.attrs,
		node.content?.map((row) => row.content?.map((cell) => [cell.type, cell.attrs])),
	]
	const rewriteTable = (origin: TypstSourceNodeOrigin, next: JSONContent) => {
		if (!origin.table?.canRebuild)
			reject(
				origin,
				'Changing this table structure would detach preserved comments or lines; edit its source',
			)
		const oldCells = origin.children.flatMap((row) => row.children),
			rows = next.content ?? []
		const count = Math.max(
			...rows.map((row) =>
				(row.content ?? []).reduce((sum, cell) => sum + (cell.attrs?.colspan ?? 1), 0),
			),
		)
		const appearance = next.attrs?.tableStyle
		const styleChanged = !equal(origin.original.attrs?.tableStyle, appearance)
		// Cell content is not an identity: repeated values can own different fill,
		// inset or other source-only parameters. Keep stable grid/row positions first,
		// then consume only an unambiguous source for a structural edit.
		const cellOrigins = new Map<JSONContent, TypstSourceNodeOrigin>(),
			used = new Set<TypstSourceNodeOrigin>(),
			nextCells = rows.flatMap((row) => row.content ?? [])
		const assign = (cell: JSONContent, previous: TypstSourceNodeOrigin) => {
			cellOrigins.set(cell, previous)
			used.add(previous)
		}
		const grid = (table: JSONContent) =>
			table.content?.map((row) =>
				row.content?.map((cell) => [cell.attrs?.colspan ?? 1, cell.attrs?.rowspan ?? 1]),
			)
		if (equal(grid(origin.original), grid(next)))
			rows.forEach((row, y) =>
				row.content?.forEach((cell, x) => {
					const previous = origin.children[y]!.children[x]!
					if (equal(previous.original.content, cell.content)) assign(cell, previous)
				}),
			)
		for (const row of origin.children) {
			const matches = rows.filter((candidate) => equal(row.original, candidate))
			if (
				matches.length !== 1 ||
				origin.children.filter((other) => equal(other.original, row.original)).length !== 1
			)
				continue
			matches[0]!.content?.forEach((cell, index) => {
				const previous = row.children[index]!
				if (!cellOrigins.has(cell) && !used.has(previous)) assign(cell, previous)
			})
		}
		const retainedCellParameters = (cell: TypstSourceNodeOrigin) =>
			cell.cell?.parameters.filter(
				(parameter) =>
					!/^(?:x|y|colspan|rowspan)\s*:/.test(parameter) &&
					(!(appearance || styleChanged) || !/^stroke\s*:/.test(parameter)),
			) ?? []
		for (const cell of nextCells) {
			if (cellOrigins.has(cell)) continue
			let candidates = oldCells.filter(
				(previous) => !used.has(previous) && equal(previous.original, cell),
			)
			if (candidates.length === 0)
				candidates = oldCells.filter(
					(previous) => !used.has(previous) && equal(previous.original.content, cell.content),
				)
			if (
				candidates.length > 1 &&
				candidates.some(
					(previous) =>
						!equal(retainedCellParameters(previous), retainedCellParameters(candidates[0]!)) ||
						raw(previous.contentRange ?? previous) !==
							raw(candidates[0]!.contentRange ?? candidates[0]!),
				)
			)
				reject(
					origin,
					'Repeated cells have different source parameters; edit this structural change in source',
				)
			if (candidates[0]) assign(cell, candidates[0])
		}
		if (
			nextCells.some((cell) => !cellOrigins.has(cell)) &&
			oldCells.some(
				(cell) =>
					!used.has(cell) &&
					retainedCellParameters(cell).some((parameter) => !/^align\s*:/.test(parameter)),
			)
		)
			reject(origin, 'This structural change would discard native cell parameters; edit its source')
		const columnSources = Array.from(
				{ length: count },
				(_, index) => origin.table!.columnSources[index] ?? '1fr',
			),
			widths = new Map<number, number>()
		if (
			appearance != null &&
			!['grid', 'grid-open-sides', 'three-line', 'borderless'].includes(appearance)
		)
			reject(origin, 'Invalid table appearance')
		const border =
			appearance === 'grid' || appearance === 'grid-open-sides'
				? '.5pt + black'
				: appearance
					? 'none'
					: undefined
		let parameters = origin
			.table!.parameters.filter(
				(value) => !(appearance || styleChanged) || !/^stroke\s*:/.test(value),
			)
			.map((value) =>
				/^columns\s*:/.test(value) && count !== origin.table!.columns ? `columns: ${count}` : value,
			)
		if (!parameters.some((value) => /^columns\s*:/.test(value)))
			parameters.unshift(`columns: ${count}`)
		if (border) parameters.push(`stroke: ${border}`)
		const header: string[] = [],
			body: string[] = [],
			occupied = new Set<string>()
		let headerRows = 0
		while (
			headerRows < rows.length &&
			rows[headerRows]!.content?.every((cell) => cell.type === 'tableHeader')
		)
			headerRows++
		for (let y = 0; y < headerRows; y++)
			if (rows[y]!.content!.some((cell) => y + (cell.attrs?.rowspan ?? 1) > headerRows))
				headerRows = 0
		for (let y = 0; y < rows.length; y++) {
			let x = 0
			for (const cell of rows[y]!.content ?? []) {
				while (occupied.has(`${y}:${x}`)) x++
				const colspan = cell.attrs?.colspan ?? 1,
					rowspan = cell.attrs?.rowspan ?? 1
				if (Array.isArray(cell.attrs?.colwidth))
					cell.attrs.colwidth.forEach((width: number, index: number) => {
						if (width > 0) {
							if (widths.has(x + index) && widths.get(x + index) !== width)
								reject(origin, 'Conflicting widths for the same table column')
							widths.set(x + index, width)
							columnSources[x + index] = `${width * 0.75}pt`
						}
					})
				if (
					!Number.isSafeInteger(colspan) ||
					!Number.isSafeInteger(rowspan) ||
					colspan < 1 ||
					rowspan < 1 ||
					x + colspan > count ||
					y + rowspan > rows.length
				)
					reject(origin, 'Invalid merged table grid')
				for (let yy = y; yy < y + rowspan; yy++)
					for (let xx = x; xx < x + colspan; xx++) {
						if (occupied.has(`${yy}:${xx}`)) reject(origin, 'Overlapping table cells')
						occupied.add(`${yy}:${xx}`)
					}
				const sameBody = cellOrigins.get(cell),
					exact = sameBody && equal(sameBody.original, cell) ? sameBody : undefined
				let value: string
				if (
					!appearance &&
					!styleChanged &&
					exact &&
					!exact.cell?.parameters.some((parameter) => /^(?:x|y)\s*:/.test(parameter))
				)
					value = raw(exact)
				else {
					const alignChanged = !equal(sameBody?.original.attrs?.align, cell.attrs?.align)
					const retained =
						sameBody?.cell?.parameters.filter(
							(parameter) =>
								!/^(?:x|y|colspan|rowspan)\s*:/.test(parameter) &&
								(!alignChanged || !/^align\s*:/.test(parameter)) &&
								(!(appearance || styleChanged) || !/^stroke\s*:/.test(parameter)),
						) ?? []
					const attrs = [
						`x: ${x}`,
						`y: ${y}`,
						`colspan: ${colspan}`,
						`rowspan: ${rowspan}`,
						...retained,
					]
					if (alignChanged && cell.attrs?.align != null) attrs.push(`align: ${cell.attrs.align}`)
					if (appearance === 'grid-open-sides')
						attrs.push(
							`stroke: (top: ${border}, bottom: ${border}, left: ${x === 0 ? 'none' : border}, right: ${x + colspan === count ? 'none' : border})`,
						)
					else if (border) attrs.push(`stroke: ${border}`)
					const content = sameBody?.contentRange
						? raw(sameBody.contentRange)
						: (cell.content ?? []).map(serial).join('\n\n')
					value = `table.cell(${attrs.join(', ')})[${content}]`
				}
				;(y < headerRows ? header : body).push(value)
				x += colspan
			}
		}
		if (widths.size > 0)
			parameters = parameters.map((value) =>
				/^columns\s*:/.test(value) ? `columns: (${columnSources.join(', ')},)` : value,
			)
		if (appearance === 'three-line') {
			header.unshift('table.hline(y: 0, stroke: 1pt + black)')
			if (headerRows) header.push(`table.hline(y: ${headerRows}, stroke: .5pt + black)`)
			body.push(`table.hline(y: ${rows.length}, stroke: 1pt + black)`)
		}
		const values = [
			...parameters,
			...(headerRows ? [`table.header(${header.join(', ')})`] : header),
			...body,
		]
		patch(origin, `${raw(origin).startsWith('#') ? '#' : ''}table(\n  ${values.join(',\n  ')},\n)`)
	}

	const visit = (origin: TypstSourceNodeOrigin, next: JSONContent): void => {
		const before = origin.original
		if (equal(before, next)) return
		if (before.type !== next.type) {
			if (
				['bulletList', 'orderedList'].includes(before.type!) &&
				['bulletList', 'orderedList'].includes(next.type!)
			) {
				rewriteList(origin, next)
				return
			}
			if (origin.preserve || origin.fixed)
				reject(origin, 'Changing this node would discard preserved source; edit its source')
			patch(origin, serial(next))
			return
		}
		if (
			['bulletList', 'orderedList'].includes(before.type!) &&
			!equal(listShape(before), listShape(next))
		) {
			rewriteList(origin, next)
			return
		}
		if (before.type === 'table' && !equal(tableShape(before), tableShape(next))) {
			rewriteTable(origin, next)
			return
		}
		if (before.type === 'figureCaption' && origin.call?.callee === 'figure-caption') {
			patch(
				{ from: origin.call.insertAt, to: origin.call.insertAt },
				`${origin.call.insertPrefix ?? ', '}caption: [${(next.content ?? []).map(serial).join('')}]${origin.call.insertSuffix ?? ''}`,
			)
			return
		}
		if (before.type === 'text') {
			if (origin.textEncoding) {
				const code = marks(next).some((mark) => mark.type === 'code')
				if (!code && !origin.textEncoding.canUnwrap)
					reject(origin, 'This code expression has additional parameters; edit its source')
				markChange(
					origin,
					{ ...before, marks: marks(before).filter((mark) => mark.type !== 'code') },
					{ ...next, marks: marks(next).filter((mark) => mark.type !== 'code') },
				)
				if (!code) patch(origin, textEscape(next.text ?? ''))
				else if (before.text !== next.text)
					patch(
						origin.textEncoding.kind === 'string' ? origin.textEncoding.range : origin,
						origin.textEncoding.kind === 'string'
							? string(next.text ?? '')
							: `#raw(${string(next.text ?? '')})`,
					)
			} else if (marks(next).some((mark) => mark.type === 'code')) {
				const spans = origin.textSpans ?? []
				if (spans.some((span, index) => index > 0 && spans[index - 1]!.to !== span.from))
					reject(
						origin,
						'Applying code across preserved comments requires editing each text side separately',
					)
				markChange(origin, before, {
					...next,
					marks: marks(next).filter((mark) => mark.type !== 'code'),
				})
				patch(origin, `#raw(${string(next.text ?? '')})`)
			} else {
				markChange(origin, before, next)
				textChange(origin, before, next)
			}
			return
		}
		if (
			before.type === 'typstField' &&
			marks(before).some((mark) => mark.type === 'code') !==
				marks(next).some((mark) => mark.type === 'code')
		) {
			if (!equal(before.attrs, next.attrs))
				reject(origin, 'Edit a field through its authoritative JSON file or source')
			markChange(
				origin,
				{ ...before, marks: marks(before).filter((mark) => mark.type !== 'code') },
				{ ...next, marks: marks(next).filter((mark) => mark.type !== 'code') },
			)
			const source = String(before.attrs!.source)
			patch(
				origin,
				marks(next).some((mark) => mark.type === 'code')
					? `#raw(${source.replace(/^#/, '')})`
					: source,
			)
			return
		}
		if (
			['reference', 'inlineMath', 'typstField', 'typstInlineSource', 'hardBreak'].includes(
				before.type!,
			) &&
			!equal(before.marks, next.marks)
		)
			markChange(origin, before, next)
		if (before.type === 'image' && origin.call) {
			if (!equal(before.attrs?.title, next.attrs?.title))
				reject(origin, 'Image title has no native Typst image parameter')
			const changes: Record<string, string | null> = {}
			for (const name of ['width', 'height', 'alt'])
				if (!equal(before.attrs?.[name], next.attrs?.[name])) {
					const value = next.attrs?.[name]
					changes[name] = value == null ? null : name === 'alt' ? string(value) : imageSize(value)
				}
			changeCallParameters(origin, changes)
			if (!equal(before.attrs?.src, next.attrs?.src))
				patch(origin.attributeRanges!.src!, string(next.attrs?.src))
			return
		}
		if (before.type === 'orderedList' && origin.call) {
			const changes: Record<string, string | null> = {}
			if (!equal(before.attrs?.start, next.attrs?.start))
				changes.start = next.attrs?.start == null ? null : String(next.attrs.start)
			if (!equal(before.attrs?.type, next.attrs?.type))
				changes.numbering = next.attrs?.type == null ? null : string(`${next.attrs.type}.`)
			changeCallParameters(origin, changes)
			origin.children.forEach((child, index) => visit(child, next.content![index]!))
			return
		}
		if (before.type === 'typstSource' || before.type === 'typstInlineSource') {
			if (next.attrs?.role !== before.attrs?.role)
				reject(origin, 'Source role is derived from syntax and cannot be reassigned')
			patch(origin, String(next.attrs?.source ?? ''))
			return
		}
		if (before.type === 'typstComponent') {
			const declaration = projection.components?.find(
				(value) => value.module === before.attrs?.module && value.name === before.attrs?.name,
			)
			if (!declaration || !origin.call)
				reject(origin, 'This component declaration is no longer available')
			for (const key of ['module', 'name', 'label', 'parameters', 'binding', 'source'])
				if (!equal(before.attrs?.[key], next.attrs?.[key]))
					reject(origin, `Edit component ${key} through its source or authoritative JSON file`)
			const oldProps = before.attrs?.props ?? {},
				nextProps = next.attrs?.props ?? {},
				added: string[] = []
			for (const name of new Set([...Object.keys(oldProps), ...Object.keys(nextProps)])) {
				if (equal(oldProps[name], nextProps[name])) continue
				const definition = declaration!.parameters[name],
					value = nextProps[name]
				if (
					!definition ||
					typeof value !== definition.type ||
					(typeof value === 'number' && !Number.isFinite(value))
				)
					reject(origin, `Invalid ${name} component parameter`)
				const range = origin.call!.parameters[name]
				if (range) patch(range, string(value))
				else added.push(`${name}: ${string(value)}`)
			}
			if (added.length > 0)
				patch(
					{ from: origin.call!.insertAt, to: origin.call!.insertAt },
					`${origin.call!.insertPrefix ?? ', '}${added.join(', ')}${origin.call!.insertSuffix ?? ''}`,
				)
			return
		}
		const oldAttrs = nodeAttributes(before),
			newAttrs = nodeAttributes(next)
		for (const key of new Set([...Object.keys(oldAttrs), ...Object.keys(newAttrs)])) {
			if (equal(oldAttrs[key], newAttrs[key])) continue
			const range = origin.attributeRanges?.[key],
				value = newAttrs[key]
			if (key === 'textAlign') {
				if (value != null && !['left', 'center', 'right', 'justify'].includes(String(value)))
					reject(origin, 'Alignment must be left, center, right, justify or inherited')
				if (origin.alignment) {
					if (value == null) {
						patch({ from: origin.from, to: origin.alignment.body.from }, '')
						patch({ from: origin.alignment.body.to, to: origin.to }, '')
						if (origin.alignment.rule) patch(origin.alignment.rule, '')
					} else {
						patch(origin.alignment.alignment, value === 'justify' ? 'start' : String(value))
						if (origin.alignment.justify)
							patch(origin.alignment.justify, String(value === 'justify'))
						else
							patch(
								{ from: origin.alignment.body.from, to: origin.alignment.body.from },
								`#set par(justify: ${value === 'justify'})\n`,
							)
					}
				} else if (value != null) {
					patch(
						{ from: origin.from, to: origin.from },
						`#align(${value === 'justify' ? 'start' : value})[#set par(justify: ${value === 'justify'})\n`,
					)
					patch({ from: origin.to, to: origin.to }, ']')
				}
			} else if (key === 'label') {
				if (
					value != null &&
					(typeof value !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_:.-]*$/u.test(value))
				)
					reject(origin, 'A label must be a valid native Typst label')
				if (range) patch(range, value ? `<${value}>` : '')
				else if (value) patch({ from: origin.to, to: origin.to }, ` <${value}>`)
			} else if (range && key !== 'level')
				patch(
					range,
					key === 'src' || key === 'latex'
						? string(value)
						: key === 'target'
							? `<${value}>`
							: key === 'showCaption'
								? value == null
									? 'auto'
									: String(value)
								: String(value),
				)
			else if (before.type === 'reference' && key === 'showCaption' && origin.call)
				patch(
					{ from: origin.call.insertAt, to: origin.call.insertAt },
					`, caption: ${value == null ? 'auto' : value}`,
				)
			else if (before.type === 'heading' && key === 'level') {
				if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 6)
					reject(origin, 'Heading level must be 1–6')
				patch(
					range ?? { from: origin.from, to: origin.from + Number(oldAttrs.level ?? 1) },
					'='.repeat(Number(value)),
				)
			} else if (before.type === 'reference' && key === 'target') {
				patch(origin, serializeNode(next, '', projection.libraryAlias))
				return
			} else if (origin.preserve)
				reject(origin, `Changing ${key} requires editing its source expression`)
			else {
				patch(origin, serial(next))
				return
			}
		}
		if (before.type === 'codeBlock') {
			patch(
				origin.textEncoding?.range ?? origin,
				origin.textEncoding
					? string((next.content ?? []).map((node) => node.text ?? '').join(''))
					: serial(next),
			)
			return
		}
		const children = next.content ?? []
		if (
			children.length === origin.children.length &&
			children.every((node, index) => node.type === origin.children[index]!.original.type)
		) {
			children.forEach((node, index) => visit(origin.children[index]!, node))
		} else rewriteSequence(origin.children, children, origin)
		if (
			before.type === 'paragraph' &&
			children.length === 0 &&
			origin.children.length > 0 &&
			origin.call?.callee !== 'par'
		) {
			const body = origin.contentRange ?? origin
			patch({ from: body.from, to: body.from }, '#par[')
			patch({ from: body.to, to: body.to }, ']')
		}
	}
	const allowedAttrs: Record<string, readonly string[]> = {
		doc: [],
		text: [],
		paragraph: ['textAlign'],
		heading: ['level', 'label', 'textAlign'],
		blockquote: [],
		hardBreak: [],
		horizontalRule: [],
		bulletList: [],
		orderedList: ['start', 'type'],
		listItem: [],
		codeBlock: ['language'],
		image: ['src', 'alt', 'title', 'width', 'height'],
		table: ['tableStyle'],
		tableRow: [],
		tableCell: ['colspan', 'rowspan', 'colwidth', 'align'],
		tableHeader: ['colspan', 'rowspan', 'colwidth', 'align'],
		figure: ['id', 'label'],
		figureCaption: [],
		inlineMath: ['latex'],
		blockMath: ['id', 'label', 'latex'],
		reference: ['target', 'showCaption'],
		typstSource: ['source', 'role'],
		typstInlineSource: ['source', 'role'],
		typstField: ['file', 'path', 'source'],
		typstComponent: ['module', 'name', 'label', 'parameters', 'props', 'binding', 'source'],
	}
	const allowedMarkAttrs: Record<string, readonly string[]> = {
		bold: [],
		italic: [],
		strike: [],
		underline: [],
		code: [],
		link: ['href', 'target', 'rel', 'class', 'title'],
		textStyle: ['fontFamily', 'fontSize', 'color', 'backgroundColor'],
	}
	const validate = (node: JSONContent): void => {
		const allowed = node.type && allowedAttrs[node.type]
		if (!allowed) throw new Error(`Unsupported node ${node.type}`)
		if (node.attrs && (typeof node.attrs !== 'object' || Array.isArray(node.attrs)))
			throw new Error('Node attributes must be an object')
		for (const key of Object.keys(node.attrs ?? {}))
			if (!allowed.includes(key)) throw new Error(`Unsupported ${node.type} attribute ${key}`)
		if (node.type === 'image') {
			if (typeof node.attrs?.src !== 'string' || !node.attrs.src)
				throw new Error('Images require a source path')
			if (node.attrs?.alt != null && typeof node.attrs.alt !== 'string')
				throw new Error('Image alternative text must be a string')
			for (const name of ['width', 'height'])
				if (node.attrs?.[name] != null) imageSize(node.attrs[name])
		}
		if (
			node.type === 'orderedList' &&
			((node.attrs?.start != null &&
				(!Number.isSafeInteger(node.attrs.start) || node.attrs.start < 1)) ||
				(node.attrs?.type != null && !['1', 'a', 'A', 'i', 'I'].includes(node.attrs.type)))
		)
			throw new Error(
				'Ordered lists require a positive integer start and a supported numbering type',
			)
		if (
			['tableCell', 'tableHeader'].includes(node.type!) &&
			node.attrs?.align != null &&
			!['left', 'center', 'right'].includes(node.attrs.align)
		)
			throw new Error('Cell alignment must be left, center, right or inherited')
		if (
			node.type === 'text' &&
			(typeof node.text !== 'string' || node.text.length === 0 || !node.text.isWellFormed())
		)
			throw new Error('Text nodes require nonempty well-formed text')
		for (const mark of node.marks ?? []) {
			const markAttributes = allowedMarkAttrs[mark.type]
			if (!markAttributes) throw new Error(`Unsupported mark ${mark.type}`)
			if (mark.type === 'code' && !['text', 'typstField'].includes(node.type!))
				throw new Error(
					'Code marks require literal text or a data field; other expressions retain their native rendering',
				)
			for (const key of Object.keys(mark.attrs ?? {}))
				if (!markAttributes.includes(key))
					throw new Error(`Unsupported ${mark.type} attribute ${key}`)
		}
		if (node.content) {
			if (!Array.isArray(node.content)) throw new Error('Node content must be an array')
			node.content.forEach(validate)
		}
	}
	try {
		validate(document)
		if (document.type !== 'doc' || !Array.isArray(document.content))
			throw new Error('An edit requires a complete Tiptap document')
		if (equal(projection.document, document)) return { ok: true, value: [] }
		const next = document.content
		const relocated = next.some((node, index) => {
			const origin = projection.origins[index]
			if (
				node.type === 'figure' &&
				origin?.original.type === 'figure' &&
				node.attrs?.id !== origin.original.attrs?.id
			)
				return true
			return projection.origins.some(
				(other, previous) =>
					previous !== index &&
					(other.fixed || other.original.type === 'typstSource') &&
					equal(other.original, node),
			)
		})
		if (
			!relocated &&
			next.length === projection.origins.length &&
			next.every((node, index) => node.type === projection.origins[index]!.original.type)
		)
			next.forEach((node, index) => visit(projection.origins[index]!, node))
		else rewriteSequence(projection.origins, next, undefined)
		patches.sort((a, b) => a.from - b.from || a.to - b.to)
		for (let index = 1; index < patches.length; index++) {
			// Join a delimiter insertion with the adjacent replacement so the atomic
			// transaction never has to guess which same-boundary operation runs first.
			if (
				patches[index - 1]!.to === patches[index]!.from &&
				(patches[index - 1]!.from !== patches[index - 1]!.to ||
					patches[index]!.from !== patches[index]!.to)
			) {
				patches[index - 1]!.to = patches[index]!.to
				patches[index - 1]!.text += patches[index]!.text
				patches.splice(index--, 1)
				continue
			}
			if (
				!patches[index - 1]!.text &&
				!patches[index]!.text &&
				patches[index - 1]!.to >= patches[index]!.from
			) {
				patches[index - 1]!.to = Math.max(patches[index - 1]!.to, patches[index]!.to)
				patches.splice(index--, 1)
				continue
			}
			const before = patches[index - 1]!,
				following = patches[index]!
			if (
				before.to > following.from ||
				(before.from === following.from && before.to === following.to)
			)
				throw new Error(
					'This edit requires overlapping source changes; apply the changes separately',
				)
		}
		return { ok: true, value: patches }
	} catch (error) {
		return {
			ok: false,
			issues: [
				{
					code: 'UNSUPPORTED_EDIT',
					severity: 'error',
					path: projection.path,
					revision: projection.revision,
					from: failed.from,
					to: failed.to,
					message: error instanceof Error ? error.message : String(error),
				},
			],
		}
	}
}
