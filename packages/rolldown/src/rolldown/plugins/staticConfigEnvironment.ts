import type { Program } from 'oxc-parser'
import * as v from 'valibot'
import * as f from 'valibot-form'
import { projectRawInput, type RawInputProjection } from 'valibot-form'
import {
	collectConfigSchemaModule,
	type ConfigSchemaSourceResolver,
	type ConfigSourceSymbol,
} from './configSourcePlugin.ts'
import {
	type AstNode,
	parseStandaloneWithLang,
	readIdentifier,
	readLiteralString,
} from './pluginUtils.ts'

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/
const RESERVED_ENVIRONMENT_PREFIX = 'PLUXEL_'
const STATIC_RUNTIME_PACKAGE = '@pluxel/runtime-static'
const FORM_META_FACTORIES = new Set([
	'formMeta',
	'stringMeta',
	'numberMeta',
	'booleanMeta',
	'picklistMeta',
	'arrayMeta',
	'recordMeta',
	'objectMeta',
	'unionMeta',
])
const VALIBOT_EXECUTION_METHODS = new Set([
	'assert',
	'getDefault',
	'getDefaults',
	'getDefaultsAsync',
	'is',
	'parse',
	'parseAsync',
	'parser',
	'parserAsync',
	'safeParse',
	'safeParseAsync',
	'safeParser',
	'safeParserAsync',
])

type MappingLeaf = Readonly<{
	environmentName: string
	path: readonly string[]
}>

type DirectBinding = Readonly<{
	pluginName: string
	pluginSymbol: ConfigSourceSymbol
	schemaName: string
	schemaNode: AstNode
	schemaSymbol: ConfigSourceSymbol
	leaves: readonly MappingLeaf[]
}>

export type StaticConfigEnvironmentTarget = Readonly<{
	environmentName: string
	pluginName: string
	schemaName: string
	path: readonly string[]
	projection: RawInputProjection
}>

export type StaticRuntimeDeclarationFacts = Readonly<{
	name?: string
	targets: readonly StaticConfigEnvironmentTarget[]
	environmentExample?: string
}>

export type StaticRuntimeDeclarationParserOptions = {
	ast: Program
	code: string
	id: string
	sourceResolver: ConfigSchemaSourceResolver
	error(message: string): never
}

/**
 * Parses the canonical static entry without importing or evaluating it.
 *
 * Both production and Vite call this exact parser. The only evaluated values are a
 * closed, inert subset of the normalized Valibot schema source produced by the existing
 * config source resolver; author callbacks are replaced with inert functions.
 */
