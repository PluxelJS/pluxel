import type { Program } from 'oxc-parser'
import { projectRawInput, type RawInputProjection } from 'valibot-form'
import {
	collectConfigSchemaModule,
	type ConfigSchemaSourceResolver,
	type ConfigSourceSymbol,
} from './configSourcePlugin.ts'
import { type AstNode, readIdentifier, readLiteralString } from './pluginUtils.ts'
import {
	renderStaticConfigEnvironmentExample,
	type StaticConfigEnvironmentTarget,
} from './staticConfigEnvironmentExample.ts'
import { restoreStaticConfigSchema } from './staticConfigEnvironmentSchema.ts'

type DeclarationError = (
	message: string,
	detail?: { code: 'invalid_declaration' | 'unsupported_expression'; node?: AstNode },
) => never

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/

export type MappingLeaf = Readonly<{
	environmentName: string
	node: AstNode
	path: readonly string[]
}>

export type { StaticConfigEnvironmentTarget } from './staticConfigEnvironmentExample.ts'
export { renderStaticConfigEnvironmentExample } from './staticConfigEnvironmentExample.ts'

export type StaticRuntimeDeclarationFacts = Readonly<{
	hasSources: boolean
	name?: string
	targets: readonly StaticConfigEnvironmentTarget[]
	environmentExample?: string
}>

export type StaticRuntimeDeclarationParserOptions = {
	ast: Program
	/** Production requires the immutable static catalog declaration contract. */
	requireStaticPlugins?: boolean
	code: string
	id: string
	sourceResolver: ConfigSchemaSourceResolver
	error: DeclarationError
}

/**
 * Parses the canonical static entry without importing or evaluating it.
 *
 * Both production and Vite call this exact parser. The only evaluated values are a
 * closed, inert subset of the resolved Valibot schema source produced by the existing config
 * source resolver; author callbacks are replaced with inert functions.
 */
