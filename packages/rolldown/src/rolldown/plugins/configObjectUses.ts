import type { ConfigSchemaModule, ConfigSourceExpression } from './configSourcePlugin.ts'
import { sourceMemberPath, unwrapStaticExpression, walkModuleScope } from './configSourceScope.ts'
import { type AstNode, readIdentifier } from './pluginUtils.ts'

type Keys = readonly (string | undefined)[]
type ObjectUse = {
	node: AstNode
	keys: Keys
	alias?: string
	callee?: AstNode
}

const usesByModule = new WeakMap<ConfigSchemaModule, Map<string, ObjectUse[]>>()

/** Index writes, captures and possible calls on module-level objects without executing a module. */
function objectUses(module: ConfigSchemaModule): Map<string, ObjectUse[]> {
	const cached = usesByModule.get(module)
	if (cached) return cached
	const uses = new Map<string, ObjectUse[]>()
	walkModuleScope(module.ast as unknown as AstNode, (node, shadowed) => {
		const record = (expression: unknown, detail: Pick<ObjectUse, 'alias' | 'callee'> = {}) => {
			if (!expression) return
			const value = unwrapStaticExpression(expression as AstNode)
			if (value.type === 'ConditionalExpression' || value.type === 'LogicalExpression') {
				record(value.type === 'ConditionalExpression' ? value.consequent : value.left, detail)
				record(value.type === 'ConditionalExpression' ? value.alternate : value.right, detail)
				return
			}
			if (value.type === 'SequenceExpression') {
				record((value.expressions as AstNode[]).at(-1), detail)
				return
			}
			const path = sourceMemberPath(value)
			if (!path || shadowed.has(path.name)) return
			if (!module.locals.has(path.name) && !module.imports.has(path.name)) return
			let list = uses.get(path.name)
			if (!list) uses.set(path.name, (list = []))
			list.push({ node, keys: path.keys, ...detail })
		}
		if (node.type === 'AssignmentExpression') {
			const target = (left: AstNode): void => {
				if (left.type === 'ObjectPattern')
					for (const property of left.properties as AstNode[])
						target(
							(property.type === 'RestElement' ? property.argument : property.value) as AstNode,
						)
				else if (left.type === 'ArrayPattern')
					for (const item of left.elements as (AstNode | null)[]) {
						if (item) target(item)
					}
				else if (left.type === 'RestElement' || left.type === 'AssignmentPattern')
					target((left.type === 'RestElement' ? left.argument : left.left) as AstNode)
				else record(left)
			}
			target(node.left as AstNode)
			record(node.right)
		} else if (
			node.type === 'UpdateExpression' ||
			(node.type === 'UnaryExpression' && node.operator === 'delete')
		) {
			record(node.argument)
		} else if (node.type === 'CallExpression' || node.type === 'NewExpression') {
			const callee = node.callee as AstNode
			if (callee.type === 'MemberExpression') record(callee.object)
			const owner = sourceMemberPath(callee)
			const known = node.type === 'CallExpression' && owner && !shadowed.has(owner.name)
			for (const arg of node.arguments as AstNode[])
				record(arg.type === 'SpreadElement' ? arg.argument : arg, known ? { callee } : {})
		} else if (node.type === 'VariableDeclarator') {
			const name = readIdentifier(node.id)
			const alias =
				name && module.declarations.get(name) === node.init && !module.mutableBindings.has(name)
			record(node.init, alias ? { alias: name } : {})
		} else if (node.type === 'Property') record(node.value)
		else if (node.type === 'ArrayExpression')
			for (const item of node.elements as (AstNode | null)[]) record(item)
		else if (node.type === 'ReturnStatement' || node.type === 'YieldExpression')
			record(node.argument)
		else if (node.type === 'ArrowFunctionExpression') record(node.body)
	})
	usesByModule.set(module, uses)
	return uses
}

/** Only writes that can reach the requested property or an ancestor invalidate its literal. */
export async function findObjectMutation(
	object: ConfigSourceExpression,
	key: string,
	isReadOnlyFactory: (ref: ConfigSourceExpression) => Promise<boolean>,
): Promise<ConfigSourceExpression | undefined> {
	for (const { module, name, keys } of object.objectBindings ?? []) {
		const uses = objectUses(module)
		const seen = new Set<string>()
		const find = async (binding: string, target: Keys): Promise<AstNode | undefined> => {
			const identity = JSON.stringify([binding, target])
			if (seen.has(identity)) return undefined
			seen.add(identity)
			for (const use of uses.get(binding) ?? []) {
				if (
					use.keys.some(
						(part, index) =>
							part !== undefined && target[index] !== undefined && part !== target[index],
					)
				)
					continue
				if (use.alias) {
					const write = await find(use.alias, target.slice(use.keys.length))
					if (write) return write
				} else if (!use.callee || !(await isReadOnlyFactory({ module, node: use.callee }))) {
					return use.node
				}
			}
			return undefined
		}
		const node = await find(name, [...keys, key])
		if (node) return { module, node }
	}
	return undefined
}
