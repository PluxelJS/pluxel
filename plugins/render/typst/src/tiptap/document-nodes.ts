import { Node, mergeAttributes, type Command, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { TypstReferenceTarget } from './types.js'
import './document-commands.js'

const figureBodies = new Set(['image', 'table', 'typstComponent', 'typstSource'])
export const isReferenceObject = (name: string): boolean =>
	name === 'figure' || name === 'blockMath'
export const validReferenceLabel = (value: unknown): value is string =>
	typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_:.-]{0,127}$/u.test(value)

export function referenceKind(
	name: string,
	bodyName?: string,
): Exclude<TypstReferenceTarget['kind'], 'heading'> {
	return name === 'blockMath' ? 'equation' : bodyName === 'table' ? 'table' : 'figure'
}

function labelFor(node: JSONContent, id: string): string {
	return `${{ figure: 'fig', table: 'tbl', equation: 'eq' }[referenceKind(node.type!, node.content?.[0]?.type)]}:${id}`
}

export function allocateIdentity(
	doc: ProseMirrorNode,
	commit: boolean,
	reserved = new Set<string>(),
): string {
	doc.descendants((node) => {
		if (typeof node.attrs.id === 'string') reserved.add(node.attrs.id)
		if (typeof node.attrs.label === 'string' && node.attrs.label.startsWith('object-'))
			reserved.add(node.attrs.label.slice('object-'.length))
	})
	let id = commit ? crypto.randomUUID() : 'object-0'
	let index = 0
	while (reserved.has(id)) id = commit ? crypto.randomUUID() : `object-${++index}`
	reserved.add(id)
	return id
}

function canChange(_name: string, props: Parameters<Command>[0]): boolean {
	return props.editor.isEditable && !props.editor.view.composing
}

/** Editable caption is a child of its figure, never an independent paragraph. */
export const TypstFigureCaption = Node.create({
	name: 'figureCaption',
	content: 'inline*',
	parseHTML: () => [{ tag: 'figcaption' }],
	renderHTML: ({ HTMLAttributes }) => ['figcaption', HTMLAttributes, 0],
	addKeyboardShortcuts() {
		return {
			Enter: () =>
				this.editor.commands.command((props) => {
					const { $from, empty } = props.state.selection
					if (
						!canChange('paragraph', props) ||
						!empty ||
						$from.parent.type.name !== this.name ||
						$from.parentOffset !== $from.parent.content.size ||
						$from.depth < 2
					)
						return false
					const figureDepth = $from.depth - 1
					if ($from.node(figureDepth).type.name !== 'figure') return false
					const after = $from.after(figureDepth)
					const next = props.tr.doc.nodeAt(after)
					const paragraph = props.state.schema.nodes.paragraph!
					const $after = props.tr.doc.resolve(after)
					if (
						next?.type !== paragraph &&
						!$after.parent.canReplaceWith($after.index(), $after.index(), paragraph)
					)
						return false
					if (props.dispatch) {
						closeHistory(props.tr)
						if (next?.type !== paragraph) props.tr.insert(after, paragraph.create())
						props.tr.setSelection(TextSelection.create(props.tr.doc, after + 1)).scrollIntoView()
					}
					return true
				}),
		}
	},
})

