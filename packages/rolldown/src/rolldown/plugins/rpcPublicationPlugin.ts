import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { ViteCompatPlugin } from './compat.ts'

type Compiler = typeof import('typescript-legacy')
type SourceFile = import('typescript-legacy').SourceFile
type Expression = import('typescript-legacy').Expression
type Type = import('typescript-legacy').Type
type TypeChecker = import('typescript-legacy').TypeChecker

const RPC_IMPORT = '@pluxel/services/rpc'
const PRESENTATION = new Set(['description', 'title', 'examples', '$comment'])
const SCHEMA_MAPS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
])
const SCHEMA_ARRAYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const SCHEMA_VALUES = new Set([
	'items',
	'additionalItems',
	'additionalProperties',
	'unevaluatedItems',
	'unevaluatedProperties',
	'propertyNames',
	'not',
	'if',
	'then',
	'else',
	'contains',
	'contentSchema',
])
const RESERVED_METHODS = new Set([
	...Object.getOwnPropertyNames(Object.prototype),
	'prototype',
	'then',
])

function fail(message: string): never {
	throw new Error(`[pluxel:rpc-publication] ${message}`)
}

function stable(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
			: item,
	)
}

function digest(value: unknown): string {
	return createHash('sha256')
		.update(typeof value === 'string' ? value : stable(value))
		.digest('hex')
}

/** Method tables are mappings; source property order does not change the approved contract. @internal */
export function rpcAuthorizationHash(
	publisher: string,
	id: string,
	methods: readonly Readonly<{
		method: string
		command: string
		inputSchema: Record<string, unknown>
	}>[],
	types: readonly Readonly<{ method: string; success: string }>[],
): string {
	const successByMethod = new Map(types.map(({ method, success }) => [method, success]))
	return digest({
		format: 'pluxel-rpc-contract-v1',
		publisher,
		id,
		methods: methods
			.toSorted((left, right) =>
				left.method < right.method ? -1 : left.method > right.method ? 1 : 0,
			)
			.map((item) => ({
				method: item.method,
				command: item.command,
				input: contractSchema(item.inputSchema),
				success: successByMethod.get(item.method),
			})),
	})
}

