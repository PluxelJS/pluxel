import {
	CANONICAL_ERROR_KEYS,
	ERROR_LIKE_IDENTIFIERS,
	ERROR_LOG_METHODS,
	LOG_METHODS,
} from '../shared/constants.ts'
import {
	getNodeArrayField,
	getNodeField,
	getStaticPropertyName,
	isNodeLike,
	unwrapExpression,
} from '../shared/ast.ts'
import { createRule, report } from '../shared/rule.ts'
import type { OxFixFn, OxNode, OxRule, OxSuggestion } from '../types.ts'

function isErrorLikeIdentifier(node: unknown): boolean {
	return isNodeLike(node) && node.type === 'Identifier' && typeof node.name === 'string'
		? ERROR_LIKE_IDENTIFIERS.has(node.name)
		: false
}

function isRawErrorLikeExpression(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression) return false
	if (isErrorLikeIdentifier(expression)) return true
	if (expression.type === 'MemberExpression') {
		const propertyName = getStaticPropertyName(expression.property, Boolean(expression.computed))
		return (
			isRawErrorLikeExpression(getNodeField(expression, 'object')) ||
			propertyName === 'error' ||
			propertyName === 'err'
		)
	}
	if (expression.type === 'NewExpression') {
		const callee = unwrapExpression(expression.callee)
		return callee?.type === 'Identifier' && typeof callee.name === 'string'
			? callee.name.endsWith('Error')
			: false
	}
	return false
}

function isRenderedErrorExpression(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression) return false
	if (isRawErrorLikeExpression(expression)) return true
	if (expression.type === 'CallExpression') {
		const callee = unwrapExpression(expression.callee)
		return (
			callee?.type === 'Identifier' &&
			callee.name === 'String' &&
			Array.isArray(expression.arguments) &&
			expression.arguments.some((argument) => isRenderedErrorExpression(argument))
		)
	}
	if (expression.type === 'MemberExpression') {
		const propertyName = getStaticPropertyName(expression.property, Boolean(expression.computed))
		return (
			(propertyName === 'message' || propertyName === 'stack') &&
			isRawErrorLikeExpression(getNodeField(expression, 'object'))
		)
	}
	if (expression.type === 'TemplateLiteral') {
		return Array.isArray(expression.expressions)
			? expression.expressions.some((part) => isRenderedErrorExpression(part))
			: false
	}
	if (expression.type === 'BinaryExpression' || expression.type === 'LogicalExpression') {
		return isRenderedErrorExpression(expression.left) || isRenderedErrorExpression(expression.right)
	}
	if (expression.type === 'ConditionalExpression') {
		return (
			isRenderedErrorExpression(expression.consequent) ||
			isRenderedErrorExpression(expression.alternate)
		)
	}
	return false
}

function isLikelyLoggerReceiver(node: unknown): boolean {
	const expression = unwrapExpression(node)
	if (!expression) return false
	if (expression.type === 'Identifier') {
		return typeof expression.name === 'string' && /(logger|log|dbg|debug)/iu.test(expression.name)
	}
	if (expression.type === 'MemberExpression') {
		const propertyName = getStaticPropertyName(expression.property, Boolean(expression.computed))
		return (
			(typeof propertyName === 'string' && /(logger|log|dbg|debug)/iu.test(propertyName)) ||
			isLikelyLoggerReceiver(getNodeField(expression, 'object'))
		)
	}
	if (expression.type === 'CallExpression') {
		const callee = unwrapExpression(expression.callee)
		if (callee?.type === 'Identifier' && typeof callee.name === 'string') {
			return /get(Debug)?Logger/iu.test(callee.name)
		}
		if (callee?.type === 'MemberExpression') {
			const propertyName = getStaticPropertyName(callee.property, Boolean(callee.computed))
			if (propertyName === 'with' || propertyName === 'getDebugChannel') {
				return isLikelyLoggerReceiver(getNodeField(callee, 'object'))
			}
		}
	}
	return false
}

function getLoggerMethodDescriptor(node: unknown): { method: string; receiver: OxNode } | null {
	const expression = unwrapExpression(node)
	if (!expression || expression.type !== 'MemberExpression') return null
	const method = getStaticPropertyName(expression.property, Boolean(expression.computed))
	if (!method || !LOG_METHODS.has(method)) return null
	const memberObject = getNodeField(expression, 'object')
	if (!isLikelyLoggerReceiver(memberObject)) return null
	const receiver = unwrapExpression(memberObject)
	return receiver ? { method, receiver } : null
}

