import type { Program } from 'oxc-parser'
import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'
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
	detail?: {
		code: 'invalid_declaration' | 'unsupported_expression' | 'unresolved_symbol'
		node?: AstNode
		file?: string
	},
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
	/** Exact constructor bindings in the validated immutable application catalog. */
	plugins?: readonly ConfigSourceSymbol[]
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
 * Both standalone and modules emit environment templates from the same node declarations.
 * Schema projection uses a closed, inert subset of the resolved Valibot schema source.
 */
export async function parseStaticRuntimeDeclaration(
	options: StaticRuntimeDeclarationParserOptions,
): Promise<StaticRuntimeDeclarationFacts> {
	const { ast, code, id, sourceResolver, error } = options
	const declaration = readApplicationDeclaration({ ast, code, id, error })
	const { fields } = declaration
	const nodes = await readApplicationNodes({
		...declaration,
		sourceResolver,
		error,
		checkImmutable: options.requireStaticPlugins,
	})
	const sourceExpression = fields.get('sources')?.value
	const sources = sourceExpression && unwrapExpression(sourceExpression)
	const hasSources =
		sources !== undefined &&
		(sources.type !== 'ArrayExpression' || arrayOf(sources.elements).length > 0)
	const name = readLiteralString(fields.get('name')?.value)
	const catalog: ConfigSourceSymbol[] = []
	const targets: StaticConfigEnvironmentTarget[] = []
	const seenTargets = new Set<string>()
	const configPaths = new Map<string, readonly (readonly string[])[]>()
	const owners = new Map<AstNode, ApplicationNodeOwner>()
	const seenDefinitions = new Map<string, string>()
	for (const node of nodes) {
		const bindings = node.fields.get('envBindings')?.value
		const isFixedDefinition =
			options.requireStaticPlugins && node.role === 'plugins' && node.forkId === undefined
		if (!bindings && !isFixedDefinition) continue
		const owner =
			owners.get(node.selector) ?? (await resolveApplicationNodeOwner(node, sourceResolver, error))
		owners.set(node.selector, owner)
		const ownerKey =
			owner.kind === 'literal'
				? pluginDefinitionIndexKey(owner.definition)
				: sourceSymbolKey(owner.symbol)
		if (isFixedDefinition && owner.kind === 'symbol') {
			const previous = seenDefinitions.get(ownerKey)
			if (previous)
				error(
					`[static-application] ${node.module.id} ${node.label} repeats the Plugin declaration in ${previous}`,
					{
						code: 'invalid_declaration',
						node: node.selector,
						file: node.module.id,
					},
				)
			seenDefinitions.set(ownerKey, node.label)
			catalog.push(owner.symbol)
		}
		if (!bindings) continue
		for (const [index, binding] of readApplicationBindingArray(node, 'env', error).entries()) {
			const label = `${node.label}.envBindings[${index}]`
			const { module, forkId } = node
			const file = module.id
			const pluginName = owner.name
			const bindingFields = readApplicationBinding(binding, 'env', label, module, error)
			const namespace = readBindingNamespace(bindingFields, label, file, error)
			for (const kind of ['config', 'vault'] as const) {
				const descriptor = bindingFields.get(kind)?.value
				if (!descriptor) continue
				const { schemaExpression, source: mapping } = readBindingDescriptor(
					unwrapExpression(descriptor),
					'env',
					kind,
					file,
					error,
				)
				if (kind === 'vault' && mapping.type !== 'ObjectExpression')
					error(`[static-application] ${file} vault mapping must declare record keys directly`)
				const leaves = parseDirectMapping(mapping, [], `${label}.${kind}.mapping`, file, error)
				const schemaName = readIdentifier(schemaExpression) ?? `${pluginName}.${kind}`
				const schemaSource = await sourceResolver.renderResolved(module, schemaExpression)
				const schema = restoreStaticConfigSchema(schemaSource, { id: file, schemaName, error })
				if (kind === 'config')
					registerConfigBindingPaths(
						configPaths,
						JSON.stringify([ownerKey, forkId ?? null]),
						leaves.map((leaf) => leaf.path),
						pluginName,
						file,
						error,
					)
				for (const targetKey of kind === 'vault'
					? [...new Set(leaves.map((leaf) => leaf.path[0]!))]
					: []) {
					const identity = JSON.stringify([ownerKey, forkId ?? null, namespace ?? '', targetKey])
					registerBindingTarget(seenTargets, identity, pluginName, file, error)
				}
				for (const leaf of leaves) {
					const inputSchema =
						kind === 'vault' ? staticVaultRecordSchema(schema, leaf.path[0]!, file, error) : schema
					const projection = projectRawInput(
						inputSchema as never,
						kind === 'vault' ? leaf.path.slice(1) : leaf.path,
					)
					if (projection.ok === false)
						error(
							`[static-application] ${file} cannot bind ${leaf.environmentName} to ${pluginName} schema ${schemaName} path ${formatPath(leaf.path)}: ${projection.reason}`,
						)
					targets.push(
						Object.freeze({
							environmentName: leaf.environmentName,
							pluginName,
							...(forkId === undefined ? {} : { forkId }),
							schemaName,
							kind,
							...(kind === 'vault' && namespace ? { namespace } : {}),
							path: leaf.path,
							projection: projection as RawInputProjection,
						}),
					)
				}
			}
		}
	}
	assertCompatibleFanout(targets, id, error)
	const frozenTargets = Object.freeze(targets)
	return Object.freeze({
		...(name === undefined ? {} : { name }),
		...(options.requireStaticPlugins ? { plugins: Object.freeze(catalog) } : {}),
		hasSources,
		targets: frozenTargets,
		...(targets.length > 0
			? { environmentExample: renderStaticConfigEnvironmentExample(frozenTargets) }
			: {}),
	})
}

