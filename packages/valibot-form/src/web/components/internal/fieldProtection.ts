import type { FieldNode, UnionBranch, UnionFieldNode } from '../../../core/fields'
import {
	branchField,
	isRecord,
	matchingUnionBranches,
	unionBranchLiteral,
} from '../../../core/fieldInput'

export function isProtectedField(node: FieldNode): boolean {
	return Boolean(
		node.kind === 'unsupported' || node.meta.hidden || node.meta.disabled || node.meta.readOnly,
	)
}

export function hasUnsupportedField(node: FieldNode): boolean {
	switch (node.kind) {
		case 'unsupported':
			return true
		case 'object':
			return node.fields.some(hasUnsupportedField)
		case 'array':
			return !node.item || hasUnsupportedField(node.item)
		case 'record':
			return !node.value || hasUnsupportedField(node.value)
		case 'union':
			return (
				node.sharedFields.some((field) => hasUnsupportedField(field.node)) ||
				node.branches.some(({ fields }) =>
					fields.some((field) => hasUnsupportedField(field.node)),
				) ||
				(node.discriminatorField !== undefined && hasUnsupportedField(node.discriminatorField.node))
			)
		default:
			return false
	}
}

function hasProtectedBranchValue(
	node: UnionFieldNode,
	branch: UnionBranch,
	value: unknown,
): boolean {
	const replacement = branch.fields.find((field) => field.replaceValue)
	if (replacement) {
		if (unionBranchLiteral(branch) === value) return false
		return hasProtectedValue(replacement.node, value)
	}
	return (
		isRecord(value) &&
		Object.entries(value).some(([key, item]) => {
			if (key === node.discriminator || item === undefined) return false
			const field = branchField(branch, node.sharedFields, key)
			return !field || hasProtectedValue(field, item)
		})
	)
}

export function hasProtectedValue(node: FieldNode, value: unknown): boolean {
	if (value === undefined) return false
	if (isProtectedField(node)) return true
	if (value === null && node.nullable) return false
	switch (node.kind) {
		case 'object':
			return (
				isRecord(value) &&
				Object.entries(value).some(([key, child]) => {
					const field = node.fields.find(({ name }) => name === key)
					return child !== undefined && (!field || hasProtectedValue(field, child))
				})
			)
		case 'array':
			return (
				Array.isArray(value) &&
				value.some((item) => !node.item || hasProtectedValue(node.item, item))
			)
		case 'record':
			return (
				isRecord(value) &&
				Object.values(value).some((item) => !node.value || hasProtectedValue(node.value, item))
			)
		case 'union': {
			const candidates = matchingUnionBranches(node, value)
			if (candidates.length === 0) return !(isRecord(value) && Object.keys(value).length === 0)
			return candidates.some((branch) => hasProtectedBranchValue(node, branch, value))
		}
		default:
			return false
	}
}
