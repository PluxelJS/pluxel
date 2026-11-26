import { isRecord } from '../core/fieldInput'
import type { FieldNode } from '../core/fields'
import { fieldName } from './components/internal/fieldPath'
import {
	hasProtectedValue,
	hasUnsupportedField,
	isProtectedField,
} from './components/internal/fieldProtection'

type ConfigInput = Readonly<Record<string, unknown>>

/** Diff sparse raw inputs within the field tree's writable scope. Apply remove before set. */
export function buildEditableConfigPatch(
	fields: readonly FieldNode[],
	candidate: ConfigInput,
	current: ConfigInput,
): { set?: Record<string, unknown>; remove?: string[][] } {
	const set: Record<string, unknown> = {}
	const remove: string[][] = []

	// Track surviving keys so an explicitly empty object can be written back after
	// Host prunes the last removed child. Unknown and protected keys always survive.
	function visit(
		nodes: readonly FieldNode[],
		next: ConfigInput,
		previous: ConfigInput,
		parent: readonly string[],
	): number {
		const remaining = new Set(Object.keys(previous))
		for (const node of nodes) {
			const name = node.name
			if (name === undefined || isProtectedField(node)) continue
			const before = own(previous, name)
			const value = own(next, name)
			if (Object.is(value, before)) continue
			const path = [...parent, name]
			if (node.kind === 'object') {
				if (isRecord(value)) {
					const count = visit(node.fields, value, isRecord(before) ? before : {}, path)
					if (count === 0 && (!isRecord(before) || Object.keys(before).length > 0))
						write(set, path, {})
					remaining.add(name)
					continue
				}
				if (isRecord(before)) {
					if (value === undefined) {
						if (visit(node.fields, {}, before, path) === 0) {
							remaining.delete(name)
							if (Object.keys(before).length === 0) remove.push(path)
						}
						continue
					}
					if (hasProtectedValue(node, before)) continue
				}
			}
			const raw = omitUndefined(value)
			if (equalDraft(raw, before)) continue
			if (raw === undefined) {
				remaining.delete(name)
				remove.push(path)
			} else {
				remaining.add(name)
				// Host merges records. Clear the old keys when replacing a record or union.
				if (isRecord(raw) && isRecord(before)) remove.push(path)
				write(set, path, raw)
			}
		}
		return remaining.size
	}

	visit(prepareEditableConfigFields(fields, current), candidate, current, [])
	return {
		...(Object.keys(set).length > 0 ? { set } : {}),
		...(remove.length > 0 ? { remove } : {}),
	}
}

/** Saved paths that can be removed without changing protected values. */
export function editableConfigPaths(
	fields: readonly FieldNode[],
	current: ConfigInput,
): readonly (readonly string[])[] {
	return buildEditableConfigPatch(fields, {}, current).remove ?? []
}

/** Apply the same write restrictions to controls that save and scoped reset use. */
export function prepareEditableConfigFields(
	fields: readonly FieldNode[],
	current: ConfigInput,
): readonly FieldNode[] {
	function prepare(nodes: readonly FieldNode[], saved: ConfigInput, root: boolean) {
		return nodes.map((node): FieldNode => {
			if (node.name === undefined || isProtectedField(node)) return node
			const value = own(saved, node.name)
			const reason = configLockReason(node, node.name, value, root)
			if (reason) {
				if (node.kind === 'union') {
					return {
						...node,
						meta: {
							...node.meta,
							readOnly: true,
							description: [node.meta.description, reason].filter(Boolean).join(' '),
						},
					}
				}
				return {
					kind: 'unsupported',
					name: node.name,
					path: node.path,
					depth: node.depth,
					required: node.required,
					nullable: node.nullable,
					meta: { ...node.meta, readOnly: true },
					readOnly: true,
					reason,
				}
			}
			return node.kind === 'object'
				? { ...node, fields: prepare(node.fields, isRecord(value) ? value : {}, false) }
				: node
		})
	}
	return prepare(fields, current, true)
}

function configLockReason(
	node: FieldNode,
	name: string,
	saved: unknown,
	root: boolean,
): string | undefined {
	if (
		!name ||
		name.length > 256 ||
		name.includes('\0') ||
		['__proto__', 'constructor', 'prototype'].includes(name) ||
		(root && fieldName([name]) === undefined)
	)
		return '此属性名无法通过配置编辑器安全写入。'

	const collection = node.kind === 'array' || node.kind === 'record'
	if (collection && hasUnsupportedField(node)) return '此字段包含无法编辑的子项，已保留原有值。'
	if ((collection || node.kind === 'union') && hasProtectedValue(node, saved))
		return '此字段包含受保护的保存值，无法整项替换。'
	return undefined
}

function own(input: ConfigInput, key: string): unknown {
	return Object.hasOwn(input, key) ? input[key] : undefined
}

function omitUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(omitUndefined)
	if (!isRecord(value)) return value
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.map(([key, child]) => [key, omitUndefined(child)]),
	)
}

function equalDraft(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((value, index) => equalDraft(value, b[index]))
	if (!isRecord(a) || !isRecord(b)) return false
	const keys = Object.keys(a)
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && equalDraft(a[key], b[key]))
	)
}

function write(root: Record<string, unknown>, path: readonly string[], value: unknown) {
	let cursor = root
	for (const key of path.slice(0, -1)) {
		const existing = own(cursor, key)
		const next = isRecord(existing) ? existing : {}
		cursor[key] = next
		cursor = next
	}
	cursor[path.at(-1)!] = value
}