type ObjectFields = ReturnType<typeof directObjectProperties>
type SchemaModule = ReturnType<typeof collectConfigSchemaModule>
type ApplicationNode = Readonly<{
	role: 'plugins' | 'pluginNodes'
	module: SchemaModule
	label: string
	selector: AstNode
	fields: ObjectFields
	forkId?: string
}>

type ApplicationNodeOwner = Readonly<
	| { name: string; kind: 'symbol' | 'reference'; symbol: ConfigSourceSymbol }
	| { name: string; kind: 'literal'; definition: PluginDefinitionAddress }
>

/** Read the default and fork declarations using the lexical scope of each array. */
export async function readApplicationNodes({
	module,
	factory,
	fields,
	sourceResolver,
	error,
	recover,
	checkImmutable,
}: {
	module: SchemaModule
	factory: AstNode
	fields: ObjectFields
	sourceResolver: ConfigSchemaSourceResolver
	error: DeclarationError
	recover?(failure: unknown, file: string, node: AstNode): void
	checkImmutable?: boolean
}): Promise<ApplicationNode[]> {
	const nodes: ApplicationNode[] = []
	for (const role of ['plugins', 'pluginNodes'] as const) {
		const expression = fields.get(role)?.value
		if (!expression) continue
		try {
			const array = await sourceResolver.resolveArray(module, expression)
			if (!array)
				error(
					`[static-application] ${module.id} ${role} must statically resolve to a declaration array; conditional or computed arrays are outside the static deployment contract`,
					{ code: 'unsupported_expression', node: expression, file: module.id },
				)
			if (checkImmutable) assertDeclarationsNotMutated(factory, expression, role, module.id, error)
			const file = array.module.id
			for (const [index, raw] of arrayOf(array.node.elements).entries()) {
				const label = `${role}[${index}]`
				const item = raw ? unwrapExpression(raw as AstNode) : array.node
				try {
					if (item.type !== 'ObjectExpression')
						error(`[static-application] ${file} ${label} must be a direct declaration object`, {
							code: 'unsupported_expression',
							node: item,
							file,
						})
					const entryFields = directObjectProperties(item, label, file, error)
					const key = role === 'plugins' ? 'plugin' : 'definition'
					const selector = entryFields.get(key)?.value
					if (!selector)
						error(`[static-application] ${file} ${label} must provide ${key}`, {
							code: 'invalid_declaration',
							node: item,
							file,
						})
					const node = { role, module: array.module, label, selector, fields: entryFields }
					nodes.push(node)
					const input = entryFields.get('forks')?.value
					if (!input) continue
					const table = unwrapExpression(input)
					if (table.type !== 'ObjectExpression')
						error(`[static-application] ${file} ${label}.forks must be a direct object literal`, {
							code: 'unsupported_expression',
							node: table,
							file,
						})
					for (const [forkId, { value }] of directObjectProperties(
						table,
						`${label}.forks`,
						file,
						error,
					)) {
						const forkLabel = `${node.label}.forks[${JSON.stringify(forkId)}]`
						const fork = unwrapExpression(value)
						try {
							if (fork.type !== 'ObjectExpression')
								error(
									`[static-application] ${file} ${forkLabel} must be a direct declaration object`,
									{
										code: 'unsupported_expression',
										node: fork,
										file,
									},
								)
							nodes.push({
								...node,
								label: forkLabel,
								forkId,
								fields: directObjectProperties(fork, forkLabel, file, error),
							})
						} catch (failure) {
							if (!recover) throw failure
							recover(failure, file, fork)
						}
					}
				} catch (failure) {
					if (!recover) throw failure
					recover(failure, file, item)
				}
			}
		} catch (failure) {
			if (!recover) throw failure
			recover(failure, module.id, expression)
		}
	}
	return nodes
}