function getErrorLoggerCall(node: unknown): {
	method: string
	args?: unknown[]
	taggedTemplate?: OxNode
	receiver: OxNode
} | null {
	const expression = unwrapExpression(node)
	if (!expression) return null
	if (expression.type === 'CallExpression') {
		const descriptor = getLoggerMethodDescriptor(expression.callee)
		if (descriptor && ERROR_LOG_METHODS.has(descriptor.method)) {
			return {
				method: descriptor.method,
				args: Array.isArray(expression.arguments) ? expression.arguments : [],
				receiver: descriptor.receiver,
			}
		}
	}
	if (expression.type === 'TaggedTemplateExpression') {
		const descriptor = getLoggerMethodDescriptor(expression.tag)
		if (descriptor && ERROR_LOG_METHODS.has(descriptor.method)) {
			return {
				method: descriptor.method,
				taggedTemplate: expression,
				receiver: descriptor.receiver,
			}
		}
	}
	return null
}

function extractReturnedObjectExpression(fn: unknown): OxNode | null {
	const expression = unwrapExpression(fn)
	if (!expression) return null
	if (expression.type === 'ArrowFunctionExpression') {
		if (isNodeLike(expression.body) && expression.body.type === 'ObjectExpression')
			return expression.body
		if (
			isNodeLike(expression.body) &&
			expression.body.type === 'BlockStatement' &&
			Array.isArray(expression.body.body)
		) {
			for (const statement of expression.body.body) {
				if (
					isNodeLike(statement) &&
					statement.type === 'ReturnStatement' &&
					isNodeLike(statement.argument) &&
					statement.argument.type === 'ObjectExpression'
				) {
					return statement.argument
				}
			}
		}
		return null
	}
	if (
		expression.type === 'FunctionExpression' &&
		isNodeLike(expression.body) &&
		Array.isArray(expression.body.body)
	) {
		for (const statement of expression.body.body) {
			if (
				isNodeLike(statement) &&
				statement.type === 'ReturnStatement' &&
				isNodeLike(statement.argument) &&
				statement.argument.type === 'ObjectExpression'
			) {
				return statement.argument
			}
		}
	}
	return null
}

function collectStructuredPropertyObjects(expr: unknown): OxNode[] {
	const expression = unwrapExpression(expr)
	if (!expression) return []
	if (expression.type === 'ObjectExpression') return [expression]
	const returnedObject = extractReturnedObjectExpression(expression)
	return returnedObject ? [returnedObject] : []
}

function collectWithPropertyObjects(receiver: OxNode): OxNode[] {
	const objects: OxNode[] = []
	let current = unwrapExpression(receiver)
	while (current?.type === 'CallExpression') {
		const callee = unwrapExpression(current.callee)
		if (!callee || callee.type !== 'MemberExpression') break
		if (getStaticPropertyName(callee.property, Boolean(callee.computed)) !== 'with') break
		const firstArg = Array.isArray(current.arguments) ? current.arguments[0] : undefined
		objects.push(...collectStructuredPropertyObjects(firstArg))
		current = unwrapExpression(callee.object)
	}
	return objects
}

function getPreferredCanonicalErrorKey(value: OxNode | null): 'error' | 'err' {
	return value?.type === 'Identifier' && value.name === 'err' ? 'err' : 'error'
}

function buildAliasSuggestions(property: OxNode, preferredKey: 'error' | 'err'): OxSuggestion[] {
	if (!isNodeLike(property.key) || property.computed) return []
	const propertyKey = getNodeField(property, 'key')
	if (!propertyKey) return []
	const currentKey = getStaticPropertyName(property.key, false)
	if (!currentKey || CANONICAL_ERROR_KEYS.has(currentKey)) return []
	return [
		{
			messageId: preferredKey === 'err' ? 'renameToErr' : 'renameToError',
			fix: (fixer) => fixer.replaceText(propertyKey, preferredKey),
		},
	]
}

function buildAliasFix(property: OxNode, preferredKey: 'error' | 'err'): OxFixFn | undefined {
	if (!isNodeLike(property.key) || property.computed) return undefined
	const propertyKey = getNodeField(property, 'key')
	if (!propertyKey) return undefined
	return (fixer) => fixer.replaceText(propertyKey, preferredKey)
}