export async function parseStaticRuntimeDeclaration(
	options: StaticRuntimeDeclarationParserOptions,
): Promise<StaticRuntimeDeclarationFacts> {
	const { ast, code, id, sourceResolver, error } = options
	const { module, factory, application, fields } = readApplicationDeclaration({
		ast,
		code,
		id,
		error,
	})
	if (options.requireStaticPlugins) {
		const plugins = fields.get('plugins')?.value
		if (!plugins) error(`[static-application] ${id} must declare plugins`)
		await resolveStaticCatalogPluginSymbols(plugins, module, sourceResolver, id, error)
		assertCatalogNotMutated(factory, plugins, id, error)
	}
	const directSources = readDirectObjectField(application, 'sources')
	const hasSources =
		(directSources !== undefined &&
			!(
				directSources.type === 'ArrayExpression' && arrayOf(directSources.elements).length === 0
			)) ||
		arrayOf(application.properties).some(
			(property) => (property as AstNode).type === 'SpreadElement',
		)
	const directName = readDirectObjectField(application, 'name')
	const directBindings = fields.get('envBindings')?.value
	const name = readLiteralString(directName)
	if (directBindings === undefined)
		return Object.freeze({
			...(name === undefined ? {} : { name }),
			hasSources,
			targets: Object.freeze([]),
		})
	if (directBindings.type !== 'ArrayExpression')
		error(`[static-application] ${id} envBindings must be a direct array literal`)
	const plugins = fields.get('plugins')?.value
	if (!plugins) error(`[static-application] ${id} must declare plugins`)
	const catalogPlugins = await resolveStaticCatalogPluginSymbols(
		plugins,
		module,
		sourceResolver,
		id,
		error,
	)
	const targets: StaticConfigEnvironmentTarget[] = []
	const seenTargets = new Set<string>()
	for (const [index, raw] of arrayOf(directBindings.elements).entries()) {
		const binding = raw ? unwrapExpression(raw as AstNode) : undefined
		const { bindingFields, pluginNode, pluginName } = readApplicationBinding(
			binding,
			'env',
			index,
			module,
			id,
			error,
		)
		const pluginSymbol = await sourceResolver.resolveSymbol(module, pluginNode)
		if (!pluginSymbol || !catalogPlugins.has(sourceSymbolKey(pluginSymbol)))
			error(
				`[static-application] ${id} environment binding Plugin ${pluginName} is not present in the statically resolved plugins catalog`,
			)
		const namespace = readBindingNamespace(bindingFields, 'env', index, id, error)
		for (const kind of ['config', 'vault'] as const) {
			const descriptor = bindingFields.get(kind)?.value
			if (!descriptor) continue
			const { schemaExpression, source: mapping } = readBindingDescriptor(
				descriptor,
				'env',
				kind,
				id,
				error,
			)
			if (kind === 'vault' && mapping.type !== 'ObjectExpression')
				error(`[static-application] ${id} vault mapping must declare record keys directly`)
			const leaves = parseDirectMapping(
				mapping,
				[],
				`envBindings[${index}].${kind}.mapping`,
				id,
				error,
			)
			const schemaName = readIdentifier(schemaExpression) ?? `${pluginName}.${kind}`
			const schemaSource = await sourceResolver.renderResolved(module, schemaExpression)
			const schema = restoreStaticConfigSchema(schemaSource, { id, schemaName, error })
			const targetKeys =
				kind === 'config' ? [''] : [...new Set(leaves.map((leaf) => leaf.path[0]!))]
			for (const targetKey of targetKeys) {
				const identity = JSON.stringify([
					sourceSymbolKey(pluginSymbol!),
					kind,
					kind === 'vault' ? (namespace ?? '') : '',
					targetKey,
				])
				registerBindingTarget(seenTargets, identity, pluginName, id, error)
			}
			for (const leaf of leaves) {
				const inputSchema =
					kind === 'vault' ? staticVaultRecordSchema(schema, leaf.path[0]!, id, error) : schema
				const projection = projectRawInput(
					inputSchema as never,
					kind === 'vault' ? leaf.path.slice(1) : leaf.path,
				)
				if (projection.ok === false)
					error(
						`[static-application] ${id} cannot bind ${leaf.environmentName} to ${pluginName} schema ${schemaName} path ${formatPath(leaf.path)}: ${projection.reason}`,
					)
				targets.push(
					Object.freeze({
						environmentName: leaf.environmentName,
						pluginName,
						schemaName,
						kind,
						...(namespace ? { namespace } : {}),
						path: leaf.path,
						projection: projection as RawInputProjection,
					}),
				)
			}
		}
	}

	assertCompatibleFanout(targets, id, error)
	const frozenTargets = Object.freeze([...targets])
	return Object.freeze({
		...(name === undefined ? {} : { name }),
		hasSources,
		targets: frozenTargets,
		environmentExample: renderStaticConfigEnvironmentExample(frozenTargets),
	})
}

/** Both consumers reject duplicate targets before publishing an unqualified binding. */
export function registerBindingTarget(
	seen: Set<string>,
	identity: string,
	pluginName: string,
	id: string,
	error: DeclarationError,
): void {
	if (seen.has(identity))
		error(`[static-application] ${id} duplicate environment target for Plugin ${pluginName}`, {
			code: 'invalid_declaration',
		})
	seen.add(identity)
}

export function readBindingNamespace(
	bindingFields: Map<string, AstNode & { value: AstNode }>,
	transport: 'env' | 'file',
	index: number,
	id: string,
	error: DeclarationError,
) {
	const namespaceNode = bindingFields.get('namespace')?.value
	const namespace = namespaceNode ? readLiteralString(namespaceNode) : undefined
	if (
		namespaceNode &&
		(namespace === undefined || namespace.length === 0 || namespace.includes('\0'))
	)
		error(
			`[static-application] ${id} ${transport}Bindings namespace must be a nonempty literal string`,
			{
				code: namespace === undefined ? 'unsupported_expression' : 'invalid_declaration',
				node: namespaceNode,
			},
		)
	if (!bindingFields.has('config') && !bindingFields.has('vault'))
		error(`[static-application] ${id} ${transport}Bindings[${index}] must select config or vault`, {
			code: 'invalid_declaration',
		})
	return namespace
}