function property(
	ts: Compiler,
	object: import('typescript-legacy').ObjectLiteralExpression,
	name: string,
): Expression | undefined {
	const found = object.properties.filter(
		(item) =>
			ts.isPropertyAssignment(item) &&
			item.name.getText(object.getSourceFile()).replaceAll(/^['"]|['"]$/g, '') === name,
	)
	if (found.length > 1) fail(`duplicate ${name} property`)
	return found.length === 1
		? (found[0] as import('typescript-legacy').PropertyAssignment).initializer
		: undefined
}

function literal(ts: Compiler, node: Expression | undefined): string {
	if (!node || !ts.isStringLiteral(node)) fail('expected a static string literal')
	return node.text
}

function staticJson(ts: Compiler, node: Expression, depth = 0): unknown {
	if (depth > 16) fail('static schema value is too deep')
	if (ts.isStringLiteral(node)) return node.text
	if (ts.isNumericLiteral(node)) {
		const value = Number(node.text)
		if (!Number.isFinite(value)) fail('schema numbers must be finite')
		return value
	}
	if (
		ts.isPrefixUnaryExpression(node) &&
		node.operator === ts.SyntaxKind.MinusToken &&
		ts.isNumericLiteral(node.operand)
	) {
		const value = Number(node.operand.text)
		if (!Number.isFinite(value)) fail('schema numbers must be finite')
		return -value
	}
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false
	if (node.kind === ts.SyntaxKind.NullKeyword) return null
	if (ts.isArrayLiteralExpression(node))
		return node.elements.map((item) => {
			if (ts.isSpreadElement(item) || ts.isOmittedExpression(item))
				fail('schema values must be static JSON')
			return staticJson(ts, item, depth + 1)
		})
	if (ts.isObjectLiteralExpression(node)) {
		const value: Record<string, unknown> = Object.create(null)
		for (const item of node.properties) {
			if (
				!ts.isPropertyAssignment(item) ||
				(!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))
			)
				fail('schema values must use static JSON properties')
			const key = item.name.text
			if (Object.hasOwn(value, key)) fail(`duplicate schema value property ${key}`)
			value[key] = staticJson(ts, item.initializer, depth + 1)
		}
		return value
	}
	return fail('schema values must be static JSON')
}

function options(
	ts: Compiler,
	node: Expression | undefined,
	allowed: readonly string[],
): Record<string, unknown> {
	if (!node) return {}
	if (!ts.isObjectLiteralExpression(node)) fail('schema options must be a static object')
	const result: Record<string, unknown> = Object.create(null)
	for (const item of node.properties) {
		if (
			!ts.isPropertyAssignment(item) ||
			!item.name ||
			(!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))
		)
			fail('schema options must use named properties')
		const name = item.name.text
		if (!allowed.includes(name) || Object.hasOwn(result, name))
			fail(`unsupported schema option ${name}`)
		const value = staticJson(ts, item.initializer)
		if (['description', 'title', 'pattern', 'format'].includes(name) && typeof value !== 'string')
			fail(`schema option ${name} must be a string`)
		if (
			[
				'minLength',
				'maxLength',
				'minimum',
				'maximum',
				'exclusiveMinimum',
				'exclusiveMaximum',
				'multipleOf',
				'minItems',
				'maxItems',
				'minProperties',
				'maxProperties',
			].includes(name) &&
			typeof value !== 'number'
		)
			fail(`schema option ${name} must be a number`)
		if (['uniqueItems', 'additionalProperties'].includes(name) && typeof value !== 'boolean')
			fail(`schema option ${name} must be a boolean`)
		if (name === 'examples' && !Array.isArray(value))
			fail('schema option examples must be an array')
		result[name] = value
	}
	return result
}

function objectSchema(
	ts: Compiler,
	fields: Expression | undefined,
	optionsNode: Expression | undefined,
	kind: 'obj' | 'openObj' | 'Object',
): Record<string, unknown> {
	if (!fields || !ts.isObjectLiteralExpression(fields))
		fail(`${kind} requires static named properties`)
	const properties: Record<string, unknown> = Object.create(null)
	const required: string[] = []
	for (const item of fields.properties) {
		if (
			!ts.isPropertyAssignment(item) ||
			(!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))
		)
			fail('Command input fields must be static named properties')
		const name = item.name.text
		if (Object.hasOwn(properties, name)) fail(`duplicate Command input field ${name}`)
		const field = schema(ts, item.initializer)
		properties[name] = field.wire
		if (!field.optional) required.push(name)
	}
	const allowed = ['description', 'title', 'default', 'examples', 'minProperties', 'maxProperties']
	const settings = options(
		ts,
		optionsNode,
		kind === 'Object' ? [...allowed, 'additionalProperties'] : allowed,
	)
	if (kind === 'Object') {
		const built = { ...settings, type: 'object', required, properties }
		// The Command input normalizer appends the default to nested Type.Object schemas.
		return Object.hasOwn(settings, 'additionalProperties')
			? built
			: { ...built, additionalProperties: false }
	}
	return {
		...settings,
		additionalProperties: kind === 'openObj',
		type: 'object',
		required,
		properties,
	}
}

