import type { FieldNode } from 'valibot-form'
import type { HostConfigSource } from '@pluxel/host'
export { adaptConfigPresentationFields } from '../../workbench/presentationAdapter'

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
				? `当前生效值来自环境变量 ${source.name ?? ''}`
				: source?.kind === 'file'
					? `当前生效值来自文件 ${source.name ?? ''}`
					: source?.kind === 'declaration'
						? '当前生效值来自应用声明'
						: undefined
		let effective: unknown = effectiveInput
		for (const segment of path) effective = isRecord(effective) ? effective[segment] : undefined
		const displayScalar =
			['string', 'number', 'boolean', 'picklist'].includes(field.kind) &&
			!(field.kind === 'string' && field.control === 'password')
		let output: unknown = config
		for (const segment of path) output = isRecord(output) ? output[segment] : undefined
		const inherited =
			displayScalar && effective !== undefined
				? `当前有效输入：${JSON.stringify(effective)}`
				: undefined
		const presented =
			displayScalar && effective === undefined && source === undefined
				? withDefaultPlaceholder(field, output)
				: field
		const target =
			displayScalar && output !== undefined && presented === field
				? `目标配置：${JSON.stringify(output)}`
				: undefined
		const hints = [origin, inherited, target].filter(Boolean).join('。')
		const description = field.meta.description?.trimEnd()
		const meta = hints
			? {
					...field.meta,
					description: description
						? `${description}${/[。．.！!？?…]$/u.test(description) ? '' : '。'}${hints}`
						: hints,
				}
			: field.meta
		return field.kind === 'object'
			? {
					...field,
					meta,
					fields: applyConfigSources(field.fields, sources, path, effectiveInput, config),
				}
			: { ...presented, meta }
	})
}

function withDefaultPlaceholder(field: FieldNode, value: unknown): FieldNode {
	if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return field
	if (field.kind === 'string' || field.kind === 'number') {
		return field.placeholder === undefined && typeof value === field.kind
			? { ...field, placeholder: String(value) }
			: field
	}
	if (field.kind !== 'picklist' || field.control !== 'select' || field.placeholder !== undefined) {
		return field
	}
	const option = field.entries?.find((entry) => entry.value === value)
	if (!option && !field.options?.includes(value)) return field
	const label = field.labels && Object.hasOwn(field.labels, value) ? field.labels[value] : undefined
	return { ...field, placeholder: option?.label ?? label ?? String(value) }
}

function contains(parent: readonly string[], child: readonly string[]): boolean {
	return parent.length <= child.length && parent.every((key, index) => key === child[index])
}