export async function resolveApplicationNodeOwner(
	node: ApplicationNode,
	sourceResolver: ConfigSchemaSourceResolver,
	error: DeclarationError,
): Promise<ApplicationNodeOwner> {
	const { module, label } = node
	const file = module.id
	const selector = unwrapExpression(node.selector)
	let receiver = selector
	if (node.role === 'pluginNodes') {
		if (selector.type === 'ObjectExpression') {
			const record = (expression: AstNode, at: string): Record<string, unknown> =>
				Object.fromEntries(
					[...directObjectProperties(expression, at, file, error)].map(([key, { value }]) => [
						key,
						key === 'entry' && value.type === 'ObjectExpression'
							? record(value, `${at}.entry`)
							: readLiteralString(value),
					]),
				)
			try {
				const definition = parsePluginDefinitionAddress(record(selector, label))
				return { name: definition.exportName, kind: 'literal', definition }
			} catch (failure) {
				error(
					`[static-application] ${file} ${label}.definition has an invalid literal Plugin address: ${String(failure)}`,
					{
						code: 'invalid_declaration',
						node: selector,
						file,
					},
				)
			}
		}
		const callee = selector.callee as AstNode | undefined
		if (
			selector.type !== 'CallExpression' ||
			callee?.type !== 'MemberExpression' ||
			callee.computed ||
			readIdentifier(callee.property) !== 'address' ||
			arrayOf(selector.arguments).length > 0
		)
			error(
				`[static-application] ${file} ${label}.definition must be a literal Plugin address or call Plugin.address() directly`,
				{
					code: 'unsupported_expression',
					node: selector,
					file,
				},
			)
		receiver = callee!.object as AstNode
	}
	const name = readIdentifier(receiver)
	if (!name)
		error(`[static-application] ${file} ${label} must use a direct Plugin identifier`, {
			code: 'unsupported_expression',
			node: receiver,
			file,
		})
	const symbol = await sourceResolver.resolveSymbol(module, receiver)
	if (!symbol)
		error(`[static-application] ${file} cannot resolve ${label} Plugin ${name}`, {
			code: 'unresolved_symbol',
			node: receiver,
			file,
		})
	return { name, kind: node.role === 'plugins' ? 'symbol' : 'reference', symbol }
}