function schema(
	ts: Compiler,
	node: Expression,
): { wire: Record<string, unknown>; optional: boolean } {
	if (!ts.isCallExpression(node)) fail('input schema must use static TypeBox calls')
	if (ts.isIdentifier(node.expression)) {
		const kind = node.expression.text
		if (kind !== 'obj' && kind !== 'openObj') fail('unsupported schema expression')
		if (node.arguments.length === 0 || node.arguments.length > 2)
			fail(`${kind} requires properties and optional static options`)
		return {
			wire: objectSchema(ts, node.arguments[0], node.arguments[1], kind),
			optional: false,
		}
	}
	if (!ts.isPropertyAccessExpression(node.expression))
		fail('input schema must use static TypeBox calls')
	const call = node.expression
	if (
		ts.isIdentifier(call.expression) &&
		call.expression.text === 'Type' &&
		call.name.text === 'Optional'
	) {
		if (node.arguments.length !== 1) fail('Type.Optional requires one schema')
		const child = schema(ts, node.arguments[0])
		return { ...child, optional: true }
	}
	// A Transform changes the decoded handler type; only its inner wire schema is published.
	if (call.name.text === 'Encode' && ts.isCallExpression(call.expression)) {
		const decode = call.expression.expression
		if (
			ts.isPropertyAccessExpression(decode) &&
			decode.name.text === 'Decode' &&
			ts.isCallExpression(decode.expression)
		) {
			const transform = decode.expression.expression
			if (
				ts.isPropertyAccessExpression(transform) &&
				transform.name.text === 'Transform' &&
				ts.isIdentifier(transform.expression) &&
				transform.expression.text === 'Type'
			) {
				return schema(ts, decode.expression.arguments[0])
			}
		}
	}
	if (!ts.isIdentifier(call.expression) || call.expression.text !== 'Type')
		fail('unsupported schema expression')
	const kind = call.name.text
	if (kind === 'Object') {
		if (node.arguments.length === 0 || node.arguments.length > 2)
			fail('Type.Object requires properties and optional static options')
		return {
			wire: objectSchema(ts, node.arguments[0], node.arguments[1], 'Object'),
			optional: false,
		}
	}
	if (kind === 'Array') {
		if (node.arguments.length === 0 || node.arguments.length > 2)
			fail('Type.Array requires an item schema and optional static options')
		const item = schema(ts, node.arguments[0])
		if (item.optional) fail('Type.Array item cannot be optional')
		return {
			wire: {
				...options(ts, node.arguments[1], [
					'description',
					'title',
					'default',
					'examples',
					'minItems',
					'maxItems',
					'uniqueItems',
				]),
				type: 'array',
				items: item.wire,
			},
			optional: false,
		}
	}
	if (!['String', 'Integer', 'Number', 'Boolean'].includes(kind))
		fail(`unsupported TypeBox schema ${kind}`)
	if (node.arguments.length > 1) fail(`Type.${kind} accepts one options object`)
	const common = ['description', 'title', 'default', 'examples']
	const allowed =
		kind === 'String'
			? [...common, 'minLength', 'maxLength', 'pattern', 'format']
			: kind === 'Boolean'
				? common
				: [...common, 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']
	return {
		wire: { ...options(ts, node.arguments[0], allowed), type: kind.toLowerCase() },
		optional: false,
	}
}

/** Parse the wire schema from a static Command input declaration. @internal */
export function inputSchema(ts: Compiler, node: Expression): Record<string, unknown> {
	const parsed = schema(ts, node)
	if (parsed.optional || parsed.wire.type !== 'object')
		fail('Command input must be a static object schema')
	return parsed.wire
}

/** Strip annotations only where JSON Schema defines a schema, not inside JSON business values. @internal */
export function contractSchema(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value
	const result: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value)) {
		if (PRESENTATION.has(key)) continue
		if (SCHEMA_MAPS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
			result[key] = Object.fromEntries(
				Object.entries(child).map(([name, nested]) => [name, contractSchema(nested)]),
			)
		} else if (
			key === 'dependencies' &&
			child &&
			typeof child === 'object' &&
			!Array.isArray(child)
		) {
			result[key] = Object.fromEntries(
				Object.entries(child).map(([name, nested]) => [
					name,
					Array.isArray(nested) ? nested : contractSchema(nested),
				]),
			)
		} else if (SCHEMA_ARRAYS.has(key) && Array.isArray(child)) {
			result[key] = child.map(contractSchema)
		} else if (SCHEMA_VALUES.has(key)) {
			result[key] =
				key === 'items' && Array.isArray(child) ? child.map(contractSchema) : contractSchema(child)
		} else {
			result[key] = child
		}
	}
	return result
}

