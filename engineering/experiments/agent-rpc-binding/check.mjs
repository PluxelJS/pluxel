import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from '../../../node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js'
import { publication as baseline } from './publisher.ts'
import { publication as docs } from './publisher-docs.ts'
import { publication as binding } from './publisher-binding.ts'
import { publication as methodVariant } from './publisher-method.ts'
import { publication as inputVariant } from './publisher-input.ts'
import { publication as implementation } from './publisher-implementation.ts'
import { publication as output } from './publisher-output.ts'

const root = import.meta.dirname
const formatter = resolve(root, '../../../node_modules/.bin/oxfmt')
const publisherIdentity = 'package:@example/records::RecordsPlugin'
const protocol = 'rpc-result-json-v1'
const entries = [
	['baseline', baseline, 'publisher.ts'],
	['docs', docs, 'publisher-docs.ts'],
	['binding', binding, 'publisher-binding.ts'],
	['method', methodVariant, 'publisher-method.ts'],
	['input', inputVariant, 'publisher-input.ts'],
	['implementation', implementation, 'publisher-implementation.ts'],
	['output', output, 'publisher-output.ts'],
]

function stable(value) {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === 'object' && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
				)
			: item,
	)
}

function digest(value) {
	return createHash('sha256')
		.update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value))
		.digest('hex')
}

// Schema keywords point to schemas; business data in default/const/enum is deliberately opaque.
const annotations = new Set(['description', 'title', 'examples', '$comment'])
const schemaMaps = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas',
])
const schemaArrays = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems'])
const schemaValues = new Set([
	'items',
	'additionalProperties',
	'propertyNames',
	'not',
	'if',
	'then',
	'else',
	'contains',
])

function authorizationSchema(schema) {
	if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema
	const result = {}
	for (const [key, value] of Object.entries(schema)) {
		if (annotations.has(key)) continue
		if (schemaMaps.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
			result[key] = Object.fromEntries(
				Object.entries(value).map(([name, child]) => [name, authorizationSchema(child)]),
			)
		} else if (schemaArrays.has(key) && Array.isArray(value)) {
			result[key] = value.map(authorizationSchema)
		} else if (schemaValues.has(key)) {
			result[key] = authorizationSchema(value)
		} else {
			result[key] = value
		}
	}
	return result
}

// The probe only claims the TypeBox wire subset exercised by these fixtures.
function assertSchemaSupported(schema, path = '$') {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema))
		throw new Error(`unsupported wire schema at ${path}`)
	const common = ['type', ...annotations]
	const allowed =
		schema.type === 'object'
			? new Set([...common, 'properties', 'required', 'additionalProperties'])
			: schema.type === 'string'
				? new Set([...common, 'default'])
				: schema.type === 'integer'
					? new Set([...common, 'minimum', 'maximum', 'default'])
					: undefined
	if (!allowed || Object.keys(schema).some((key) => !allowed.has(key)))
		throw new Error(`unsupported wire schema at ${path}`)
	if (schema.type === 'object') {
		if (
			!schema.properties ||
			typeof schema.properties !== 'object' ||
			Array.isArray(schema.properties) ||
			schema.additionalProperties !== false ||
			!Array.isArray(schema.required) ||
			schema.required.some((name) => typeof name !== 'string' || !(name in schema.properties))
		) {
			throw new Error(`unsupported wire schema at ${path}`)
		}
		for (const [name, child] of Object.entries(schema.properties))
			assertSchemaSupported(child, `${path}.properties.${name}`)
	}
	if ('default' in schema && !['string', 'number', 'boolean'].includes(typeof schema.default))
		throw new Error(`unsupported wire default at ${path}`)
}

