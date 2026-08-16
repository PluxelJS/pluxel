import { ALLOWED_TOP_LEVEL_CLASS_WRAPPERS } from '../shared/constants.ts'
import {
	getNodeField,
	getStaticPropertyName,
	isNodeLike,
	unwrapExpression,
	walkNode,
} from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxNode, OxRule } from '../types.ts'

function isThisConfigsUseCall(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression || expression.type !== 'CallExpression') return false
	const callee = unwrapExpression(expression.callee)
	if (!callee || callee.type !== 'MemberExpression') return false
	if (getStaticPropertyName(callee.property, Boolean(callee.computed)) !== 'use') return false
	const target = unwrapExpression(callee.object)
	if (!target || target.type !== 'MemberExpression') return false
	const targetObject = getNodeField(target, 'object')
	return (
		targetObject?.type === 'ThisExpression' &&
		getStaticPropertyName(target.property, Boolean(target.computed)) === 'configs'
	)
}

function isThisFieldAccess(node: unknown, fieldNames: ReadonlySet<string>): string | null {
	const expression = unwrapExpression(node)
	if (!expression || expression.type !== 'MemberExpression') return null
	const targetObject = getNodeField(expression, 'object')
	if (targetObject?.type !== 'ThisExpression') return null
	const name = getStaticPropertyName(expression.property, Boolean(expression.computed))
	if (!name || !fieldNames.has(name)) return null
	return name
}

function collectConfigUseFields(classBody: OxNode): Map<string, OxNode> {
	const fields = new Map<string, OxNode>()
	const members = Array.isArray(classBody.body) ? classBody.body : []
	for (const member of members) {
		if (!isNodeLike(member) || member.type !== 'PropertyDefinition' || !member.value) continue
		if (!isThisConfigsUseCall(member.value)) continue
		const fieldName = getStaticPropertyName(member.key, Boolean(member.computed))
		if (fieldName) fields.set(fieldName, member)
	}
	return fields
}

function getPrivateFieldName(node: OxNode): string | null {
	if (!isNodeLike(node.key) || node.key.type !== 'PrivateIdentifier') return null
	return typeof node.key.name === 'string' ? node.key.name : null
}

const configsUseTopLevelClass = createRule(
	{
		type: 'problem',
		docs: {
			description: 'Require this.configs.use(...) class fields to stay at module top level',
		},
		messages: {
			topLevel:
				'`this.configs.use(...)` class fields must stay at module top level so the toolchain can extract metadata.',
		},
	},
	(context) => ({
		CallExpression(node) {
			if (!isThisConfigsUseCall(node)) return
			const ancestors = context.sourceCode.getAncestors(node)
			const classIndex = ancestors.findLastIndex(
				(ancestor) => ancestor.type === 'ClassDeclaration' || ancestor.type === 'ClassExpression',
			)
			if (classIndex === -1) return
			const wrappers = ancestors.slice(0, classIndex)
			if (!wrappers.every((ancestor) => ALLOWED_TOP_LEVEL_CLASS_WRAPPERS.has(ancestor.type))) {
				report(context, node, 'topLevel')
			}
		},
	}),
)

const configsUseNoPrivateField = createRule(
	{
		type: 'problem',
		docs: {
			description:
				'Disallow this.configs.use(...) on #private fields because runtime injection cannot assign them',
		},
		messages: {
			privateField:
				'`this.configs.use(...)` is not supported on `#{{field}}`; use a normal field so runtime injection can assign the normalized config value.',
		},
	},
	(context) => ({
		PropertyDefinition(node) {
			if (!node.value || !isThisConfigsUseCall(node.value)) return
			const field = getPrivateFieldName(node)
			if (!field) return
			report(context, node, 'privateField', { field })
		},
	}),
)

const configsUseNoEarlyRead = createRule(
	{
		type: 'problem',
		docs: { description: 'Prevent reading configs.use sentinels before runtime injection' },
		messages: {
			earlyRead:
				'`this.{{field}}` comes from `this.configs.use(...)`; do not read it in field initializers or constructors. Read it in `init()` or later methods.',
		},
	},
	(context) => ({
		ClassBody(node) {
			const fields = collectConfigUseFields(node)
			if (fields.size === 0) return
			const fieldNames = new Set(fields.keys())
			const visitorKeys = context.sourceCode.visitorKeys
			const members = Array.isArray(node.body) ? node.body : []

			for (const member of members) {
				if (!isNodeLike(member)) continue
				if (member.type === 'PropertyDefinition' && member.value) {
					const fieldValue = isNodeLike(member.value) ? member.value : null
					if (!fieldValue) continue
					const fieldName = getStaticPropertyName(member.key, Boolean(member.computed))
					if (fieldName && fields.get(fieldName) === member) continue
					walkNode(
						fieldValue,
						visitorKeys,
						(candidate) => {
							const accessedField = isThisFieldAccess(candidate, fieldNames)
							if (accessedField) report(context, candidate, 'earlyRead', { field: accessedField })
						},
						{ root: fieldValue, skipNestedExecution: true },
					)
					continue
				}
				if (
					member.type === 'MethodDefinition' &&
					member.kind === 'constructor' &&
					isNodeLike(member.value) &&
					isNodeLike(member.value.body)
				) {
					const constructorBody = member.value.body
					walkNode(
						constructorBody,
						visitorKeys,
						(candidate) => {
							const accessedField = isThisFieldAccess(candidate, fieldNames)
							if (accessedField) report(context, candidate, 'earlyRead', { field: accessedField })
						},
						{ root: constructorBody, skipNestedExecution: true },
					)
				}
			}
		},
	}),
)