/** Print a closed client DTO. Success values may intentionally contain unknown JSON data. @internal */
export function dto(
	ts: Compiler,
	checker: TypeChecker,
	type: Type,
	location: import('typescript-legacy').Node,
	allowUnknown = false,
	seen = new Set<Type>(),
): string {
	if (seen.size > 16) fail('DTO depth limit exceeded')
	if (type.flags & ts.TypeFlags.Any) fail('any DTO cannot produce an exact client')
	if (type.flags & ts.TypeFlags.Unknown) {
		if (allowUnknown) return 'unknown'
		fail('unknown input DTO cannot produce an exact client')
	}
	if (type.flags & ts.TypeFlags.StringLiteral)
		return JSON.stringify((type as import('typescript-legacy').StringLiteralType).value)
	if (type.flags & ts.TypeFlags.NumberLiteral)
		return String((type as import('typescript-legacy').NumberLiteralType).value)
	if (type.flags & ts.TypeFlags.BooleanLiteral) {
		const booleanText = checker.typeToString(type)
		if (booleanText === 'true' || booleanText === 'false') return booleanText
		fail('unsupported boolean literal DTO')
	}
	if (type.flags & ts.TypeFlags.StringLike) return 'string'
	if (type.flags & ts.TypeFlags.NumberLike) return 'number'
	if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean'
	if (type.flags & ts.TypeFlags.Null) return 'null'
	if (type.flags & ts.TypeFlags.Undefined) fail('undefined is not a JSON DTO value')
	if (type.isUnion())
		return type.types
			.map((part) => dto(ts, checker, part, location, allowUnknown, seen))
			.join(' | ')
	if (checker.isArrayType(type))
		return `Array<${dto(ts, checker, checker.getTypeArguments(type as import('typescript-legacy').TypeReference)[0], location, allowUnknown, seen)}>`
	if (checker.isTupleType(type) || type.isIntersection())
		fail('tuple/intersection DTO is unsupported')
	if (!(type.flags & ts.TypeFlags.Object)) fail(`unsupported DTO ${checker.typeToString(type)}`)
	if (seen.has(type)) fail('recursive DTO is unsupported')
	if (checker.getIndexInfosOfType(type).length > 0 || type.symbol?.getName() === 'Date')
		fail('open/native DTO is unsupported')
	if (type.symbol?.flags & ts.SymbolFlags.Class) fail('class DTO is unsupported')
	if (
		checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
		checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
	)
		fail('callable DTO is unsupported')
	const next = new Set([...seen, type])
	const properties = checker.getPropertiesOfType(type)
	if (properties.length > 128) fail('DTO property limit exceeded')
	return `{ ${properties
		.map((field) => {
			const value = checker.getTypeOfSymbolAtLocation(field, location)
			const optional = !!(field.flags & ts.SymbolFlags.Optional)
			const clean =
				optional && value.isUnion()
					? value.types.filter((part) => !(part.flags & ts.TypeFlags.Undefined))
					: [value]
			return `${JSON.stringify(field.name)}${optional ? '?' : ''}: ${clean.map((part) => dto(ts, checker, part, location, allowUnknown, next)).join(' | ')}`
		})
		.join('; ')} }`
}