function dtoType(checker, type, location, seen = new Set()) {
	if (type.flags & ts.TypeFlags.Any)
		throw new Error('any cannot produce an exact client declaration')
	if (type.flags & ts.TypeFlags.Unknown)
		throw new Error('unknown cannot produce an exact client declaration')
	if (type.flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value)
	if (type.flags & ts.TypeFlags.NumberLiteral) return String(type.value)
	if (type.flags & ts.TypeFlags.StringLike) return 'string'
	if (type.flags & ts.TypeFlags.NumberLike) return 'number'
	if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean'
	if (type.flags & ts.TypeFlags.Null) return 'null'
	if (type.flags & ts.TypeFlags.Undefined) throw new Error('undefined is not a JSON DTO value')
	if (type.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type)
	if (type.flags & ts.TypeFlags.Boolean) return 'boolean'
	if (type.isUnion())
		return type.types.map((part) => dtoType(checker, part, location, seen)).join(' | ')
	if (checker.isArrayType(type))
		return `Array<${dtoType(checker, checker.getTypeArguments(type)[0], location, seen)}>`
	if (checker.isTupleType(type) || type.isIntersection())
		throw new Error('tuple and intersection DTOs are not supported')
	if (!(type.flags & ts.TypeFlags.Object))
		throw new Error(`unsupported DTO type: ${checker.typeToString(type)}`)
	if (seen.has(type)) throw new Error('recursive DTO is not supported')
	if (checker.getIndexInfosOfType(type).length > 0)
		throw new Error('index-signature DTO is not supported')
	if (type.symbol?.getName() === 'Date') throw new Error('Date is not a JSON DTO')
	if (
		checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 ||
		checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0
	) {
		throw new Error('callable DTO is not supported')
	}
	const next = new Set([...seen, type])
	const properties = checker.getPropertiesOfType(type).map((property) => {
		const fieldType = checker.getTypeOfSymbolAtLocation(property, location)
		const optional = property.flags & ts.SymbolFlags.Optional ? '?' : ''
		const wireField =
			optional && fieldType.isUnion()
				? fieldType.types
						.filter((part) => !(part.flags & ts.TypeFlags.Undefined))
						.map((part) => dtoType(checker, part, location, next))
						.join(' | ')
				: dtoType(checker, fieldType, location, next)
		return `${JSON.stringify(property.name)}${optional}: ${wireField}`
	})
	return `{ ${properties.join('; ')} }`
}