export async function parseStaticRuntimeDeclaration(
	options: StaticRuntimeDeclarationParserOptions,
): Promise<StaticRuntimeDeclarationFacts> {
	const { ast, code, id, sourceResolver, error } = options
	const module = collectConfigSchemaModule(ast, code, id)

	const defaults = ast.body.filter((statement) => statement.type === 'ExportDefaultDeclaration')
	if (defaults.length !== 1) {
		error(`[static-application] ${id} must contain exactly one default export`)
	}
	const expression = (defaults[0] as unknown as AstNode).declaration as AstNode | undefined
	if (
		expression?.type !== 'CallExpression' ||
		readIdentifier(expression.callee) !== 'defineStaticRuntime'
	) {
		error(`[static-application] ${id} must default-export defineStaticRuntime(...) directly`)
	}
	const applicationArguments = directCallArguments(expression, 'defineStaticRuntime', id, error)
	if (applicationArguments.length !== 1) {
		error(`[static-application] ${id} defineStaticRuntime() requires exactly one argument`)
	}
	const application = applicationArguments[0]!
	if (application.type !== 'ObjectExpression') {
		return Object.freeze({ targets: Object.freeze([]) })
	}
	const directName = readDirectObjectField(application, 'name')
	const directBootstrap = readDirectObjectField(application, 'configEnvironmentBootstrap')
	const name = readLiteralString(directName)
	if (directBootstrap === undefined) {
		return Object.freeze({
			...(name === undefined ? {} : { name }),
			targets: Object.freeze([]),
		})
	}

	assertDirectImport(module.imports.get('defineStaticRuntime'), 'defineStaticRuntime', id, error)
	const fields = directObjectProperties(application, 'defineStaticRuntime() application', id, error)
	const bootstrap = fields.get('configEnvironmentBootstrap')?.value
	if (bootstrap === undefined) {
		error(`[static-application] ${id} cannot locate direct configEnvironmentBootstrap field`)
	}
	if (bootstrap.type !== 'ArrayExpression') {
		error(`[static-application] ${id} configEnvironmentBootstrap must be a direct array literal`)
	}

	assertDirectImport(
		module.imports.get('bindConfigEnvironment'),
		'bindConfigEnvironment',
		id,
		error,
	)
	const bindings: DirectBinding[] = []
	const boundPlugins = new Map<string, string>()
	for (const [index, rawElement] of arrayOf(bootstrap.elements).entries()) {
		const element = rawElement as AstNode | null
		if (!element || element.type === 'SpreadElement') {
			error(
				`[static-application] ${id} configEnvironmentBootstrap[${index}] must be a direct bindConfigEnvironment() call`,
			)
		}
		if (
			element.type !== 'CallExpression' ||
			readIdentifier(element.callee) !== 'bindConfigEnvironment'
		) {
			error(
				`[static-application] ${id} configEnvironmentBootstrap[${index}] must be a direct bindConfigEnvironment() call`,
			)
		}
		const args = directCallArguments(
			element,
			`configEnvironmentBootstrap[${index}] bindConfigEnvironment`,
			id,
			error,
		)
		if (args.length !== 3) {
			error(
				`[static-application] ${id} configEnvironmentBootstrap[${index}] bindConfigEnvironment() requires exactly three direct arguments`,
			)
		}
		const pluginName = readIdentifier(args[0])
		const schemaName = readIdentifier(args[1])
		if (!pluginName || !schemaName) {
			error(
				`[static-application] ${id} configEnvironmentBootstrap[${index}] Plugin and schema must be direct identifiers`,
			)
		}
		const pluginSymbol = await sourceResolver.resolveSymbol(module, args[0]!)
		if (!pluginSymbol) {
			error(
				`[static-application] ${id} cannot statically resolve config environment binding Plugin ${pluginName} to a direct local or imported binding`,
			)
		}
		const schemaSymbol = await sourceResolver.resolveSymbol(module, args[1]!)
		if (!schemaSymbol) {
			error(
				`[static-application] ${id} cannot statically resolve config environment binding schema ${schemaName} to a direct local or imported binding`,
			)
		}
		const pluginSymbolKey = sourceSymbolKey(pluginSymbol!)
		if (boundPlugins.has(pluginSymbolKey)) {
			error(
				`[static-application] ${id} has duplicate config environment bindings for Plugin ${pluginName}`,
			)
		}
		boundPlugins.set(pluginSymbolKey, pluginName)
		const leaves = parseDirectMapping(
			args[2],
			[],
			`configEnvironmentBootstrap[${index}] mapping`,
			id,
			error,
		)
		bindings.push(
			Object.freeze({
				pluginName,
				pluginSymbol: pluginSymbol!,
				schemaName,
				schemaNode: args[1]!,
				schemaSymbol: schemaSymbol!,
				leaves: Object.freeze(leaves),
			}),
		)
	}

	if (bindings.length === 0) {
		return Object.freeze({
			...(name === undefined ? {} : { name }),
			targets: Object.freeze([]),
		})
	}
	const plugins = fields.get('plugins')?.value
	if (!plugins) error(`[static-application] ${id} must declare plugins`)
	const catalogPlugins = await resolveStaticCatalogPluginSymbols(
		plugins!,
		module,
		sourceResolver,
		id,
		error,
	)
	for (const binding of bindings) {
		if (!catalogPlugins.has(sourceSymbolKey(binding.pluginSymbol))) {
			error(
				`[static-application] ${id} config environment binding Plugin ${binding.pluginName} is not present in the statically resolved plugins catalog`,
			)
		}
		const declaredSchema = await sourceResolver.resolvePluginConfigSchemaSymbol(
			binding.pluginSymbol,
		)
		if (!declaredSchema) {
			error(
				`[static-application] ${id} cannot statically resolve the root config schema declared by Plugin ${binding.pluginName}`,
			)
		}
		if (sourceSymbolKey(declaredSchema!) !== sourceSymbolKey(binding.schemaSymbol)) {
			error(
				`[static-application] ${id} config environment binding schema ${binding.schemaName} does not match the root config schema declared by Plugin ${binding.pluginName}`,
			)
		}
	}

	const schemaCache = new Map<string, unknown>()
	const targets: StaticConfigEnvironmentTarget[] = []
	for (const binding of bindings) {
		let schema = schemaCache.get(binding.schemaName)
		if (schema === undefined) {
			let source: string
			try {
				source = await sourceResolver.render(module, binding.schemaNode)
			} catch (cause) {
				error(
					`[static-application] ${id} cannot statically restore schema ${binding.schemaName}: ${errorMessage(cause)}`,
				)
			}
			schema = restoreSchemaSource(source!, id, binding.schemaName, error)
			schemaCache.set(binding.schemaName, schema)
		}
		for (const leaf of binding.leaves) {
			const projection = projectRawInput(schema as never, leaf.path)
			if (projection.ok === false) {
				error(
					`[static-application] ${id} cannot bind ${leaf.environmentName} to ${binding.pluginName} schema ${binding.schemaName} path ${formatPath(leaf.path)}: ${projection.reason}`,
				)
			}
			const projected = projection as RawInputProjection
			targets.push(
				Object.freeze({
					environmentName: leaf.environmentName,
					pluginName: binding.pluginName,
					schemaName: binding.schemaName,
					path: leaf.path,
					projection: projected,
				}),
			)
		}
	}

	assertCompatibleFanout(targets, id, error)
	const frozenTargets = Object.freeze([...targets])
	return Object.freeze({
		...(name === undefined ? {} : { name }),
		targets: frozenTargets,
		environmentExample: renderStaticConfigEnvironmentExample(frozenTargets),
	})
}