/** Exactly one editable body plus its caption. Optional body extensions are composed by the kit. */
export const TypstFigure = Node.create({
	name: 'figure',
	group: 'block',
	content: '(image | table) figureCaption',
	draggable: true,
	defining: true,
	isolating: true,
	addAttributes: () => ({ id: { default: null }, label: { default: null } }),
	parseHTML: () => [{ tag: 'figure' }],
	renderHTML: ({ HTMLAttributes }) => [
		'figure',
		mergeAttributes(HTMLAttributes, { 'data-typst-figure': '' }),
		0,
	],
	addCommands() {
		return {
			insertTypstFigure: (options) => (props) => {
				if (!canChange(this.name, props) || !figureBodies.has(options.body.type!)) return false
				const id = allocateIdentity(props.tr.doc, !!props.dispatch)
				const privateIdentity = props.state.schema.nodes[this.name]!.spec.attrs?.id
				const content: JSONContent = {
					type: this.name,
					attrs: {
						...(privateIdentity && { id }),
						label:
							options.label ??
							(privateIdentity
								? labelFor({ type: this.name, content: [options.body] }, id)
								: 'object-' + id),
					},
					content: [
						structuredClone(options.body),
						{ type: 'figureCaption', content: structuredClone(options.caption ?? []) },
					],
				}
				if (!validReferenceLabel(content.attrs!.label)) return false
				try {
					props.state.schema.nodeFromJSON(content).check()
				} catch {
					return false
				}
				if (!props.dispatch) return true
				closeHistory(props.tr)
				return props.commands.insertContent(content)
			},
			wrapTypstFigure:
				(position, caption = []) =>
				(props) => {
					if (
						!canChange(this.name, props) ||
						!Number.isSafeInteger(position) ||
						position < 0 ||
						position >= props.tr.doc.content.size
					)
						return false
					const body = props.tr.doc.nodeAt(position)
					if (
						!body ||
						!figureBodies.has(body.type.name) ||
						props.tr.doc.resolve(position).parent.type.name === this.name
					)
						return false
					const id = allocateIdentity(props.tr.doc, !!props.dispatch)
					const privateIdentity = props.state.schema.nodes[this.name]!.spec.attrs?.id
					const json: JSONContent = {
						type: this.name,
						attrs: privateIdentity
							? { id, label: labelFor({ type: this.name, content: [body.toJSON()] }, id) }
							: { label: 'object-' + id },
						content: [body.toJSON(), { type: 'figureCaption', content: structuredClone(caption) }],
					}
					let figure: ProseMirrorNode
					try {
						figure = props.state.schema.nodeFromJSON(json)
						figure.check()
					} catch {
						return false
					}
					const $position = props.tr.doc.resolve(position)
					if (
						!$position.parent.canReplaceWith($position.index(), $position.index() + 1, figure.type)
					)
						return false
					if (props.dispatch) {
						closeHistory(props.tr)
						props.tr.replaceWith(position, position + body.nodeSize, figure)
						props.tr.setSelection(NodeSelection.create(props.tr.doc, position))
					}
					return true
				},
		}
	},
})

/** A reference names a native Typst label. */
export const TypstReference = Node.create({
	name: 'reference',
	group: 'inline',
	inline: true,
	atom: true,
	selectable: true,
	addAttributes: () => ({
		target: {
			default: null,
			parseHTML: (element: HTMLElement) => element.getAttribute('data-typst-reference'),
			renderHTML: (attrs: Record<string, unknown>) => ({ 'data-typst-reference': attrs.target }),
		},
		showCaption: {
			default: null,
			parseHTML: (element: HTMLElement) => {
				const value = element.getAttribute('data-typst-reference-caption')
				return value === null ? null : value === 'true' ? true : value === 'false' ? false : value
			},
			renderHTML: (attrs: Record<string, unknown>) =>
				attrs.showCaption == null
					? {}
					: { 'data-typst-reference-caption': String(attrs.showCaption) },
		},
	}),
	parseHTML: () => [{ tag: 'span[data-typst-reference]' }],
	renderHTML: ({ node, HTMLAttributes }) => [
		'span',
		mergeAttributes(HTMLAttributes, { 'data-typst-reference': node.attrs.target }),
		`@${node.attrs.target ?? '?'}`,
	],
	renderText: ({ node }) => `@${node.attrs.target ?? '?'}`,
	addCommands() {
		return {
			insertTypstReference: (target) => (props) =>
				canChange(this.name, props) &&
				validReferenceLabel(target) &&
				props.commands.insertContent({ type: this.name, attrs: { target } }),
		}
	},
})