function inspect(entryFile, actual) {
	const file = resolve(root, entryFile)
	const program = ts.createProgram([file], {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
	})
	const errors = ts.getPreEmitDiagnostics(program)
	if (errors.length > 0)
		throw new Error(
			ts.formatDiagnostics(errors, {
				getCurrentDirectory: () => root,
				getCanonicalFileName: (name) => name,
				getNewLine: () => '\n',
			}),
		)
	const checker = program.getTypeChecker()
	const source = program.getSourceFile(file)
	const publicationStatement = source.statements.find(
		(node) =>
			ts.isVariableStatement(node) &&
			node.declarationList.declarations.some((item) => item.name.text === 'publication'),
	)
	const publication = publicationStatement.declarationList.declarations.find(
		(item) => item.name.text === 'publication',
	).initializer
	const shape = ts.isAsExpression(publication) ? publication.expression : publication
	assert(ts.isObjectLiteralExpression(shape), 'publication must be a static object')
	const table = shape.properties.find((item) => item.name?.text === 'commands')?.initializer
	assert(ts.isObjectLiteralExpression(table), 'commands must be a static method table')
	const methodTypes = []
	const references = []
	const sourceFiles = new Set([file])
	const trackedTypes = new Set()
	function trackLocalTypeSources(type, location) {
		if (trackedTypes.has(type)) return
		trackedTypes.add(type)
		for (const declaration of type.symbol?.declarations ?? []) {
			if (declaration.getSourceFile().fileName.startsWith(root + '/'))
				sourceFiles.add(declaration.getSourceFile().fileName)
		}
		if (type.isUnion()) for (const part of type.types) trackLocalTypeSources(part, location)
		if (checker.isArrayType(type))
			for (const part of checker.getTypeArguments(type)) trackLocalTypeSources(part, location)
		if (!(type.flags & ts.TypeFlags.Object)) return
		for (const property of checker.getPropertiesOfType(type)) {
			for (const declaration of property.declarations ?? []) {
				if (declaration.getSourceFile().fileName.startsWith(root + '/'))
					sourceFiles.add(declaration.getSourceFile().fileName)
			}
			trackLocalTypeSources(checker.getTypeOfSymbolAtLocation(property, location), location)
		}
	}
	for (const property of table.properties) {
		assert(
			ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
			'method must be static',
		)
		const methodName = property.name.text
		const commandNode = property.initializer ?? property.name
		const symbol = ts.isShorthandPropertyAssignment(property)
			? checker.getShorthandAssignmentValueSymbol(property)
			: checker.getSymbolAtLocation(commandNode)
		const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
		const commandDeclaration = target.declarations?.find(ts.isVariableDeclaration)
		assert(
			commandDeclaration && ts.isCallExpression(commandDeclaration.initializer),
			'method must reference a direct Command definition',
		)
		const called = checker.getResolvedSignature(commandDeclaration.initializer)?.declaration
		assert(
			called?.getSourceFile().fileName.endsWith('/packages/commands/src/define.ts'),
			'method must call the real defineCommand',
		)
		sourceFiles.add(commandDeclaration.getSourceFile().fileName)
		references.push({
			method: methodName,
			file: relative(root, commandDeclaration.getSourceFile().fileName).replaceAll('\\', '/'),
			export: commandDeclaration.name.text,
		})
		const commandType = checker.getTypeAtLocation(commandNode)
		const execute = checker.getPropertyOfType(commandType, 'execute')
		const signature = checker.getSignaturesOfType(
			checker.getTypeOfSymbolAtLocation(execute, commandNode),
			ts.SignatureKind.Call,
		)[0]
		const wireInput = checker.getTypeOfSymbolAtLocation(signature.parameters[0], commandNode)
		const result = checker.getAwaitedType(signature.getReturnType())
		const ok = result.types?.find((member) => checker.getPropertyOfType(member, 'value'))
		assert(ok, 'Command execute must return Better Result')
		const success = checker.getTypeOfSymbolAtLocation(
			checker.getPropertyOfType(ok, 'value'),
			commandNode,
		)
		trackLocalTypeSources(success, commandNode)
		methodTypes.push({
			method: methodName,
			input: dtoType(checker, wireInput, commandNode),
			success:
				success.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)
					? 'null'
					: dtoType(checker, success, commandNode),
		})
	}
	assert.equal(
		methodTypes.length,
		Object.keys(actual.commands).length,
		'runtime method count must match static table',
	)
	const sources = [...sourceFiles]
		.map((path) => ({
			file: relative(root, path).replaceAll('\\', '/'),
			digest: digest(readFileSync(path)),
		}))
		.sort((left, right) => left.file.localeCompare(right.file))
	return { methodTypes, sources, references }
}

function declarationFor(methods) {
	const source =
		`// Generated from real @pluxel/commands definitions.\n` +
		`export type RpcFailure = { readonly message: string; readonly callId: string; readonly outcome: 'not_started' | 'unknown' } & (\n` +
		`  | { readonly code: 'INPUT_VALIDATION'; readonly issues: readonly { readonly path?: readonly (string | number)[]; readonly code?: string; readonly message: string }[] }\n` +
		`  | { readonly code: 'REJECTED'; readonly reason: string }\n` +
		`  | { readonly code: 'FORBIDDEN' | 'COMMAND_NOT_FOUND' | 'PUBLICATION_GONE' | 'ABORTED' | 'TIMEOUT' | 'DEPENDENCY' | 'INTERNAL' | 'OUTPUT_ENCODING' | 'OUTPUT_LIMIT' }\n` +
		`);\n` +
		`export type RpcResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RpcFailure };\n` +
		`export interface RecordsApi {\n` +
		methods
			.map(
				({ method, input, success }) =>
					`  ${method}(input: ${input}): Promise<RpcResult<${success}>>;`,
			)
			.join('\n') +
		`\n}\n`
	const format = (input) =>
		execFileSync(formatter, ['--stdin-filepath=generated-client.d.ts'], {
			input,
			encoding: 'utf8',
		})
	return format(format(source))
}