export function readBindingDescriptor(
	node: AstNode,
	transport: 'env' | 'file',
	kind: 'config' | 'vault',
	id: string,
	error: DeclarationError,
) {
	const sourceKey = transport === 'env' ? 'mapping' : kind === 'config' ? 'path' : 'paths'
	if (node.type !== 'ObjectExpression')
		error(
			`[static-application] ${id} ${kind} binding must declare schema and ${sourceKey} in a direct object literal`,
			{ code: 'unsupported_expression', node },
		)
	const fields = directObjectProperties(node, `${kind} binding`, id, error)
	for (const key of fields.keys())
		if (!['schema', sourceKey].includes(key))
			error(`[static-application] ${id} unknown ${kind} binding field ${key}`, {
				code: 'invalid_declaration',
				node: fields.get(key),
			})
	const schemaExpression = fields.get('schema')?.value
	const source = fields.get(sourceKey)?.value
	if (!schemaExpression || !source)
		error(`[static-application] ${id} ${kind} binding requires schema and ${sourceKey}`, {
			code: 'invalid_declaration',
			node,
		})
	return { schemaExpression, source }
}

/** Shared direct binding helper contract, also used by source navigation. */
export function readApplicationBinding(
	binding: AstNode | undefined,
	kind: 'env' | 'file',
	index: number,
	module: ReturnType<typeof collectConfigSchemaModule>,
	id: string,
	error: DeclarationError,
) {
	const helper = `${kind}Binding`
	const label = `${kind}Bindings[${index}]`
	const helperName = binding?.type === 'CallExpression' ? readIdentifier(binding.callee) : undefined
	const helperImport = helperName ? module.imports.get(helperName) : undefined
	if (
		!binding ||
		!helperImport ||
		helperImport.source !== '@pluxel/host' ||
		helperImport.imported !== helper ||
		helperImport.namespace
	)
		error(
			`[static-application] ${id} ${label} must call ${helper} imported from @pluxel/host directly`,
		)
	const args = directCallArguments(binding, helper, id, error)
	if (args.length !== 2 || args[1]?.type !== 'ObjectExpression')
		error(`[static-application] ${id} ${helper} requires a Plugin and a direct object literal`)
	const bindingFields = directObjectProperties(args[1], label, id, error)
	for (const key of bindingFields.keys())
		if (!['config', 'vault', 'namespace'].includes(key))
			error(`[static-application] ${id} unknown ${kind}Bindings field ${key}`, {
				code: 'invalid_declaration',
				node: bindingFields.get(key),
			})
	const pluginNode = args[0]
	const pluginName = readIdentifier(pluginNode)
	if (!pluginNode || !pluginName)
		error(`[static-application] ${id} ${label} plugin must be a direct identifier`, {
			code: 'unsupported_expression',
			node: pluginNode,
		})
	return { bindingFields, pluginNode, pluginName }
}

/** Shared source-only application shape; neither consumer executes the factory. */
export function readApplicationDeclaration(options: {
	ast: Program
	code: string
	id: string
	error: DeclarationError
}) {
	const { ast, code, id, error } = options
	let module = collectConfigSchemaModule(ast, code, id)

	const defaults = ast.body.filter((statement) => statement.type === 'ExportDefaultDeclaration')
	if (defaults.length !== 1) {
		error(`[static-application] ${id} must contain exactly one default export`)
	}
	const declaration = unwrapExpression((defaults[0] as unknown as AstNode).declaration as AstNode)
	const callee =
		declaration.type === 'CallExpression' ? readIdentifier(declaration.callee) : undefined
	const configBinding = callee ? module.imports.get(callee) : undefined
	if (
		!configBinding ||
		configBinding.source !== '@pluxel/host' ||
		configBinding.imported !== 'defineHostApplication' ||
		configBinding.namespace
	) {
		error(
			`[application] ${id} must default-export defineHostApplication(factory) imported from @pluxel/host`,
		)
	}
	const factoryArguments = directCallArguments(declaration, 'defineHostApplication', id, error)
	const factory = factoryArguments[0] && unwrapExpression(factoryArguments[0])
	if (
		factoryArguments.length !== 1 ||
		!factory ||
		!['ArrowFunctionExpression', 'FunctionExpression'].includes(String(factory.type))
	) {
		error(`[application] ${id} defineHostApplication requires one inline factory`)
	}
	// Factory bindings must never accidentally resolve to a same-named module import.
	const shadowed = factoryBindings(factory)
	module = {
		...module,
		imports: new Map([...module.imports].filter(([name]) => !shadowed.has(name))),
		declarations: new Map([...module.declarations].filter(([name]) => !shadowed.has(name))),
		classes: new Map([...module.classes].filter(([name]) => !shadowed.has(name))),
		locals: new Set([...module.locals].filter((name) => !shadowed.has(name))),
	}
	let application = unwrapExpression(factory.body as AstNode)
	if (application.type === 'BlockStatement') {
		const statements = arrayOf(application.body) as AstNode[]
		const returns = collectFactoryReturns(application)
		const last = statements.at(-1)
		if (
			returns.length !== 1 ||
			last?.type !== 'ReturnStatement' ||
			returns[0] !== last ||
			!last.argument
		) {
			error(
				`[application] ${id} factory must have one unconditional final return of an application object`,
			)
		}
		application = unwrapExpression(last.argument as AstNode)
	}
	if (application.type !== 'ObjectExpression') {
		error(`[application] ${id} factory must return an application object directly`)
	}
	const fields = directObjectProperties(application, 'application', id, error)

	return { module, factory, application, fields }
}

