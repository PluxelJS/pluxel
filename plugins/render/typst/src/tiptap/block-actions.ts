import { CommandManager, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { canEdit, type EditorUiContext } from './editor-ui'
import { blockTypes, convertBlock, type BlockType } from './insert-commands'

export interface BlockTarget {
	pos: number
	node: ProseMirrorNode
	doc: ProseMirrorNode
}

export type BlockConversion = BlockType | 'bulletList' | 'orderedList'
export const blockConversions: { value: BlockConversion; label: string; node: string }[] = [
	...blockTypes,
	{ value: 'bulletList', label: '无序列表', node: 'bulletList' },
	{ value: 'orderedList', label: '有序列表', node: 'orderedList' },
]

export type BlockAction =
	| 'duplicate'
	| 'delete'
	| 'moveUp'
	| 'moveDown'
	| { type: 'convert'; block: BlockConversion }

function topLevelPosition(doc: ProseMirrorNode, position: number) {
	if (!Number.isSafeInteger(position) || position < 0 || position >= doc.content.size)
		return undefined
	const resolved = doc.resolve(position)
	return resolved.depth === 0 ? position : resolved.before(1)
}

/** Resolve cells/list items to their whole top-level owner; multi-block selections are ambiguous. */
export function captureBlockTarget(editor: Editor, position?: number): BlockTarget | undefined {
	const { doc, selection } = editor.state
	const pos = topLevelPosition(doc, position ?? selection.from)
	if (pos === undefined) return undefined
	if (position === undefined && !selection.empty && topLevelPosition(doc, selection.to - 1) !== pos)
		return undefined
	const node = doc.nodeAt(pos)
	if (!node?.isBlock || node.type.name === 'typstSource') return undefined
	return { pos, node, doc }
}

function simpleTextBlock(node: ProseMirrorNode): boolean {
	return ['paragraph', 'heading', 'codeBlock'].includes(node.type.name)
}

function convertible(node: ProseMirrorNode): boolean {
	if (simpleTextBlock(node)) return true
	if (node.type.name === 'blockquote')
		return (
			node.childCount > 0 &&
			Array.from({ length: node.childCount }, (_, i) => node.child(i)).every(simpleTextBlock)
		)
	if (['bulletList', 'orderedList'].includes(node.type.name))
		return Array.from({ length: node.childCount }, (_, i) => node.child(i)).every(
			(item) =>
				item.type.name === 'listItem' &&
				item.childCount === 1 &&
				item.firstChild?.type.name === 'paragraph',
		)
	return false
}

function validDocument(ui: EditorUiContext, doc: ProseMirrorNode): boolean {
	return ui.validateDocument?.(doc.toJSON()) ?? true
}

/** Prepare one native transaction against an explicit, unchanged top-level block. */
export function prepareBlockAction(
	editor: Editor,
	ui: EditorUiContext,
	target: BlockTarget,
	action: BlockAction,
): Transaction | undefined {
	if (
		!canEdit(editor, ui) ||
		editor.state.doc !== target.doc ||
		target.doc.nodeAt(target.pos) !== target.node ||
		captureBlockTarget(editor, target.pos)?.pos !== target.pos
	)
		return undefined
	if (!validDocument(ui, target.doc)) return undefined
	if (action === 'duplicate' && ui.prepareDuplicate) return ui.prepareDuplicate(editor, target.pos)
	const manager = new CommandManager({ editor, state: editor.state })
	const chain = manager.chain().command(({ tr }) => {
		closeHistory(tr)
		return true
	})
	const end = target.pos + target.node.nodeSize
	if (action === 'duplicate') {
		return undefined
	} else if (action === 'delete') {
		chain.setNodeSelection(target.pos).deleteSelection()
	} else if (action === 'moveUp' || action === 'moveDown') {
		const index = target.doc.resolve(target.pos).index()
		const adjacent = target.doc.maybeChild(index + (action === 'moveUp' ? -1 : 1))
		if (!adjacent) return undefined
		const destination = target.pos + (action === 'moveUp' ? -adjacent.nodeSize : adjacent.nodeSize)
		chain.command(({ tr }) => {
			tr.delete(target.pos, end).insert(destination, target.node)
			tr.setSelection(NodeSelection.create(tr.doc, destination))
			return true
		})
	} else {
		if (!convertible(target.node)) return undefined
		const desired = action.block.startsWith('heading-') ? 'heading' : action.block
		if (
			target.node.type.name === desired &&
			(desired !== 'heading' || target.node.attrs.level === Number(action.block.slice(-1)))
		)
			return undefined
		let from: number | undefined
		let to: number | undefined
		let containsInlineAtom = false
		target.doc.nodesBetween(target.pos, end, (node, at) => {
			if (node.isTextblock) {
				from ??= at + 1
				to = at + node.nodeSize - 1
			}
			if (node.isInline && !node.isText) containsInlineAtom = true
		})
		if (from === undefined || to === undefined || (desired === 'codeBlock' && containsInlineAtom))
			return undefined
		chain.setTextSelection({ from, to })
		const currentList = ['bulletList', 'orderedList'].includes(target.node.type.name)
		const desiredList = desired === 'bulletList' || desired === 'orderedList'
		if (currentList && !desiredList) chain.liftListItem('listItem')
		if (desiredList) {
			if (!currentList) convertBlock(chain, 'paragraph')
			chain.toggleList(desired, 'listItem')
		} else convertBlock(chain, action.block as BlockType)
	}
	let transaction: Transaction | undefined
	const success = chain
		.command(({ tr }) => {
			transaction = tr
			return true
		})
		.run()
	return success && transaction?.docChanged && validDocument(ui, transaction.doc)
		? transaction.scrollIntoView()
		: undefined
}
