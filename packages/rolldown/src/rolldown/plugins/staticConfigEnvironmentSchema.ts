import * as v from 'valibot'
import * as f from 'valibot-form'
import {
	type AstNode,
	parseStandaloneWithLang,
	readIdentifier,
	readLiteralString,
} from './pluginUtils.ts'

const FORM_META_FACTORIES = new Set([
	'formMeta',
	'stringMeta',
	'numberMeta',
	'picklistMeta',
	'arrayMeta',
	'recordMeta',
	'objectMeta',
	'unionMeta',
])

// Static restoration must stay closed as Valibot evolves. These are the Valibot 1.x schema,
// validation, transformation, and metadata factories that produce inert items. Execution,
// global mutation, diagnostic, and collection helper exports are deliberately absent.
const VALIBOT_ITEM_FACTORIES = new Set(
	`any args argsAsync array arrayAsync awaitAsync base64 bic bigint blob boolean brand bytes
	cache cacheAsync check checkAsync checkItems checkItemsAsync config creditCard cuid2 custom
	customAsync date decimal description digits domain email emoji empty endsWith entries enum enum_
	everyItem exactOptional exactOptionalAsync examples excludes fallback fallbackAsync file filterItems
	findItem finite flavor forward forwardAsync function function_ graphemes gtValue guard hash hexColor
	hexadecimal imei includes instance integer intersect intersectAsync ip ipv4 ipv6 isbn isoDate
	isoDateTime isoDateTimeSecond isoTime isoTimeSecond isoTimestamp isoWeek isrc jwsCompact keyof lazy
	lazyAsync length literal looseObject looseObjectAsync looseTuple looseTupleAsync ltValue mac mac48
	mac64 map mapAsync mapItems maxBytes maxEntries maxGraphemes maxLength maxSize maxValue maxWords
	message metadata mimeType minBytes minEntries minGraphemes minLength minSize minValue minWords
	multipleOf nan nanoid never nonEmpty nonNullable nonNullableAsync nonNullish nonNullishAsync
	nonOptional nonOptionalAsync normalize notBytes notEntries notGraphemes notLength notSize notValue
	notValues notWords null null_ nullable nullableAsync nullish nullishAsync number object objectAsync
	objectWithRest objectWithRestAsync octal omit optional optionalAsync parseBoolean parseJson partial
	partialAsync partialCheck partialCheckAsync pick picklist pipe pipeAsync promise rawCheck rawCheckAsync
	rawTransform rawTransformAsync readonly record recordAsync reduceItems regex required requiredAsync
	returns returnsAsync rfcEmail safeInteger set setAsync size slug someItem sortItems startsWith
	strictObject strictObjectAsync strictTuple strictTupleAsync string stringifyJson symbol title toBigint
	toBoolean toCamelCase toDate toKebabCase toLowerCase toMaxValue toMinValue toNumber toPascalCase
	toSnakeCase toString toUpperCase transform transformAsync trim trimEnd trimStart tuple tupleAsync
	tupleWithRest tupleWithRestAsync ulid undefined undefined_ undefinedable undefinedableAsync union
	unionAsync unknown unwrap url uuid value values variant variantAsync void void_ words`
		.trim()
		.split(/\s+/),
)

export function restoreStaticConfigSchema(
	source: string,
	options: Readonly<{
		id: string
		schemaName: string
		error(message: string): never
	}>,
): unknown {
	const { id, schemaName, error } = options
	const wrapped = `const __pluxel_schema__ = ${source};`
	const ast = parseStandaloneWithLang(wrapped, `${id}.config-environment.ts`)
	const statement = ast?.body[0] as unknown as AstNode | undefined
	const declaration = arrayOf(statement?.declarations)[0] as AstNode | undefined
	const expression = declaration?.init as AstNode | undefined
	if (!expression) {
		error(
			`[static-application] ${id} cannot statically restore schema ${schemaName}: invalid normalized schema source`,
		)
	}
	let schema: unknown
	try {
		schema = evaluateSchemaNode(expression, 0)
	} catch (cause) {
		error(
			`[static-application] ${id} cannot statically restore schema ${schemaName}: ${errorMessage(cause)}`,
		)
	}
	if (!isValibotItem(schema) || schema.kind !== 'schema') {
		error(
			`[static-application] ${id} cannot statically restore schema ${schemaName}: expression did not produce a Valibot schema`,
		)
	}
	return schema
}

