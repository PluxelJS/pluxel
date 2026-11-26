import { type AstNode, readIdentifier, readLiteralString } from './pluginUtils.ts'

export function bindingNames(node: AstNode | undefined, names = new Set<string>()): Set<string> {
	if (!node) return names
	const name = readIdentifier(node)
	if (name) names.add(name)
	else if (node.type === 'AssignmentPattern') bindingNames(node.left as AstNode, names)
	else if (node.type === 'RestElement') bindingNames(node.argument as AstNode, names)
	else if (node.type === 'ArrayPattern')
		nodes(node.elements).forEach((item) => bindingNames(item as AstNode, names))
	else if (node.type === 'ObjectPattern')
		nodes(node.properties).forEach((raw) => {
			const property = raw as AstNode
			bindingNames(
				(property.type === 'RestElement' ? property.argument : property.value) as AstNode,
				names,
			)
		})
	return names
}

export function blockBindings(block: AstNode): Set<string> {
	const names = new Set<string>()
	for (const raw of nodes(block.body)) {
		const statement = raw as AstNode
		if (statement.type === 'VariableDeclaration')
			for (const declaration of nodes(statement.declarations))
				bindingNames((declaration as AstNode).id as AstNode, names)
		else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
			bindingNames(statement.id as AstNode, names)
	}
	return names
}

export function factoryBindings(factory: AstNode): Set<string> {
	const body = factory.body as AstNode | undefined
	const names = body ? blockBindings(body) : new Set<string>()
	bindingNames(factory.id as AstNode, names)
	nodes(factory.params).forEach((param) => bindingNames(param as AstNode, names))
	const visit = (node: AstNode): void => {
		if (isFunctionOrClass(node)) return
		// var belongs to the function even when declared inside a catch, loop or nested block.
		if (node.type === 'VariableDeclaration' && node.kind === 'var')
			for (const raw of nodes(node.declarations))
				bindingNames((raw as AstNode).id as AstNode, names)
		for (const child of astChildren(node)) visit(child)
	}
	if (body) visit(body)
	return names
}

export function isFunctionOrClass(node: AstNode): boolean {
	return [
		'ArrowFunctionExpression',
		'FunctionExpression',
		'FunctionDeclaration',
		'ClassExpression',
		'ClassDeclaration',
	].includes(String(node.type))
}

export function astChildren(node: AstNode): AstNode[] {
	return Object.values(node).flatMap((value) => {
		const values = Array.isArray(value) ? value : [value]
		return values.filter((item): item is AstNode =>
			Boolean(item && typeof item === 'object' && 'type' in item),
		)
	})
}

/** Visit value expressions with the names that shadow module-level bindings at that point. */
export function walkModuleScope(
	node: AstNode,
	visit: (node: AstNode, shadowed: ReadonlySet<string>) => void,
	shadowed: ReadonlySet<string> = new Set(),
): void {
	let locals: Set<string> | undefined
	if (isFunctionOrClass(node)) locals = factoryBindings(node)
	else if (node.type === 'BlockStatement' || node.type === 'StaticBlock')
		locals = blockBindings(node)
	else if (node.type === 'CatchClause') locals = bindingNames(node.param as AstNode)
	else if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(String(node.type))) {
		const declaration = (node.init ?? node.left) as AstNode | undefined
		if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var') {
			locals = new Set()
			for (const item of nodes(declaration.declarations))
				bindingNames((item as AstNode).id as AstNode, locals)
		}
	}
	const scope = locals?.size ? new Set([...shadowed, ...locals]) : shadowed
	visit(node, scope)
	for (const child of astChildren(node)) walkModuleScope(child, visit, scope)
}

export function unwrapStaticExpression(node: AstNode): AstNode {
	let current = node
	while (
		current.type === 'TSAsExpression' ||
		current.type === 'TSSatisfiesExpression' ||
		current.type === 'TSTypeAssertion' ||
		current.type === 'TSInstantiationExpression' ||
		current.type === 'TSNonNullExpression' ||
		current.type === 'ParenthesizedExpression' ||
		current.type === 'ChainExpression'
	) {
		const expression = current.expression as AstNode | undefined
		if (!expression) break
		current = expression
	}
	return current
}

/** A dynamic member can address any key at its position. */
export function sourceMemberPath(
	input: AstNode | undefined,
): { name: string; keys: (string | undefined)[] } | undefined {
	if (!input) return undefined
	let node = unwrapStaticExpression(input)
	const keys: (string | undefined)[] = []
	while (node.type === 'MemberExpression') {
		const key = node.property as AstNode
		keys.push(
			node.computed
				? (readLiteralString(key) ??
						(typeof key.value === 'number' ? String(key.value) : undefined))
				: readIdentifier(key),
		)
		node = unwrapStaticExpression(node.object as AstNode)
	}
	const name = readIdentifier(node)
	return name ? { name, keys: keys.toReversed() } : undefined
}

function nodes(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}
