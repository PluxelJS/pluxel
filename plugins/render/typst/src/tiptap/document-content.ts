import type { Editor, JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode, Schema } from '@tiptap/pm/model'
import { closeHistory } from '@tiptap/pm/history'
import { NodeSelection, type Transaction } from '@tiptap/pm/state'
import { documentSync } from './editor-transactions.js'

export const isDocumentPlaceholder = (name: string): boolean =>
	name === 'documentBlock' || name === 'documentInline'

/** Reject unknown attributes instead of silently discarding source or unsupported host data. */
export function readDocument(schema: Schema, content: JSONContent): ProseMirrorNode {
	const inspect = (node: JSONContent) => {
		const type = schema.nodes[node.type ?? '']
		if (!type) throw new TypeError(`Unsupported document node: ${String(node.type)}`)
		for (const key of Object.keys(node.attrs ?? {}))
			if (!Object.hasOwn(type.spec.attrs ?? {}, key))
				throw new TypeError(`Unsupported ${node.type} attribute: ${key}`)
		for (const mark of node.marks ?? []) {
			const markType = schema.marks[mark.type]
			if (!markType) throw new TypeError(`Unsupported document mark: ${mark.type}`)
			for (const key of Object.keys(mark.attrs ?? {}))
				if (!Object.hasOwn(markType.spec.attrs ?? {}, key))
					throw new TypeError(`Unsupported ${mark.type} attribute: ${key}`)
		}
		for (const child of node.content ?? []) inspect(child)
	}
	inspect(content)
	const document = schema.nodeFromJSON(content)
	if (document.type !== schema.topNodeType) throw new TypeError('Document content must be a doc.')
	document.check()
	return document
}

function placeholders(document: ProseMirrorNode): ProseMirrorNode[] {
	const nodes: ProseMirrorNode[] = []
	document.descendants((node) => {
		if (isDocumentPlaceholder(node.type.name)) nodes.push(node)
	})
	return nodes
}

/** Fixed content is supplied by the host; ordinary edits preserve its sequence and values. */
export function preservesDocumentPlaceholders(
	before: ProseMirrorNode,
	after: ProseMirrorNode,
): boolean {
	const previous = placeholders(before)
	const next = placeholders(after)
	return previous.length === next.length && previous.every((node, index) => node.eq(next[index]!))
}

/** Replace only the changed range so a normal host echo leaves the native selection alone. */
export function synchronizeDocument(editor: Editor, content: JSONContent): void {
	const next = readDocument(editor.schema, content)
	const previous = editor.state.doc
	const start = previous.content.findDiffStart(next.content)
	if (start === null) return
	const end = previous.content.findDiffEnd(next.content)!
	const overlap = start - Math.min(end.a, end.b)
	const fromEnd = end.a + Math.max(0, overlap)
	const toEnd = end.b + Math.max(0, overlap)
	const transaction = editor.state.tr
		.replace(start, fromEnd, next.slice(start, toEnd))
		.setMeta(documentSync, true)
		.setMeta('preventUpdate', true)
		.setMeta('addToHistory', false)
	editor.view.dispatch(transaction)
}

/** Native duplication gives referenceable objects new identities, including internal references. */
export function copyDocumentBlock(
	transaction: Transaction,
	position: number,
	commit: boolean,
): boolean {
	if (!Number.isSafeInteger(position) || position < 0 || position >= transaction.doc.content.size)
		return false
	const resolved = transaction.doc.resolve(position)
	const original = transaction.doc.nodeAt(position)
	if (resolved.depth !== 0 || !original?.isBlock) return false
	const document = original.toJSON() as JSONContent
	const identities = new Map<string, string>()
	let fixed = false
	const visit = (node: JSONContent, action: (node: JSONContent) => void) => {
		action(node)
		for (const child of node.content ?? []) visit(child, action)
	}
	visit(document, (node) => {
		if (isDocumentPlaceholder(node.type!)) fixed = true
		if (!['figure', 'blockMath', 'heading'].includes(node.type!)) return
		const id = crypto.randomUUID()
		if (typeof node.attrs?.id === 'string') identities.set(node.attrs.id, id)
		node.attrs = { ...node.attrs, id }
	})
	if (fixed) return false
	visit(document, (node) => {
		if (node.type === 'reference' && identities.has(node.attrs?.target))
			node.attrs = { ...node.attrs, target: identities.get(node.attrs!.target) }
	})
	const copied = original.type.schema.nodeFromJSON(document)
	copied.check()
	const at = position + original.nodeSize
	if (!resolved.parent.canReplaceWith(resolved.index() + 1, resolved.index() + 1, copied.type))
		return false
	if (commit) {
		closeHistory(transaction).insert(at, copied)
		transaction.setSelection(NodeSelection.create(transaction.doc, at))
	}
	return true
}

export function prepareDocumentCopy(editor: Editor, position: number): Transaction | undefined {
	if (!editor.isEditable || editor.view.composing) return undefined
	const transaction = editor.state.tr
	return copyDocumentBlock(transaction, position, true) ? transaction : undefined
}