function commandFacts(
	ts: Compiler,
	checker: TypeChecker,
	identifier: import('typescript-legacy').Identifier,
	symbol = checker.getSymbolAtLocation(identifier),
) {
	if (!symbol) fail(`cannot resolve Command ${identifier.text}`)
	const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
	const declaration = target.declarations?.find(ts.isVariableDeclaration)
	if (
		!declaration ||
		!ts.isIdentifier(declaration.name) ||
		!declaration.initializer ||
		!ts.isCallExpression(declaration.initializer) ||
		!ts.isIdentifier(declaration.initializer.expression) ||
		declaration.initializer.expression.text !== 'defineCommand'
	)
		fail(`Command ${identifier.text} must resolve to a direct defineCommand export`)
	const call = declaration.initializer
	const definition = checker.getResolvedSignature(call)?.declaration
	if (
		!definition ||
		!/(?:\/packages\/commands\/|\/node_modules\/@pluxel\/commands\/)/.test(
			definition.getSourceFile().fileName.replaceAll('\\', '/'),
		)
	)
		fail(`Command ${identifier.text} must use @pluxel/commands defineCommand`)
	if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0]))
		fail('defineCommand requires a static object')
	const object = call.arguments[0]
	const hasTypeBoxImport = declaration.getSourceFile().statements.some((statement) => {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
			return false
		const source = statement.moduleSpecifier.text
		if (
			source !== '@pluxel/commands/typebox' &&
			!source.endsWith('/packages/commands/src/typebox.js')
		)
			return false
		const named = statement.importClause?.namedBindings
		return (
			!!named &&
			ts.isNamedImports(named) &&
			named.elements.some(
				(item) => item.name.text === 'Type' && (item.propertyName?.text ?? 'Type') === 'Type',
			)
		)
	})
	if (!hasTypeBoxImport)
		fail(`Command ${identifier.text} must import Type from @pluxel/commands/typebox`)
	const name = literal(ts, property(ts, object, 'name'))
	const description = literal(ts, property(ts, object, 'description'))
	const input = property(ts, object, 'input')
	if (!input) fail(`Command ${name} needs static input`)
	const wire = inputSchema(ts, input)
	const commandType = checker.getTypeAtLocation(identifier)
	const execute = checker.getPropertyOfType(commandType, 'execute')
	if (!execute) fail(`Command ${name} has no execute method`)
	const signature = checker.getSignaturesOfType(
		checker.getTypeOfSymbolAtLocation(execute, identifier),
		ts.SignatureKind.Call,
	)[0]
	if (!signature) fail(`Command ${name} execute is not callable`)
	const wireInput = checker.getTypeOfSymbolAtLocation(signature.parameters[0], identifier)
	const result = checker.getAwaitedType(signature.getReturnType())
	const successBranch = result?.isUnion()
		? result.types.find((part) => checker.getPropertyOfType(part, 'value'))
		: undefined
	if (!successBranch) fail(`Command ${name} must return Result`)
	const success = checker.getTypeOfSymbolAtLocation(
		checker.getPropertyOfType(successBranch, 'value')!,
		identifier,
	)
	return {
		name,
		description,
		inputSchema: wire,
		inputType: dto(ts, checker, wireInput, identifier),
		successType:
			success.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)
				? 'null'
				: dto(ts, checker, success, identifier, true),
		declaration: declaration.getSourceFile(),
	}
}