function evaluateSchemaNode(node: AstNode, depth: number): unknown {
	if (depth > 128) throw new Error('schema expression exceeds the maximum static depth')
	if (
		node.type === 'TSAsExpression' ||
		node.type === 'TSSatisfiesExpression' ||
		node.type === 'TSTypeAssertion' ||
		node.type === 'TSInstantiationExpression' ||
		node.type === 'TSNonNullExpression' ||
		node.type === 'ParenthesizedExpression' ||
		node.type === 'ChainExpression'
	) {
		const expression = node.expression as AstNode | undefined
		if (!expression) throw new Error(`${String(node.type)} does not contain an expression`)
		return evaluateSchemaNode(expression, depth + 1)
	}
	if (node.type === 'Literal') {
		const regex = node.regex as { pattern?: unknown; flags?: unknown } | undefined
		if (regex && typeof regex.pattern === 'string' && typeof regex.flags === 'string') {
			return new RegExp(regex.pattern, regex.flags)
		}
		return node.value
	}
	if (node.type === 'Identifier') {
		const name = readIdentifier(node)
		if (name === 'undefined') return undefined
		if (name === 'Infinity') return Infinity
		if (name === 'NaN') return NaN
		throw new Error(`unresolved identifier ${String(name ?? '<unknown>')}`)
	}
	if (node.type === 'UnaryExpression') {
		const value = evaluateSchemaNode(node.argument as AstNode, depth + 1)
		if (node.operator === '+' && typeof value === 'number') return value
		if (node.operator === '-' && typeof value === 'number') return -value
		if (node.operator === '!' && typeof value === 'boolean') return !value
		throw new Error(`unsupported unary operator ${String(node.operator)}`)
	}
	if (node.type === 'ArrayExpression') {
		return arrayOf(node.elements).map((rawElement) => {
			const element = rawElement as AstNode | null
			if (!element || element.type === 'SpreadElement') {
				throw new Error('array holes and spreads are not statically restorable')
			}
			return evaluateSchemaNode(element, depth + 1)
		})
	}
	if (node.type === 'ObjectExpression') {
		const result: Record<string, unknown> = Object.create(null)
		const keys = new Set<string>()
		for (const rawProperty of arrayOf(node.properties)) {
			const property = rawProperty as AstNode
			if (property.type !== 'Property' || property.computed === true) {
				throw new Error('schema objects must use direct properties without spreads')
			}
			const key = directPropertyName(property.key)
			if (!key || key === '__proto__' || keys.has(key)) {
				throw new Error('schema objects must use unique direct data keys')
			}
			keys.add(key)
			result[key] = evaluateSchemaNode(property.value as AstNode, depth + 1)
		}
		return result
	}
	if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
		return (): undefined => undefined
	}
	if (node.type === 'TemplateLiteral') {
		if (arrayOf(node.expressions).length > 0) {
			throw new Error('template expressions are not statically restorable')
		}
		return arrayOf(node.quasis)
			.map((quasi) => {
				const value = (quasi as AstNode).value as { cooked?: unknown; raw?: unknown } | undefined
				return typeof value?.cooked === 'string'
					? value.cooked
					: typeof value?.raw === 'string'
						? value.raw
						: ''
			})
			.join('')
	}
	if (node.type === 'CallExpression') return evaluateFactoryCall(node, depth)
	throw new Error(`unsupported schema syntax ${String(node.type ?? '<unknown>')}`)
}

function evaluateFactoryCall(node: AstNode, depth: number): unknown {
	const callee = node.callee as AstNode | undefined
	if (callee?.type !== 'MemberExpression' || callee.computed === true) {
		throw new Error('only direct Valibot and valibot-form factory calls are allowed')
	}
	const namespace = readIdentifier(callee.object)
	const method = readIdentifier(callee.property)
	if (!namespace || !method)
		throw new Error('schema factory call must use a direct namespace member')
	if (namespace === 'v' && !VALIBOT_ITEM_FACTORIES.has(method)) {
		throw new Error(`Valibot method v.${method} is not an allowed inert schema factory`)
	}
	if (namespace === 'f' && !FORM_META_FACTORIES.has(method)) {
		throw new Error(`valibot-form method f.${method} is not a schema metadata factory`)
	}
	if (namespace !== 'v' && namespace !== 'f') {
		throw new Error(`unsupported schema factory namespace ${namespace}`)
	}
	const namespaceObject = namespace === 'v' ? v : f
	const factory = (namespaceObject as Record<string, unknown>)[method]
	if (typeof factory !== 'function')
		throw new Error(`unknown schema factory ${namespace}.${method}`)
	const args = arrayOf(node.arguments).map((rawArgument) => {
		const argument = rawArgument as AstNode
		if (argument.type === 'SpreadElement') {
			throw new Error('schema factory spread arguments are not statically restorable')
		}
		return evaluateSchemaNode(argument, depth + 1)
	})
	const value = Reflect.apply(factory, namespaceObject, args)
	if (!isValibotItem(value)) {
		throw new Error(`schema factory ${namespace}.${method} did not produce an inert schema item`)
	}
	return value
}

function directPropertyName(value: unknown): string | undefined {
	return readIdentifier(value) ?? readLiteralString(value)
}

function isValibotItem(value: unknown): value is { kind: string } {
	if (!value || typeof value !== 'object') return false
	const kind = (value as { kind?: unknown }).kind
	return (
		kind === 'schema' || kind === 'validation' || kind === 'transformation' || kind === 'metadata'
	)
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value)
}
