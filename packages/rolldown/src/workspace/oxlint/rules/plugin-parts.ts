import { ALLOWED_TOP_LEVEL_CLASS_WRAPPERS } from '../shared/constants.ts'
import { getNodeField, getStaticPropertyName, isNodeLike, unwrapExpression } from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxNode, OxRule } from '../types.ts'

function decoratorName(node: unknown): string | null {
	if (!isNodeLike(node)) return null
	const expression = unwrapExpression(node.expression)
	const callee =
		expression?.type === 'CallExpression' ? unwrapExpression(expression.callee) : expression
	if (callee?.type === 'Identifier' && typeof callee.name === 'string') return callee.name
	return callee?.type === 'MemberExpression'
		? getStaticPropertyName(callee.property, Boolean(callee.computed))
		: null
}

function isPluginOwner(node: OxNode): boolean {
	return (
		Array.isArray(node.decorators) &&
		node.decorators.some((decorator) => decoratorName(decorator) === 'Plugin')
	)
}

function isPluginPartClass(node: OxNode): boolean {
	const base = unwrapExpression(node.superClass)
	if (base?.type === 'Identifier') return base.name === 'PluginPart'
	return (
		base?.type === 'MemberExpression' &&
		getStaticPropertyName(base.property, Boolean(base.computed)) === 'PluginPart'
	)
}

function isPartsUse(node: OxNode): boolean {
	const callee = unwrapExpression(node.callee)
	if (callee?.type !== 'MemberExpression') return false
	if (getStaticPropertyName(callee.property, Boolean(callee.computed)) !== 'use') return false
	const parts = unwrapExpression(callee.object)
	if (parts?.type !== 'MemberExpression') return false
	return (
		getNodeField(parts, 'object')?.type === 'ThisExpression' &&
		getStaticPropertyName(parts.property, Boolean(parts.computed)) === 'parts'
	)
}

const pluginPartStaticOccurrences = createRule(
	{
		type: 'problem',
		docs: { description: 'Require PluginPart occurrences to be statically lowerable class fields' },
		messages: {
			field:
				'`this.parts.use(...)` must be the complete initializer of a normal, non-static class field.',
			owner: '`this.parts.use(...)` is only available in a concrete @Plugin or PluginPart class.',
			argument: '`this.parts.use(...)` requires exactly one PluginPart value identifier.',
			topLevel: 'PluginPart owner classes must stay at module top level for semantic lowering.',
		},
	},
	(context) => ({
		CallExpression(node) {
			if (!isPartsUse(node)) return
			const ancestors = context.sourceCode.getAncestors(node)
			const classIndex = ancestors.findLastIndex(
				(ancestor) => ancestor.type === 'ClassDeclaration' || ancestor.type === 'ClassExpression',
			)
			const owner = classIndex === -1 ? undefined : ancestors[classIndex]
			if (!owner || (!isPluginOwner(owner) && !isPluginPartClass(owner))) {
				report(context, node, 'owner')
			}
			if (
				classIndex !== -1 &&
				!ancestors
					.slice(0, classIndex)
					.every((ancestor) => ALLOWED_TOP_LEVEL_CLASS_WRAPPERS.has(ancestor.type))
			) {
				report(context, owner ?? node, 'topLevel')
			}
			const field = ancestors.at(-1)
			if (
				field?.type !== 'PropertyDefinition' ||
				field.value !== node ||
				field.static === true ||
				field.computed === true ||
				(isNodeLike(field.key) && field.key.type === 'PrivateIdentifier') ||
				!getStaticPropertyName(field.key, false)
			) {
				report(context, node, 'field')
			}
			const args = Array.isArray(node.arguments) ? node.arguments : []
			if (args.length !== 1 || !isNodeLike(args[0]) || args[0].type !== 'Identifier') {
				report(context, node, 'argument')
			}
		},
	}),
)

const pluginPartClassContract = createRule(
	{
		type: 'problem',
		docs: { description: 'Keep PluginPart classes out of Plugin graph and constructor DI' },
		messages: {
			abstract: 'PluginPart must be concrete; composition does not support Part inheritance.',
			constructor: 'PluginPart must not declare a constructor; use class fields or init().',
			marked: 'PluginPart must not use @Plugin; it is owned by a Plugin and has no graph identity.',
		},
	},
	(context) => ({
		ClassDeclaration(node) {
			if (!isPluginPartClass(node)) return
			if (node.abstract === true) report(context, node, 'abstract')
			if (isPluginOwner(node)) report(context, node, 'marked')
			const body = getNodeField(node, 'body')
			for (const member of body && Array.isArray(body.body) ? body.body : []) {
				if (
					isNodeLike(member) &&
					member.type === 'MethodDefinition' &&
					member.kind === 'constructor'
				) {
					report(context, member, 'constructor')
				}
			}
		},
	}),
)

export const pluginPartsRules: Record<string, OxRule> = {
	'plugin-part-static-occurrences': pluginPartStaticOccurrences,
	'plugin-part-class-contract': pluginPartClassContract,
}
