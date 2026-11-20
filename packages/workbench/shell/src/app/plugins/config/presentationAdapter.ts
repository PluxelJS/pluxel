import { makePathArray } from '@tanstack/react-form'
import type { FieldNode } from 'valibot-form'
import type { HostConfigMutation, HostConfigSource } from '@pluxel/host'
export { adaptConfigPresentationFields } from '../../workbench/presentationAdapter'

/** Diff editable raw inputs. Structural fields replace atomically; undefined restores inheritance. */
export function buildEditableConfigPatch(
	fields: readonly FieldNode[],
	candidate: Record<string, unknown>,
	current: Record<string, unknown>,
): HostConfigMutation {
	const set: Record<string, unknown> = {}
	const remove: string[][] = []
	const visit = (
		nodes: readonly FieldNode[],
		next: Record<string, unknown>,
		previous: Record<string, unknown>,
		parent: string[],
	) => {
		for (const node of nodes) {
			if (!node.name || !editable(node)) continue
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
		if (!node.name || !editable(node)) return []
		const path = [...parent, node.name]
		return node.kind === 'object' ? editableConfigPaths(node.fields, path) : [path]
	})
}
function editable(node: FieldNode): boolean {
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
/**
 * Patches are sent over capnweb, which only serializes plain objects (a null-prototype object is
 * rejected as "Cannot serialize value"), so records are plain and keys are defined, not assigned.
 */
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
/** Explain the effective source without making shadowed saved inputs uneditable. */
export function applyConfigSources(
	fields: readonly FieldNode[],
	sources: readonly HostConfigSource[],
	parent: readonly string[] = [],
	effectiveInput?: Readonly<Record<string, unknown>>,
	config?: Readonly<Record<string, unknown>>,
): FieldNode[] {
	return fields.map((field) => {
		const path = field.name ? [...parent, field.name] : parent
		const source = sources.find((item) => contains(item.path, path))
		const origin =
			source?.kind === 'env'
				? `来自环境变量 ${source.name ?? ''}`
				: source?.kind === 'file'
					? `来自文件 ${source.name ?? ''}`
					: source?.kind === 'declaration'
						? '来自应用声明'
						: undefined
		let effective: unknown = effectiveInput
		for (const segment of path) effective = isRecord(effective) ? effective[segment] : undefined
		const displayScalar =
			['string', 'number', 'boolean', 'picklist'].includes(field.kind) &&
			!(field.kind === 'string' && field.control === 'password')
		let output: unknown = config
		for (const segment of path) output = isRecord(output) ? output[segment] : undefined
		const effectiveText = effective === undefined ? undefined : JSON.stringify(effective)
		const outputText = output === undefined ? undefined : JSON.stringify(output)
		// The field already shows the saved input; only surface values it cannot show.
		const inherited =
			displayScalar && origin && effectiveText !== undefined ? `生效值 ${effectiveText}` : undefined
		const target =
			displayScalar && outputText !== undefined && outputText !== effectiveText
				? `解析为 ${outputText}`
				: undefined
		const description = [field.meta.description, origin, inherited, target]
			.filter(Boolean)
			.join('。')
		const meta = description ? { ...field.meta, description } : field.meta
		return field.kind === 'object'
			? {
					...field,
					meta,
					fields: applyConfigSources(field.fields, sources, path, effectiveInput, config),
				}
			: { ...field, meta }
	})
}
function contains(parent: readonly string[], child: readonly string[]): boolean {
	return parent.length <= child.length && parent.every((key, index) => key === child[index])
}