function staticVaultRecordSchema(
	value: unknown,
	key: string,
	id: string,
	error: DeclarationError,
): unknown {
	let current = value as Record<string, unknown>
	const seen = new Set<unknown>()
	while (current && !seen.has(current)) {
		seen.add(current)
		if (Array.isArray(current.pipe) && current.pipe[0] !== current) {
			current = current.pipe[0] as Record<string, unknown>
			continue
		}
		if (current.wrapped) {
			current = current.wrapped as Record<string, unknown>
			continue
		}
		break
	}
	const schema =
		current.type === 'record'
			? current.value
			: (current.entries as Record<string, unknown> | undefined)?.[key]
	if (!schema)
		error(
			`[static-application] ${id} Vault binding key ${key} is not declared by the Vault binding schema`,
		)
	return schema
}

function bindingNames(node: AstNode | undefined, names = new Set<string>()): Set<string> {
	if (!node) return names
	const name = readIdentifier(node)
	if (name) names.add(name)
	else if (node.type === 'AssignmentPattern') bindingNames(node.left as AstNode, names)
	else if (node.type === 'RestElement') bindingNames(node.argument as AstNode, names)
	else if (node.type === 'ArrayPattern')
		arrayOf(node.elements).forEach((item) => bindingNames(item as AstNode, names))
	else if (node.type === 'ObjectPattern')
		arrayOf(node.properties).forEach((raw) => {
			const property = raw as AstNode
			bindingNames(
				(property.type === 'RestElement' ? property.argument : property.value) as AstNode,
				names,
			)
		})
	return names
}

function blockBindings(block: AstNode): Set<string> {
	const names = new Set<string>()
	for (const raw of arrayOf(block.body)) {
		const statement = raw as AstNode
		if (statement.type === 'VariableDeclaration')
			for (const declaration of arrayOf(statement.declarations))
				bindingNames((declaration as AstNode).id as AstNode, names)
		else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
			bindingNames(statement.id as AstNode, names)
	}
	return names
}

function factoryBindings(factory: AstNode): Set<string> {
	const names = blockBindings(factory.body as AstNode)
	bindingNames(factory.id as AstNode, names)
	arrayOf(factory.params).forEach((param) => bindingNames(param as AstNode, names))
	const visit = (node: AstNode): void => {
		if (isFunctionOrClass(node)) return
		// var belongs to the function even when declared inside a catch, loop or nested block.
		if (node.type === 'VariableDeclaration' && node.kind === 'var')
			for (const raw of arrayOf(node.declarations))
				bindingNames((raw as AstNode).id as AstNode, names)
		for (const child of astChildren(node)) visit(child)
	}
	visit(factory.body as AstNode)
	return names
}

function isFunctionOrClass(node: AstNode): boolean {
	return [
		'ArrowFunctionExpression',
		'FunctionExpression',
		'FunctionDeclaration',
		'ClassExpression',
		'ClassDeclaration',
	].includes(String(node.type))
}

