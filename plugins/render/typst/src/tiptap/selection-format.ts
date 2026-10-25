import type { Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'
import type { BlockType } from './insert-commands'
import {
	fontFamilyName,
	fontSizeInPoints,
	textStyleAttributes,
	textStyleColor,
	type TextStyleAttribute,
} from './text-style'

const styleKeys = textStyleAttributes
type StyleKey = TextStyleAttribute

/** Empty means inherited; null means mixed. Read the native ranges, including cell selections. */
export function selectionTextStyle(editor: Editor): Record<StyleKey, string | null> {
	const values = Object.fromEntries(styleKeys.map((key) => [key, new Set<string>()])) as Record<
		StyleKey,
		Set<string>
	>
	function collect(marks: readonly Mark[]) {
		const attrs = marks.find((mark) => mark.type.name === 'textStyle')?.attrs
		for (const key of styleKeys) {
			const value = attrs?.[key] ?? ''
			if (key === 'fontFamily') values[key].add(fontFamilyName(value) ?? value)
			else if (key === 'fontSize') {
				const points = fontSizeInPoints(value)
				values[key].add(points === undefined ? value : `${points}pt`)
			} else {
				const color = textStyleColor(value)
				values[key].add(
					color ? `rgba(${color.red}, ${color.green}, ${color.blue}, ${color.alpha})` : value,
				)
			}
		}
	}
	const { selection, storedMarks, doc } = editor.state
	if (selection.empty) collect(storedMarks ?? selection.$from.marks())
	else
		for (const { $from, $to } of selection.ranges)
			doc.nodesBetween($from.pos, $to.pos, (node) => {
				if (node.isInline) collect(node.marks)
				else if (node.isTextblock && node.content.size === 0) collect([])
			})
	return Object.fromEntries(
		styleKeys.map((key) => [
			key,
			values[key].size > 1 ? null : (values[key].values().next().value ?? ''),
		]),
	) as Record<StyleKey, string | null>
}

/** Only paragraphs/headings own alignment; mixed selections never imply a single value. */
export function selectionAlignment(editor: Editor): string | null {
	const values = new Set<string>()
	const { selection, doc } = editor.state
	const collect = (node: typeof doc) => {
		if (node.type.name === 'paragraph' || node.type.name === 'heading')
			values.add(node.attrs.textAlign ?? '')
	}
	if (selection.empty) collect(selection.$from.parent)
	else for (const { $from, $to } of selection.ranges) doc.nodesBetween($from.pos, $to.pos, collect)
	return values.size > 1 ? null : (values.values().next().value ?? '')
}

/** Block style includes its quote context; a mixed selection must remain convertible to any type. */
export function selectionBlockType(editor: Editor): BlockType | null {
	const values = new Set<BlockType>()
	let allQuoted = true
	const { selection, doc } = editor.state
	function collect(position: number) {
		const $position = doc.resolve(position)
		const node = $position.parent
		if (!node.isTextblock) return
		let quoted = false
		for (let depth = $position.depth - 1; depth > 0; depth--)
			if ($position.node(depth).type.name === 'blockquote') quoted = true
		allQuoted &&= quoted
		if (node.type.name === 'codeBlock') {
			values.add('codeBlock')
			return
		}
		if (quoted) {
			values.add('blockquote')
			return
		}
		values.add(
			node.type.name === 'heading' ? (`heading-${node.attrs.level}` as BlockType) : 'paragraph',
		)
	}
	if (selection.empty) collect(selection.from)
	else
		for (const { $from, $to } of selection.ranges)
			doc.nodesBetween($from.pos, $to.pos, (node, position) => {
				if (node.isTextblock) collect(position + 1)
			})
	if (allQuoted && values.has('blockquote')) return 'blockquote'
	return values.size > 1 ? null : (values.values().next().value ?? 'paragraph')
}