async function resolveStaticCatalogPluginSymbols(
	expression: AstNode,
	module: ReturnType<typeof collectConfigSchemaModule>,
	sourceResolver: ConfigSchemaSourceResolver,
	id: string,
	error: (message: string) => never,
): Promise<Set<string>> {
	const symbols = await sourceResolver.resolveArraySymbols(module, expression)
	if (!symbols) {
		error(
			`[static-application] ${id} plugins catalog must statically resolve to an array of direct Plugin identifiers when configEnvironmentBootstrap is used`,
		)
	}
	return new Set(symbols!.map(sourceSymbolKey))
}

export function renderStaticConfigEnvironmentExample(
	targets: readonly StaticConfigEnvironmentTarget[],
): string | undefined {
	if (targets.length === 0) return undefined
	const grouped = new Map<string, StaticConfigEnvironmentTarget[]>()
	for (const target of targets) {
		const group = grouped.get(target.environmentName)
		if (group) group.push(target)
		else grouped.set(target.environmentName, [target])
	}
	const lines = [
		'# Generated Pluxel static config bootstrap variables.',
		'# Existing persisted config remains authoritative.',
		'',
	]
	for (const environmentName of [...grouped.keys()].sort(compareUtf8)) {
		const group = grouped.get(environmentName)!
		const descriptions = new Set<string>()
		const inputs = new Set<string>()
		for (const target of group) {
			for (const description of target.projection.descriptions) descriptions.add(description)
			inputs.add(target.projection.inputDescription)
		}
		for (const description of [...descriptions].sort(compareUtf8)) {
			for (const line of commentLines(description)) lines.push(`# ${line}`)
		}
		for (const input of [...inputs].sort(compareUtf8)) lines.push(`# Input: ${input}`)
		lines.push(`# ${environmentName}=`, '')
	}
	return `${lines.slice(0, -1).join('\n')}\n`
}

function parseDirectMapping(
	node: AstNode | undefined,
	path: readonly string[],
	label: string,
	id: string,
	error: (message: string) => never,
): MappingLeaf[] {
	const environmentName = readLiteralString(node)
	if (environmentName !== undefined) {
		if (!ENVIRONMENT_NAME.test(environmentName)) {
			error(
				`[static-application] ${id} ${label} at ${formatPath(path)} environment name must match [A-Z_][A-Z0-9_]*`,
			)
		}
		if (environmentName.startsWith(RESERVED_ENVIRONMENT_PREFIX)) {
			error(
				`[static-application] ${id} ${label} environment name ${environmentName} is reserved for the Pluxel framework`,
			)
		}
		return [Object.freeze({ environmentName, path: Object.freeze([...path]) })]
	}
	if (node?.type !== 'ObjectExpression') {
		error(
			`[static-application] ${id} ${label} at ${formatPath(path)} must be a direct environment name string or object literal`,
		)
	}
	const properties = directObjectProperties(node, label, id, error)
	if (properties.size === 0) {
		error(
			`[static-application] ${id} ${label} at ${formatPath(path)} must contain at least one binding`,
		)
	}
	return [...properties].flatMap(([key, property]) =>
		parseDirectMapping(property.value, [...path, key], label, id, error),
	)
}