function astChildren(node: AstNode): AstNode[] {
	return Object.values(node).flatMap((value) => {
		const values = Array.isArray(value) ? value : [value]
		return values.filter((item): item is AstNode =>
			Boolean(item && typeof item === 'object' && 'type' in item),
		)
	})
}

/** Reject obvious violations of the immutable catalog contract; this is not effect analysis. */
function assertCatalogNotMutated(
	factory: AstNode,
	catalog: AstNode,
	id: string,
	error: DeclarationError,
): void {
	const catalogName = readIdentifier(unwrapExpression(catalog))
	if (!catalogName) return
	const readMethods = new Set([
		'map',
		'filter',
		'slice',
		'concat',
		'includes',
		'indexOf',
		'lastIndexOf',
		'find',
		'findIndex',
		'findLast',
		'findLastIndex',
		'some',
		'every',
		'flat',
		'flatMap',
		'toReversed',
		'toSorted',
		'toSpliced',
		'with',
		'at',
		'entries',
		'keys',
		'values',
	])
	const refers = (node: AstNode | undefined): boolean =>
		Boolean(node && readIdentifier(unwrapExpression(node)) === catalogName)
	const rooted = (node: AstNode | undefined): boolean => {
		if (!node) return false
		const expression = unwrapExpression(node)
		return (
			refers(expression) ||
			(expression.type === 'MemberExpression' && rooted(expression.object as AstNode))
		)
	}
	const reject = () =>
		error(
			`[static-application] ${id} plugins catalog ${catalogName} must remain immutable; mutation, aliasing and passing the catalog to helpers are not supported`,
		)
	const visit = (node: AstNode): void => {
		if (isFunctionOrClass(node)) {
			if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return
			if (factoryBindings(node).has(catalogName)) return
		}
		if (node.type === 'BlockStatement' && blockBindings(node).has(catalogName)) return
		if (node.type === 'CatchClause' && bindingNames(node.param as AstNode).has(catalogName)) return
		if (['ForStatement', 'ForInStatement', 'ForOfStatement'].includes(String(node.type))) {
			const declaration = (node.init ?? node.left) as AstNode | undefined
			if (
				declaration?.type === 'VariableDeclaration' &&
				declaration.kind !== 'var' &&
				arrayOf(declaration.declarations).some((raw) =>
					bindingNames((raw as AstNode).id as AstNode).has(catalogName),
				)
			)
				return
		}
		if (
			node.type === 'AssignmentExpression' &&
			(rooted(node.left as AstNode) || refers(node.right as AstNode))
		)
			reject()
		if (node.type === 'UpdateExpression' && rooted(node.argument as AstNode)) reject()
		if (
			node.type === 'UnaryExpression' &&
			node.operator === 'delete' &&
			rooted(node.argument as AstNode)
		)
			reject()
		if (node.type === 'VariableDeclarator' && refers(node.init as AstNode)) reject()
		if (node.type === 'CallExpression' || node.type === 'NewExpression') {
			if (arrayOf(node.arguments).some((raw) => refers(raw as AstNode))) reject()
			const callee = node.callee as AstNode
			if (callee.type === 'MemberExpression' && rooted(callee.object as AstNode)) {
				const method = callee.computed
					? readLiteralString(callee.property)
					: readIdentifier(callee.property)
				if (!refers(callee.object as AstNode) || !method || !readMethods.has(method)) reject()
			}
		}
		for (const child of astChildren(node)) visit(child)
	}
	visit(factory.body as AstNode)
}

export function unwrapExpression(node: AstNode): AstNode {
	while (
		[
			'TSSatisfiesExpression',
			'TSAsExpression',
			'ParenthesizedExpression',
			'TSNonNullExpression',
		].includes(String(node.type))
	) {
		node = node.expression as AstNode
	}
	return node
}

/** Ignore nested functions: their return statements do not return from the app factory. */
function collectFactoryReturns(node: AstNode): AstNode[] {
	if (
		['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(
			String(node.type),
		)
	)
		return []
	if (node.type === 'ReturnStatement') return [node]
	return Object.values(node).flatMap((value) => {
		if (Array.isArray(value))
			return value.flatMap((item) =>
				item && typeof item === 'object' && 'type' in item
					? collectFactoryReturns(item as AstNode)
					: [],
			)
		return value && typeof value === 'object' && 'type' in value
			? collectFactoryReturns(value as AstNode)
			: []
	})
}

