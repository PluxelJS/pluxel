import type { OxNode } from '../types.ts'

export function normalizeFilename(filename: string): string {
	return String(filename).replaceAll('\\', '/')
}

export function isNodeLike(value: unknown): value is OxNode {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		typeof (value as { type?: unknown }).type === 'string'
	)
}

export function getNodeField(node: OxNode, key: string): OxNode | null {
	return isNodeLike(node[key]) ? node[key] : null
}

export function getNodeArrayField(node: OxNode, key: string): OxNode[] {
	const value = node[key]
	return Array.isArray(value) ? value.filter(isNodeLike) : []
}

export function unwrapExpression(node: unknown): OxNode | null {
	let current = isNodeLike(node) ? node : null
	while (current) {
		if (current.type === 'ChainExpression') {
			current = isNodeLike(current.expression) ? current.expression : null
			continue
		}
		if (
			current.type === 'TSAsExpression' ||
			current.type === 'TSSatisfiesExpression' ||
			current.type === 'TSTypeAssertion' ||
			current.type === 'TSNonNullExpression' ||
			current.type === 'ParenthesizedExpression'
		) {
			current = isNodeLike(current.expression) ? current.expression : null
			continue
		}
		break
	}
	return current
}

export function getStaticPropertyName(node: unknown, computed = false): string | null {
	if (!isNodeLike(node)) return null
	if (!computed && node.type === 'Identifier' && typeof node.name === 'string') return node.name
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value
	if (
		computed &&
		node.type === 'TemplateLiteral' &&
		Array.isArray(node.expressions) &&
		node.expressions.length === 0 &&
		Array.isArray(node.quasis) &&
		node.quasis.length === 1
	) {
		const quasi = node.quasis[0] as { value?: { cooked?: unknown } }
		return typeof quasi.value?.cooked === 'string' ? quasi.value.cooked : null
	}
	return null
}

export function walkNode(
	node: unknown,
	visitorKeys: Readonly<Record<string, readonly string[]>>,
	visit: (node: OxNode) => void | false,
	options: { root?: OxNode | null; skipNestedExecution?: boolean } = {},
): void {
	if (!isNodeLike(node)) return
	if (visit(node) === false) return
	if (
		options.skipNestedExecution &&
		node !== options.root &&
		(node.type === 'FunctionDeclaration' ||
			node.type === 'FunctionExpression' ||
			node.type === 'ArrowFunctionExpression' ||
			node.type === 'ClassDeclaration' ||
			node.type === 'ClassExpression')
	) {
		return
	}
	const keys = visitorKeys[node.type] ?? []
	for (const key of keys) {
		const value = node[key]
		if (Array.isArray(value)) {
			for (const child of value) walkNode(child, visitorKeys, visit, options)
			continue
		}
		walkNode(value, visitorKeys, visit, options)
	}
}