const logNoRenderedError = createRule(
	{
		type: 'problem',
		docs: { description: 'Keep error objects out of rendered log messages' },
		messages: {
			placeholder:
				'Do not render `{error}` or `{err}` in the log message; pass the raw error via structured props.',
			rendered:
				'Do not interpolate or stringify errors in the log message; pass the raw error via structured props.',
		},
	},
	(context) => ({
		CallExpression(node) {
			const call = getErrorLoggerCall(node)
			if (!call?.args?.length) return
			const firstArg = unwrapExpression(call.args[0])
			if (!firstArg) return
			if (
				firstArg.type === 'Literal' &&
				typeof firstArg.value === 'string' &&
				/\{\s*(error|err)\s*\}/u.test(firstArg.value)
			) {
				report(context, firstArg, 'placeholder')
				return
			}
			if (
				firstArg.type === 'TemplateLiteral' &&
				Array.isArray(firstArg.expressions) &&
				firstArg.expressions.some((expression) => isRenderedErrorExpression(expression))
			) {
				report(context, firstArg, 'rendered')
				return
			}
			if (isRenderedErrorExpression(firstArg)) report(context, firstArg, 'rendered')
		},
		TaggedTemplateExpression(node) {
			const call = getErrorLoggerCall(node)
			const template = call?.taggedTemplate
			if (!template) return
			const quasi = template ? getNodeField(template, 'quasi') : null
			if (!quasi) return
			const expressions = getNodeArrayField(quasi, 'expressions')
			if (expressions.length === 0) return
			if (expressions.some((expression) => isRenderedErrorExpression(expression))) {
				report(context, template, 'rendered')
			}
		},
	}),
)

const logCanonicalErrorProp = createRule(
	{
		type: 'problem',
		docs: { description: 'Require canonical structured error fields in pluxel logger calls' },
		fixable: 'code',
		hasSuggestions: true,
		messages: {
			alias: 'Use `error` or `err` as the structured error field, not `{{key}}`.',
			duplicate: 'Use only one structured error field: `error` or `err`.',
			raw: 'Pass the raw error object under `{{key}}`; do not stringify it or read `.message`/`.stack` at the callsite.',
			renameToError: 'Rename this field to `error`.',
			renameToErr: 'Rename this field to `err`.',
		},
	},
	(context) => {
		function inspectObjectExpression(objectExpression: OxNode): void {
			const properties = Array.isArray(objectExpression.properties)
				? objectExpression.properties
				: []
			const canonicalProps: OxNode[] = []
			const aliasProps: Array<{ property: OxNode; value: OxNode }> = []
			for (const property of properties) {
				if (!isNodeLike(property) || property.type !== 'Property' || property.kind !== 'init')
					continue
				const key = getStaticPropertyName(property.key, Boolean(property.computed))
				if (!key) continue
				const value = unwrapExpression(property.value)
				if (CANONICAL_ERROR_KEYS.has(key)) {
					canonicalProps.push(property)
					if (value && isRenderedErrorExpression(value) && !isRawErrorLikeExpression(value)) {
						report(context, value, 'raw', { key })
					}
					continue
				}
				if (value && isRawErrorLikeExpression(value) && isNodeLike(property.key)) {
					aliasProps.push({ property, value })
				}
			}
			for (const { property, value } of aliasProps) {
				const preferredKey = getPreferredCanonicalErrorKey(value)
				const canFix = canonicalProps.length === 0
				const suggest = canFix ? buildAliasSuggestions(property, preferredKey) : undefined
				const fix = canFix ? buildAliasFix(property, preferredKey) : undefined
				const propertyKey = getNodeField(property, 'key')
				if (!propertyKey) continue
				report(
					context,
					propertyKey,
					'alias',
					{ key: getStaticPropertyName(property.key) ?? '' },
					{ fix, suggest },
				)
			}
			for (const duplicate of canonicalProps.slice(1)) {
				if (isNodeLike(duplicate.key)) report(context, duplicate.key, 'duplicate')
			}
		}

		function inspectLoggerCall(node: OxNode): void {
			const call = getErrorLoggerCall(node)
			if (!call) return
			const objects: OxNode[] = []
			if (call.args) {
				if (call.args.length === 1) objects.push(...collectStructuredPropertyObjects(call.args[0]))
				if (call.args.length >= 2) objects.push(...collectStructuredPropertyObjects(call.args[1]))
			}
			objects.push(...collectWithPropertyObjects(call.receiver))
			for (const objectExpression of objects) inspectObjectExpression(objectExpression)
		}

		return {
			CallExpression: inspectLoggerCall,
			TaggedTemplateExpression: inspectLoggerCall,
		}
	},
)

export const loggingRules: Record<string, OxRule> = {
	'log-no-rendered-error': logNoRenderedError,
	'log-canonical-error-prop': logCanonicalErrorProp,
}