function actualBindings(publication) {
	return Object.entries(publication.commands)
		.map(([method, command]) => ({
			method,
			command: command.name,
			description: command.descriptor.description,
			inputSchema: command.descriptor.inputSchema,
		}))
		.sort((left, right) => left.method.localeCompare(right.method))
}

function authorizationHash(id, bindings, methodTypes) {
	return digest({
		format: 'pluxel-rpc-contract-v1',
		protocol,
		publisher: publisherIdentity,
		id,
		methods: bindings.map((item) => ({
			method: item.method,
			command: item.command,
			input: authorizationSchema(item.inputSchema),
			success: methodTypes.find((type) => type.method === item.method)?.success,
		})),
	})
}

function build(publication, entry) {
	const { methodTypes, sources, references } = inspect(entry, publication)
	const bindings = actualBindings(publication)
	for (const item of bindings) assertSchemaSupported(item.inputSchema)
	const declaration = declarationFor(methodTypes)
	const document = {
		format: 'pluxel-rpc-artifact-v1',
		publisher: publisherIdentity,
		protocol,
		id: publication.id,
		methods: bindings,
		types: methodTypes,
		declaration,
		sources,
		references,
		contract: {
			id: publication.id,
			hash: authorizationHash(publication.id, bindings, methodTypes),
		},
	}
	return { ...document, integrity: digest(document) }
}

async function bind(artifact, publication) {
	const { integrity, ...document } = artifact
	if (digest(document) !== integrity) return { ok: false, reason: 'artifact_integrity' }
	for (const source of artifact.sources) {
		const current = digest(readFileSync(resolve(root, source.file)))
		if (current !== source.digest) return { ok: false, reason: 'source_binding' }
	}
	for (const reference of artifact.references) {
		const module = await import(pathToFileURL(resolve(root, reference.file)).href)
		if (module[reference.export] !== publication.commands[reference.method]) {
			return { ok: false, reason: 'command_reference' }
		}
	}
	if (
		artifact.id !== publication.id ||
		stable(artifact.methods) !== stable(actualBindings(publication))
	) {
		return { ok: false, reason: 'runtime_method_table' }
	}
	if (artifact.contract.hash !== authorizationHash(artifact.id, artifact.methods, artifact.types)) {
		return { ok: false, reason: 'contract_hash' }
	}
	return { ok: true, contract: artifact.contract }
}

const artifacts = Object.fromEntries(
	entries.map(([name, publication, entry]) => [name, build(publication, entry)]),
)

