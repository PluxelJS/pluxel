import { getSchema, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { createTypstExtensions } from './extensions.js'
import {
	isReferenceObject,
	referenceKind,
	validReferenceId,
	validReferenceLabel,
} from './document-nodes.js'
import type { TypstEditorConfig, TypstReferenceTarget } from './types.js'

/** Snapshot of referable objects in native document order. Input must be admitted JSON. */
export function collectTypstReferenceTargets(
	regions: Readonly<Record<string, JSONContent>>,
	config?: Pick<TypstEditorConfig, 'extensions'>,
): TypstReferenceTarget[] {
	const schema = getSchema(createTypstExtensions(config))
	const result: TypstReferenceTarget[] = []
	for (const [regionId, document] of Object.entries(regions)) {
		result.push(...referenceTargetsInDocument(schema.nodeFromJSON(document), regionId))
	}
	return result
}

/** Internal native traversal also serves live editors without rebuilding their schema or JSON. */
export function referenceTargetsInDocument(
	document: ProseMirrorNode,
	regionId: string,
): TypstReferenceTarget[] {
	const result: TypstReferenceTarget[] = []
	document.descendants((node, position) => {
		if (
			!isReferenceObject(node.type.name) ||
			!validReferenceId(node.attrs.id) ||
			!validReferenceLabel(node.attrs.label)
		)
			return
		result.push({
			id: node.attrs.id,
			label: node.attrs.label,
			kind: referenceKind(node.type.name, node.firstChild?.type.name),
			regionId,
			title:
				node.type.name === 'blockMath' ? node.attrs.latex : (node.lastChild?.textContent ?? ''),
			position,
		})
	})
	return result
}