export function readApplicationBindingArray(
	node: ApplicationNode,
	kind: 'env' | 'file',
	error: DeclarationError,
): readonly (AstNode | null)[] {
	const label = `${node.label}.${kind}Bindings`
	const raw = node.fields.get(`${kind}Bindings`)?.value
	if (!raw) return []
	const expression = unwrapExpression(raw)
	if (expression.type !== 'ArrayExpression')
		error(`[static-application] ${node.module.id} ${label} must be a direct array literal`, {
			code: 'unsupported_expression',
			node: expression,
			file: node.module.id,
		})
	return arrayOf(expression.elements) as (AstNode | null)[]
}

/** Config bindings in one input layer may compose disjoint raw input paths. */
export function registerConfigBindingPaths(
	seen: Map<string, readonly (readonly string[])[]>,
	identity: string,
	paths: readonly (readonly string[])[],
	pluginName: string,
	id: string,
	error: DeclarationError,
): void {
	const previous = seen.get(identity) ?? []
	for (const path of paths)
		if (
			previous.some((other) =>
				path
					.slice(0, Math.min(path.length, other.length))
					.every((key, index) => key === other[index]),
			)
		)
			error(`[static-application] ${id} duplicate environment target for Plugin ${pluginName}`, {
				code: 'invalid_declaration',
			})
	seen.set(identity, [...previous, ...paths])
}

/** Vault bindings own complete records. */
function registerBindingTarget(
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
	bindingFields: ObjectFields,
	label: string,
	id: string,
	error: DeclarationError,
) {
	const expression = bindingFields.get('vault')?.value
	const vault = expression && unwrapExpression(expression)
	const namespaceNode =
		vault?.type === 'ObjectExpression'
			? directObjectProperties(vault, 'vault binding', id, error).get('namespace')?.value
			: undefined
	const namespace = namespaceNode ? readLiteralString(namespaceNode) : undefined
	if (
		namespaceNode &&
		(namespace === undefined || namespace.length === 0 || namespace.includes('\0'))
	)
		error(`[static-application] ${id} ${label} namespace must be a nonempty literal string`, {
			code: namespace === undefined ? 'unsupported_expression' : 'invalid_declaration',
			node: namespaceNode,
		})
	if (!bindingFields.has('config') && !bindingFields.has('vault'))
		error(`[static-application] ${id} ${label} must select config or vault`, {
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
		if (!['schema', sourceKey, ...(kind === 'vault' ? ['namespace'] : [])].includes(key))
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
	return { schemaExpression: unwrapExpression(schemaExpression), source: unwrapExpression(source) }
}

/** Parse one binding in the declaring node's own lexical scope. */
export function readApplicationBinding(
	raw: AstNode | null,
	kind: 'env' | 'file',
	label: string,
	module: SchemaModule,
	error: DeclarationError,
): ObjectFields {
	const binding = raw ? unwrapExpression(raw) : undefined
	const id = module.id
	const helper = `${kind}Binding`
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
			{ code: 'unsupported_expression', node: binding, file: id },
		)
	const args = directCallArguments(binding, helper, id, error)
	const inputs = args[0] && unwrapExpression(args[0])
	if (args.length !== 1 || inputs?.type !== 'ObjectExpression')
		error(`[static-application] ${id} ${helper} requires a single direct input object`, {
			code: 'unsupported_expression',
			node: binding,
			file: id,
		})
	const fields = directObjectProperties(inputs, label, id, error)
	for (const key of fields.keys())
		if (!['config', 'vault'].includes(key))
			error(`[static-application] ${id} unknown ${label} field ${key}`, {
				code: 'invalid_declaration',
				node: fields.get(key),
			})
	return fields
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

	return { module, factory, fields }
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
function assertDeclarationsNotMutated(
	factory: AstNode,
	catalog: AstNode,
	role: string,
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
			`[static-application] ${id} ${role} declaration ${catalogName} must remain immutable; mutation, aliasing and passing the catalog to helpers are not supported`,
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

export function directObjectProperties(
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