function directObjectProperties(
	node: AstNode,
	label: string,
	id: string,
	error: (message: string) => never,
): Map<string, AstNode & { value: AstNode }> {
	const properties = new Map<string, AstNode & { value: AstNode }>()
	for (const [index, rawProperty] of arrayOf(node.properties).entries()) {
		const property = rawProperty as AstNode
		if (property.type === 'SpreadElement') {
			error(`[static-application] ${id} ${label} does not allow spread properties`)
		}
		if (property.type !== 'Property' || property.computed === true) {
			error(`[static-application] ${id} ${label} property[${index}] must use a direct key`)
		}
		const key = directPropertyName(property.key)
		const value = property.value as AstNode | undefined
		if (!key || !value || key === '__proto__') {
			error(`[static-application] ${id} ${label} property[${index}] must use a direct data key`)
		}
		if (properties.has(key)) {
			error(`[static-application] ${id} ${label} contains duplicate key ${JSON.stringify(key)}`)
		}
		properties.set(key, property as AstNode & { value: AstNode })
	}
	return properties
}

function readDirectObjectField(node: AstNode, field: string): AstNode | undefined {
	for (const rawProperty of arrayOf(node.properties)) {
		const property = rawProperty as AstNode
		if (property.type !== 'Property') continue
		if (directPropertyName(property.key) !== field) continue
		return property.value as AstNode | undefined
	}
	return undefined
}

function directPropertyName(value: unknown): string | undefined {
	return readIdentifier(value) ?? readLiteralString(value)
}

function directCallArguments(
	call: AstNode,
	label: string,
	id: string,
	error: (message: string) => never,
): AstNode[] {
	const args = arrayOf(call.arguments).map((argument) => argument as AstNode)
	if (args.some((argument) => argument.type === 'SpreadElement')) {
		error(`[static-application] ${id} ${label} does not allow spread arguments`)
	}
	return args
}

function assertDirectImport(
	binding: { source: string; imported: string; namespace: boolean } | undefined,
	name: string,
	id: string,
	error: (message: string) => never,
): void {
	if (
		!binding ||
		binding.source !== STATIC_RUNTIME_PACKAGE ||
		binding.imported !== name ||
		binding.namespace
	) {
		error(`[static-application] ${id} must import ${name} directly from ${STATIC_RUNTIME_PACKAGE}`)
	}
}

function assertCompatibleFanout(
	targets: readonly StaticConfigEnvironmentTarget[],
	id: string,
	error: (message: string) => never,
): void {
	const transports = new Map<string, string>()
	for (const target of targets) {
		const previous = transports.get(target.environmentName)
		if (previous !== undefined && previous !== target.projection.transport) {
			error(
				`[static-application] ${id} config environment ${target.environmentName} has conflicting derived transports ${previous} and ${target.projection.transport}`,
			)
		}
		transports.set(target.environmentName, target.projection.transport)
	}
}

function restoreSchemaSource(
	source: string,
	id: string,
	schemaName: string,
	error: (message: string) => never,
): unknown {
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
	if (node.type === 'CallExpression') {
		const callee = node.callee as AstNode | undefined
		if (callee?.type !== 'MemberExpression' || callee.computed === true) {
			throw new Error('only direct Valibot and valibot-form factory calls are allowed')
		}
		const namespace = readIdentifier(callee.object)
		const method = readIdentifier(callee.property)
		if (!namespace || !method) {
			throw new Error('schema factory call must use a direct namespace member')
		}
		if (namespace === 'v' && VALIBOT_EXECUTION_METHODS.has(method)) {
			throw new Error(`Valibot execution method v.${method} is not allowed in static schema source`)
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
	throw new Error(`unsupported schema syntax ${String(node.type ?? '<unknown>')}`)
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

function commentLines(value: string): string[] {
	return value.replaceAll(/\r\n?/g, '\n').split('\n')
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function formatPath(path: readonly string[]): string {
	return path.length === 0 ? '<root>' : path.join('.')
}

function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value)
}

function sourceSymbolKey(symbol: ConfigSourceSymbol): string {
	return `${symbol.moduleId}\0${symbol.local}`
}