assert.deepEqual(await bind(artifacts.baseline, baseline), {
	ok: true,
	contract: artifacts.baseline.contract,
})
const executed = await baseline.commands.write.execute({ id: 'r-1', offset: '2' })
assert(executed.isOk())
assert.deepEqual(executed.value, {
	operationId: 'r-1:2',
	committed: true,
	counts: { accepted: 1, rejected: 0 },
})
const invalid = await baseline.commands.write.execute({ id: 'r-1', offset: 2 })
assert(invalid.isErr())
assert.equal(invalid.error.code, 'INPUT_VALIDATION')
assert.equal(
	artifacts.baseline.methods.find((item) => item.method === 'write').command,
	'records.write',
)
const writeType = artifacts.baseline.types.find((item) => item.method === 'write')
assert.match(writeType.input, /"id": string; "offset": string/)
assert.match(writeType.input, /"description"\?: string/)
assert.match(writeType.success, /"operationId": string; "committed": boolean/)
assert.match(artifacts.baseline.declaration, /write\(input:/)
assert(
	artifacts.baseline.sources.some((source) => source.file === 'provider/dto.ts'),
	'cross-package DTO source must be bound',
)
assert.doesNotMatch(artifacts.baseline.declaration, /RpcResult<Result</)

for (const [label, publication, reason] of [
	['binding', binding, 'command_reference'],
	['method', methodVariant, 'runtime_method_table'],
	['input', inputVariant, 'command_reference'],
	['output', output, 'command_reference'],
]) {
	assert.deepEqual(
		await bind(artifacts.baseline, publication),
		{ ok: false, reason },
		`${label} must reject the stale artifact`,
	)
	assert.notEqual(
		artifacts.baseline.contract.hash,
		artifacts[label].contract.hash,
		`${label} must need new approval`,
	)
}
assert.deepEqual(
	await bind(artifacts.baseline, docs),
	{ ok: false, reason: 'command_reference' },
	'old docs artifact must be refreshed',
)
assert.deepEqual(await bind(artifacts.docs, docs), { ok: true, contract: artifacts.docs.contract })
assert.equal(
	artifacts.baseline.contract.hash,
	artifacts.docs.contract.hash,
	'description-only change retains approval',
)
assert.notEqual(
	artifacts.baseline.integrity,
	artifacts.docs.integrity,
	'description-only change refreshes artifact',
)
assert.notEqual(
	artifacts.baseline.methods.find((item) => item.method === 'write').description,
	artifacts.docs.methods.find((item) => item.method === 'write').description,
)
assert.deepEqual(await bind(artifacts.baseline, implementation), {
	ok: false,
	reason: 'command_reference',
})
assert.deepEqual(await bind(artifacts.implementation, implementation), {
	ok: true,
	contract: artifacts.implementation.contract,
})
assert.equal(
	artifacts.baseline.contract.hash,
	artifacts.implementation.contract.hash,
	'implementation change is publisher responsibility',
)
assert.notEqual(artifacts.baseline.integrity, artifacts.implementation.integrity)

const businessDefault = structuredClone(artifacts.baseline.methods)
businessDefault.find((item) => item.method === 'write').inputSchema.properties.description.default =
	'changed business value'
assert.notEqual(
	artifacts.baseline.contract.hash,
	authorizationHash(baseline.id, businessDefault, artifacts.baseline.types),
)
const changedDescriptionKey = structuredClone(artifacts.baseline.methods)
changedDescriptionKey.find(
	(item) => item.method === 'write',
).inputSchema.properties.description.type = 'number'
assert.notEqual(
	artifacts.baseline.contract.hash,
	authorizationHash(baseline.id, changedDescriptionKey, artifacts.baseline.types),
)
assert.deepEqual(
	authorizationSchema({
		description: 'schema annotation',
		const: { description: 'business data' },
	}),
	{ const: { description: 'business data' } },
)
const tampered = structuredClone(artifacts.baseline)
tampered.declaration = 'export type Unsafe = any'
assert.deepEqual(await bind(tampered, baseline), { ok: false, reason: 'artifact_integrity' })
const sameDescriptorImpostor = {
	...baseline,
	commands: { ...baseline.commands, write: { ...baseline.commands.write } },
}
assert.deepEqual(await bind(artifacts.baseline, sameDescriptorImpostor), {
	ok: false,
	reason: 'command_reference',
})

writeFileSync(resolve(root, 'generated-client.d.ts'), artifacts.baseline.declaration)
writeFileSync(
	resolve(root, 'artifact.json'),
	execFileSync(formatter, ['--stdin-filepath=artifact.json'], {
		input: `${JSON.stringify(artifacts.baseline, null, 2)}\n`,
		encoding: 'utf8',
	}),
)
console.log(
	JSON.stringify(
		{
			generated: 'generated-client.d.ts',
			baselineHash: artifacts.baseline.contract.hash,
			docsHash: artifacts.docs.contract.hash,
			staleBindingRejected: true,
			staleMethodRejected: true,
			staleInputRejected: true,
			staleOutputRejected: true,
			staleImplementationRejected: true,
			docsArtifactRefreshed: true,
		},
		null,
		2,
	),
)

export { artifacts, build, inspect }