const configsUseNoRedefault = createRule(
	{
		type: 'problem',
		docs: { description: 'Prevent re-defaulting configs.use outputs with ?? or ||' },
		fixable: 'code',
		messages: {
			redefault:
				'`this.{{field}}` already comes from schema-normalized config. Do not re-default it with `{{operator}}`.',
		},
	},
	(context) => ({
		ClassBody(node) {
			const fields = collectConfigUseFields(node)
			if (fields.size === 0) return
			const fieldNames = new Set(fields.keys())
			const visitorKeys = context.sourceCode.visitorKeys
			const members = Array.isArray(node.body) ? node.body : []

			for (const member of members) {
				if (!isNodeLike(member)) continue
				const root =
					member.type === 'PropertyDefinition'
						? unwrapExpression(member.value)
						: member.type === 'MethodDefinition'
							? isNodeLike(member.value)
								? unwrapExpression(member.value.body)
								: null
							: null
				if (!root) continue
				walkNode(
					root,
					visitorKeys,
					(candidate) => {
						const expression = unwrapExpression(candidate)
						if (
							expression?.type === 'LogicalExpression' &&
							(expression.operator === '??' || expression.operator === '||')
						) {
							const left = getNodeField(expression, 'left')
							const field = isThisFieldAccess(left, fieldNames)
							if (!field || !left) return
							report(
								context,
								expression,
								'redefault',
								{ field, operator: expression.operator },
								expression.operator === '??'
									? {
											fix: (fixer) =>
												fixer.replaceText(expression, context.sourceCode.getText(left)),
										}
									: undefined,
							)
						}
						if (
							expression?.type === 'AssignmentExpression' &&
							(expression.operator === '??=' || expression.operator === '||=')
						) {
							const left = getNodeField(expression, 'left')
							const field = isThisFieldAccess(left, fieldNames)
							if (!field || !left) return
							report(
								context,
								expression,
								'redefault',
								{ field, operator: expression.operator },
								expression.operator === '??='
									? {
											fix: (fixer) =>
												fixer.replaceText(expression, context.sourceCode.getText(left)),
										}
									: undefined,
							)
						}
					},
					{ root, skipNestedExecution: true },
				)
			}
		},
	}),
)

const configsUseSingleObjectSchema = createRule(
	{
		type: 'problem',
		docs: { description: 'Require at most one object config schema per Plugin' },
		messages: {
			multiple:
				'Each Plugin may declare at most one `this.configs.use(ObjectSchema)` field; nest related settings in one object schema.',
			nonObject: '`this.configs.use(...)` must receive an object schema.',
		},
	},
	(context) => ({
		ClassBody(node) {
			const fields = collectConfigUseFields(node)
			if (fields.size > 1) {
				for (const field of fields.values()) report(context, field, 'multiple')
			}
		},
		CallExpression(node) {
			if (!isThisConfigsUseCall(node)) return
			const args = Array.isArray(node.arguments) ? node.arguments : []
			const schema = unwrapExpression(args[0])
			if (!schema || schema.type !== 'CallExpression') return
			const callee = unwrapExpression(schema.callee)
			if (callee?.type !== 'MemberExpression') return
			const factory = getStaticPropertyName(callee.property, Boolean(callee.computed))
			if (factory && factory !== 'object' && factory !== 'objectAsync') {
				report(context, schema, 'nonObject')
			}
		},
	}),
)

const configsNoRemovedDsl = createRule(
	{
		type: 'problem',
		docs: { description: 'Reject removed @Config and cfg/layout authoring DSL' },
		messages: {
			removed:
				'`{{name}}` was removed. Declare one class field with `this.configs.use(ObjectSchema)`.',
		},
	},
	(context) => ({
		CallExpression(node) {
			const callee = unwrapExpression(node.callee)
			const name =
				callee?.type === 'Identifier'
					? typeof callee.name === 'string'
						? callee.name
						: null
					: callee?.type === 'MemberExpression'
						? getStaticPropertyName(callee.property, Boolean(callee.computed))
						: null
			if (name === 'Config' || (name === 'cfg' && callee?.type === 'Identifier')) {
				report(context, node, 'removed', { name })
			}
		},
	}),
)

export const configsRules: Record<string, OxRule> = {
	'configs-use-top-level-class': configsUseTopLevelClass,
	'configs-use-no-private-field': configsUseNoPrivateField,
	'configs-use-no-early-read': configsUseNoEarlyRead,
	'configs-use-no-redefault': configsUseNoRedefault,
	'configs-use-single-object-schema': configsUseSingleObjectSchema,
	'configs-no-removed-dsl': configsNoRemovedDsl,
}
