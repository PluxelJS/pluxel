import type { FieldNode, UnionBranch, UnionFieldNode } from './fields'

export function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype: unknown = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

/** The projected input shape can identify a branch without executing schema checks. */
function matchesInput(node: FieldNode, value: unknown): boolean {
	if (value === null) return node.nullable || node.kind === 'unsupported'
	switch (node.kind) {
		case 'string':
		case 'number':
		case 'boolean':
			return typeof value === node.kind && (node.literal === undefined || value === node.literal)
		case 'picklist':
			return (
				(typeof value === 'number' || typeof value === 'string') &&
				(node.options === undefined || node.options.includes(value))
			)
		case 'object':
			return (
				isRecord(value) &&
				Object.entries(value).every(([key, item]) => {
					const child = node.fields.find((field) => field.name === key)
					return item === undefined || (child !== undefined && matchesInput(child, item))
				})
			)
		case 'array':
			return (
				Array.isArray(value) && value.every((item) => !node.item || matchesInput(node.item, item))
			)
		case 'record':
			return (
				isRecord(value) &&
				Object.values(value).every((item) => !node.value || matchesInput(node.value, item))
			)
		case 'union':
			return matchingUnionBranches(node, value).length > 0
		case 'unsupported':
			return true
	}
}

/** Candidates compatible with the present draft. Required keys can still be missing until submission. */
export function matchingUnionBranches(
	node: UnionFieldNode,
	value: unknown,
): readonly UnionBranch[] {
	if (value === undefined) return []
	const { discriminator, branches, sharedFields } = node
	if (discriminator !== undefined) {
		if (!isRecord(value) || !Object.hasOwn(value, discriminator)) return []
		return branches.filter((branch) => branch.discriminatorValue === value[discriminator])
	}
	return branches.filter((branch) => {
		const replacement = branch.fields.find((field) => field.replaceValue)
		if (replacement) return matchesInput(replacement.node, value)
		return (
			isRecord(value) &&
			Object.entries(value).every(([key, item]) => {
				const child = branchField(branch, sharedFields, key)
				return item === undefined || (child !== undefined && matchesInput(child, item))
			})
		)
	})
}

export function branchField(
	branch: UnionBranch,
	shared: UnionFieldNode['sharedFields'],
	key: string,
) {
	return (
		branch.fields.find((field) => field.key === key) ?? shared.find((field) => field.key === key)
	)?.node
}

/** Raw literal supplied by selecting a whole-value branch, including false and the empty string. */
export function unionBranchLiteral(branch: UnionBranch): string | number | boolean | undefined {
	const node = branch.fields.find((field) => field.replaceValue)?.node
	if (!node || node.meta.hidden || node.meta.disabled) return undefined
	return 'literal' in node ? node.literal : undefined
}
