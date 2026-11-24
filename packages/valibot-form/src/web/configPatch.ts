import { makePathArray } from '@tanstack/react-form'
import type { FieldNode } from '../core/fields'

/** Diff editable raw inputs. Structural fields replace atomically; undefined restores inheritance. */
export function buildEditableConfigPatch(
	fields: readonly FieldNode[],
	candidate: Record<string, unknown>,
	current: Record<string, unknown>,
): { set?: Record<string, unknown>; remove?: string[][] } {
	const set: Record<string, unknown> = {}
	const remove: string[][] = []
	const visit = (
		nodes: readonly FieldNode[],
		next: Record<string, unknown>,
		previous: Record<string, unknown>,
		parent: string[],
	) => {
		for (const node of nodes) {
			if (!editable(node)) continue
			const value = next[node.name]
			const before = previous[node.name]
			if (Object.is(value, before) || JSON.stringify(value) === JSON.stringify(before)) continue
			const path = [...parent, node.name]
			if (node.kind === 'object' && (isRecord(value) || value === undefined)) {
				visit(node.fields, isRecord(value) ? value : {}, isRecord(before) ? before : {}, path)
			} else {
				// Replacing a union/record also deletes keys left by the previous branch.
				remove.push(path)
				if (value !== undefined) write(set, path, value)
			}
		}
	}
	visit(fields, candidate, current, [])
	return {
		...(Object.keys(set).length > 0 ? { set } : {}),
		...(remove.length > 0 ? { remove } : {}),
	}
}
export function editableConfigPaths(
	fields: readonly FieldNode[],
	parent: readonly string[] = [],
): readonly (readonly string[])[] {
	return fields.flatMap((node) => {
		if (!editable(node)) return []
		const path = [...parent, node.name]
		return node.kind === 'object' ? editableConfigPaths(node.fields, path) : [path]
	})
}
function editable(node: FieldNode): node is FieldNode & { name: string } {
	if (!node.name) return false
	const parsed = makePathArray(node.name)
	return (
		parsed.length === 1 &&
		parsed[0] === node.name &&
		node.kind !== 'unsupported' &&
		!node.meta.readOnly &&
		!node.meta.disabled
	)
}
function write(root: Record<string, unknown>, path: readonly string[], value: unknown) {
	let cursor = root
	for (const key of path.slice(0, -1)) {
		const existing = Object.hasOwn(cursor, key) ? cursor[key] : undefined
		const next = isRecord(existing) ? existing : {}
		setOwn(cursor, key, next)
		cursor = next
	}
	setOwn(cursor, path.at(-1)!, value)
}
/** Preserve literal field names such as "__proto__" in plain, serializable records. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	})
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