async function resolveStaticCatalogPluginSymbols(
	expression: AstNode,
	module: ReturnType<typeof collectConfigSchemaModule>,
	sourceResolver: ConfigSchemaSourceResolver,
	id: string,
	error: DeclarationError,
): Promise<Set<string>> {
	const symbols = await sourceResolver.resolveArraySymbols(module, expression)
	if (!symbols) {
		error(
			`[static-application] ${id} plugins catalog must statically resolve to an array of direct Plugin identifiers; conditional or computed catalogs are outside the static deployment contract`,
		)
	}
	return new Set(symbols!.map(sourceSymbolKey))
}

export function parseDirectMapping(
	node: AstNode | undefined,
	path: readonly string[],
	label: string,
	id: string,
	error: DeclarationError,
	recover?: (error: unknown, node: AstNode) => void,
): MappingLeaf[] {
	const environmentName = readLiteralString(node)
	if (environmentName !== undefined) {
		if (!ENVIRONMENT_NAME.test(environmentName)) {
			error(
				`[static-application] ${id} ${label} at ${formatPath(path)} environment name must match [A-Z_][A-Z0-9_]*`,
				{ code: 'invalid_declaration', node },
			)
		}

		return [Object.freeze({ environmentName, node: node!, path: Object.freeze([...path]) })]
	}
	if (node?.type !== 'ObjectExpression') {
		error(
			`[static-application] ${id} ${label} at ${formatPath(path)} must be a direct environment name string or object literal`,
			{ code: 'unsupported_expression', node },
		)
	}
	const properties = directObjectProperties(node, label, id, error)
	if (properties.size === 0) {
		error(
			`[static-application] ${id} ${label} at ${formatPath(path)} must contain at least one binding`,
			{ code: 'invalid_declaration', node },
		)
	}
	return [...properties].flatMap(([key, property]) => {
		try {
			return parseDirectMapping(property.value, [...path, key], label, id, error, recover)
		} catch (failure) {
			if (!recover) throw failure
			recover(failure, property.value)
			return []
		}
	})
}

function directObjectProperties(
	node: AstNode,
	label: string,
	id: string,
	error: DeclarationError,
): Map<string, AstNode & { value: AstNode }> {
	const properties = new Map<string, AstNode & { value: AstNode }>()
	for (const [index, rawProperty] of arrayOf(node.properties).entries()) {
		const property = rawProperty as AstNode
		if (property.type === 'SpreadElement') {
			error(`[static-application] ${id} ${label} does not allow spread properties`, {
				code: 'unsupported_expression',
				node: property,
			})
		}
		if (property.type !== 'Property' || property.computed === true) {
			error(`[static-application] ${id} ${label} property[${index}] must use a direct key`, {
				code: 'unsupported_expression',
				node: property,
			})
		}
		const key = directPropertyName(property.key)
		const value = property.value as AstNode | undefined
		if (
			!key ||
			!value ||
			key.length > 256 ||
			key.includes('\0') ||
			['__proto__', 'constructor', 'prototype'].includes(key)
		) {
			error(`[static-application] ${id} ${label} property[${index}] must use a direct data key`, {
				code: 'invalid_declaration',
				node: property,
			})
		}
		if (properties.has(key)) {
			error(`[static-application] ${id} ${label} contains duplicate key ${JSON.stringify(key)}`, {
				code: 'invalid_declaration',
				node: property,
			})
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
	error: DeclarationError,
): AstNode[] {
	const args = arrayOf(call.arguments).map((argument) => argument as AstNode)
	if (args.some((argument) => argument.type === 'SpreadElement')) {
		error(`[static-application] ${id} ${label} does not allow spread arguments`)
	}
	return args
}

function assertCompatibleFanout(
	targets: readonly StaticConfigEnvironmentTarget[],
	id: string,
	error: DeclarationError,
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

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function formatPath(path: readonly string[]): string {
	return path.length === 0 ? '<root>' : path.join('.')
}

function sourceSymbolKey(symbol: ConfigSourceSymbol): string {
	return `${symbol.moduleId}\0${symbol.local}`
}