function analyze(ts: Compiler, id: string, code: string) {
	const compilerOptions: import('typescript-legacy').CompilerOptions = {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		allowImportingTsExtensions: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		customConditions: ['@pluxel/hmr', '@pluxel/source'],
	}
	const host = ts.createCompilerHost(compilerOptions)
	const original = host.getSourceFile.bind(host)
	host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
		resolve(name) === resolve(id)
			? ts.createSourceFile(name, code, languageVersion, true)
			: original(name, languageVersion, onError, shouldCreateNewSourceFile)
	const program = ts.createProgram([id], compilerOptions, host)
	const source = program.getSourceFile(id)
	if (!source) fail(`cannot inspect ${id}`)
	const rpcNames = new Set<string>()
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			statement.moduleSpecifier.getText(source).slice(1, -1) !== RPC_IMPORT
		)
			continue
		for (const item of statement.importClause?.namedBindings &&
		ts.isNamedImports(statement.importClause.namedBindings)
			? statement.importClause.namedBindings.elements
			: [])
			if ((item.propertyName?.text ?? item.name.text) === 'Rpc') rpcNames.add(item.name.text)
	}
	if (rpcNames.size === 0) return { publications: [], resolutions: [] }
	// The publication source is checked here; imported workspace packages own their own
	// compiler settings and are validated by their package builds.
	const diagnostics = ts
		.getPreEmitDiagnostics(program)
		.filter((diagnostic) => diagnostic.file && resolve(diagnostic.file.fileName) === resolve(id))
	if (diagnostics.length > 0)
		fail(
			ts.formatDiagnostics(diagnostics, {
				getCurrentDirectory: () => dirname(id),
				getCanonicalFileName: (name) => name,
				getNewLine: () => '\n',
			}),
		)
	const checker = program.getTypeChecker()
	const resolutions: Array<{ specifier: string; tsPath: string }> = []
	const publications: Array<{
		start: number
		end: number
		replacement: string
		declaration: string
		id: string
		owner: string
		siteDeclaration: string
		manifestEntry: string
	}> = []
	function rpcRequire(node: import('typescript-legacy').Node): boolean {
		return (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'require' &&
			node.arguments.length === 1 &&
			ts.isIdentifier(node.arguments[0]) &&
			rpcNames.has(node.arguments[0].text)
		)
	}
	function visit(node: import('typescript-legacy').Node) {
		if (rpcRequire(node) && code.includes('publish')) {
			const parent = node.parent
			if (
				!ts.isPropertyAccessExpression(parent) ||
				parent.name.text !== 'publish' ||
				!ts.isCallExpression(parent.parent)
			)
				fail('indirect RPC publish is unsupported; call ctx.require(Rpc).publish({...}) directly')
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'publish' &&
			rpcRequire(node.expression.expression)
		) {
			let owner: import('typescript-legacy').Node | undefined = node.parent
			while (owner && !ts.isClassDeclaration(owner)) owner = owner.parent
			if (
				!owner ||
				!ts.isClassDeclaration(owner) ||
				!owner.name ||
				!owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
				!ts
					.getDecorators(owner)
					?.some(
						(decorator) =>
							ts.isCallExpression(decorator.expression) &&
							ts.isIdentifier(decorator.expression.expression) &&
							decorator.expression.expression.text === 'Plugin',
					)
			)
				fail('RPC publish must be inside an exported @Plugin class in the same module')
			if (node.arguments.length !== 1 || !ts.isObjectLiteralExpression(node.arguments[0]))
				fail('RPC publish requires one static object argument')
			const object = node.arguments[0]
			const apiId = literal(ts, property(ts, object, 'id'))
			const table = property(ts, object, 'commands')
			if (!table || !ts.isObjectLiteralExpression(table))
				fail('RPC commands must be a static object table')
			const methods: Array<{
				method: string
				command: string
				description: string
				inputSchema: Record<string, unknown>
			}> = []
			const types: Array<{ method: string; input: string; success: string }> = []
			const bindings: string[] = []
			const sources = new Set<SourceFile>([source])
			for (const item of table.properties) {
				if (!ts.isPropertyAssignment(item) && !ts.isShorthandPropertyAssignment(item))
					fail('RPC method must be a static property')
				if (!ts.isIdentifier(item.name) && !ts.isStringLiteral(item.name))
					fail('RPC method name must be static')
				const method = item.name.text
				if (
					!/^[A-Za-z_][A-Za-z0-9_]*$/.test(method) ||
					RESERVED_METHODS.has(method) ||
					methods.some((entry) => entry.method === method)
				)
					fail(`invalid or duplicate RPC method ${method}`)
				const value = ts.isShorthandPropertyAssignment(item) ? item.name : item.initializer
				if (!ts.isIdentifier(value)) fail(`RPC method ${method} must name a direct Command import`)
				const symbol = ts.isShorthandPropertyAssignment(item)
					? checker.getShorthandAssignmentValueSymbol(item)
					: checker.getSymbolAtLocation(value)
				const imported = symbol?.declarations?.find(ts.isImportSpecifier)
				if (imported) {
					const declaration = imported.parent.parent.parent
					if (
						!ts.isImportDeclaration(declaration) ||
						!ts.isStringLiteral(declaration.moduleSpecifier)
					)
						fail(`cannot identify Command import for ${method}`)
					const specifier = declaration.moduleSpecifier.text
					const tsPath = ts.resolveModuleName(specifier, id, compilerOptions, host).resolvedModule
						?.resolvedFileName
					if (!tsPath) fail(`cannot resolve Command import ${specifier}`)
					resolutions.push({ specifier, tsPath })
				}
				const facts = commandFacts(ts, checker, value, symbol)
				methods.push({
					method,
					command: facts.name,
					description: facts.description,
					inputSchema: facts.inputSchema,
				})
				types.push({ method, input: facts.inputType, success: facts.successType })
				bindings.push(`${JSON.stringify(method)}: ${value.text}`)
				sources.add(facts.declaration)
			}
			if (methods.length === 0) fail('RPC method table cannot be empty')
			const packageInfo = nearestPackage(id)
			const publisher = `${packageInfo.name}/${relative(packageInfo.root, id).replaceAll('\\', '/')}`
			const contract = {
				id: apiId,
				hash: rpcAuthorizationHash(publisher, apiId, methods, types),
			}
			let declaration = `export type RpcFailure = { readonly message: string; readonly callId: string; readonly outcome: 'not_started' | 'unknown' } & (\n  | { readonly code: 'INPUT_VALIDATION'; readonly issues: readonly { readonly path?: readonly (string | number)[]; readonly code?: string; readonly message: string }[] }\n  | { readonly code: 'REJECTED'; readonly reason: string }\n  | { readonly code: 'FORBIDDEN' | 'COMMAND_NOT_FOUND' | 'PUBLICATION_GONE' | 'ABORTED' | 'TIMEOUT' | 'DEPENDENCY' | 'INTERNAL' | 'OUTPUT_ENCODING' | 'OUTPUT_LIMIT' }\n);\nexport type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcFailure };\nexport interface RpcApi {\n${types.map((item) => `  ${JSON.stringify(item.method)}(input: ${item.input}): Promise<RpcResult<${item.success}>>;`).join('\n')}\n}\n`
			declaration += `export interface RpcClient { open(id: ${JSON.stringify(apiId)}): RpcApi; }\n`
			const document = {
				format: 'pluxel-rpc-artifact-v1',
				contract,
				methods,
				types,
				declaration,
				sources: [...sources]
					.map((file) => ({
						file: relative(dirname(id), file.fileName),
						digest: digest(file === source ? code : readFileSync(file.fileName, 'utf8')),
					}))
					.sort((a, b) => a.file.localeCompare(b.file)),
			}
			const artifact = {
				format: document.format,
				integrity: digest(document),
				contract,
				methods,
				types,
				declaration,
			}
			const extra = object.properties
				.filter((item) => {
					if (
						!ts.isPropertyAssignment(item) ||
						!ts.isIdentifier(item.name) ||
						!['id', 'commands', 'context', 'authorize'].includes(item.name.text)
					)
						fail('RPC publish only supports static id, commands, context and authorize properties')
					return item.name.text !== 'id' && item.name.text !== 'commands'
				})
				.map((item) => item.getText(source))
			const siteName = `__pluxelRpcSite${publications.length}`
			const site = `${publisher}:${owner.name.text}:${apiId}:${publications.length}`
			const siteDeclaration = `const ${siteName} = Object.freeze({ bindings: Object.freeze({ ${bindings.join(', ')} }), artifact: __pluxelRpcDeepFreeze(${JSON.stringify(artifact)}) });`
			const replacement = `{ api: { id: ${JSON.stringify(apiId)}, commands: ${table.getText(source)} }, bindings: ${siteName}.bindings, artifact: ${siteName}.artifact${extra.length > 0 ? `, ${extra.join(', ')}` : ''} }`
			publications.push({
				start: object.getStart(source),
				end: object.end,
				replacement,
				declaration,
				id: apiId,
				owner: owner.name.text,
				siteDeclaration,
				manifestEntry: `{ site: ${JSON.stringify(site)}, owner: ${JSON.stringify(owner.name.text)}, artifact: ${siteName}.artifact, bindings: ${siteName}.bindings }`,
			})
		}
		ts.forEachChild(node, visit)
	}
	visit(source)
	return { publications, resolutions }
}

function nearestPackage(id: string): { name: string; root: string } {
	let current = dirname(id)
	for (;;) {
		try {
			const packageJson = JSON.parse(readFileSync(resolve(current, 'package.json'), 'utf8')) as {
				name?: unknown
			}
			if (typeof packageJson.name === 'string' && packageJson.name)
				return { name: packageJson.name, root: current }
		} catch {
			/* Continue toward the filesystem root. */
		}
		const parent = dirname(current)
		if (parent === current) fail(`RPC publication ${id} has no package identity`)
		current = parent
	}
}

/** Shared Vite/Rolldown pass. Ordinary modules do not load the TypeScript compiler. */
export function rpcPublicationPlugin(): ViteCompatPlugin {
	const declarations = new Map<string, string>()
	return {
		name: 'pluxel:rpc-publication',
		enforce: 'pre',
		async transform(code, id) {
			const clean = id.split('?')[0]
			const prefix = `${relative(process.cwd(), clean)}:`
			for (const key of declarations.keys()) if (key.startsWith(prefix)) declarations.delete(key)
			if (!code.includes(RPC_IMPORT)) return null
			if (!/\.[cm]?[jt]sx?$/.test(clean)) return null
			const ts = await import('typescript-legacy')
			const { publications, resolutions } = analyze(ts, clean, code)
			if (publications.length === 0) return null
			for (const { specifier, tsPath } of resolutions) {
				const bundled = await this.resolve(specifier, clean, { skipSelf: true })
				if (
					!bundled ||
					bundled.external ||
					realpathSync(bundled.id.split('?')[0]) !== realpathSync(tsPath)
				)
					fail(
						`Command import ${specifier} resolves differently in TypeScript and Vite/Rolldown; publish a source-matched package or build artifact`,
					)
			}
			if (
				code.includes('__pluxelRpcSite') ||
				code.includes('__pluxelRpcPublications') ||
				code.includes('__pluxelRpcDeepFreeze') ||
				code.includes('__setPluginRpcSites') ||
				code.includes('__pluxelSetPluginRpcSites')
			)
				fail('reserved generated RPC binding name appears in source')
			let output = code
			for (const item of publications.sort((a, b) => b.start - a.start)) {
				output = output.slice(0, item.start) + item.replacement + output.slice(item.end)
				declarations.set(`${prefix}${item.id}:${item.start}`, item.declaration)
			}
			const owners = [...new Set(publications.map((item) => item.owner))]
			const setters = owners.map((owner) => {
				const indices = publications.flatMap((item, index) => (item.owner === owner ? [index] : []))
				const sites =
					owners.length === 1
						? '__pluxelRpcPublications'
						: `Object.freeze([${indices.map((index) => `__pluxelRpcPublications[${index}]`).join(', ')}])`
				return `__pluxelSetPluginRpcSites(${owner}, { abiVersion: 2, sites: ${sites} });`
			})
			output += `\nimport { __setPluginRpcSites as __pluxelSetPluginRpcSites } from '@pluxel/core/toolchain';\nfunction __pluxelRpcDeepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) __pluxelRpcDeepFreeze(child); Object.freeze(value); } return value; }\n${publications.map((item) => item.siteDeclaration).join('\n')}\nexport const __pluxelRpcPublications = Object.freeze([${publications.map((item) => `Object.freeze(${item.manifestEntry})`).join(', ')}]);\n${setters.join('\n')}\n`
			return { code: output, map: null }
		},
		generateBundle() {
			for (const [name, source] of declarations)
				this.emitFile({ type: 'asset', fileName: `rpc/${digest(name).slice(0, 12)}.d.ts`, source })
		},
	}
}
