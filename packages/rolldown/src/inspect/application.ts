import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import { parsePluginControlDescriptor } from '@pluxel/core/internal/control-manifest'
import {
	collectConfigSchemaModule,
	createConfigSchemaSourceResolver,
	type ConfigSourceSymbol,
} from '../rolldown/plugins/configSourcePlugin.ts'
import {
	parseStandaloneWithLang,
	readIdentifier,
	readLiteralString,
	type AstNode,
} from '../rolldown/plugins/pluginUtils.ts'
import {
	readApplicationDeclaration,
	readApplicationBinding,
	readApplicationBindingArray,
	readApplicationNodes,
	resolveApplicationNodeOwner,
	readBindingDescriptor,
	readBindingNamespace,
	registerConfigBindingPaths,
	parseDirectMapping,
	unwrapExpression,
} from '../rolldown/plugins/staticConfigEnvironment.ts'
import type {
	InspectionInputs,
	InspectionSection,
	InspectionSourceLocation,
	InspectionDiagnostic,
	InspectionConfigBinding,
} from './contracts.ts'

class DeclarationGap extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly node?: AstNode,
		readonly file?: string,
	) {
		super(message)
	}
}

/** Application source navigation uses the build parser's declarations, never schema restoration. */
export async function inspectApplicationInputs(options: {
	application: InspectionInputs['application']
	read(id: string): Promise<string>
	resolve(source: string, importer: string): Promise<string | undefined>
	definition: PluginDefinitionAddress
	matchesPlugin(symbol: ConfigSourceSymbol): Promise<boolean>
	location(id: string, start: number, end: number): InspectionSourceLocation
	signal?: AbortSignal
}): Promise<InspectionSection<InspectionInputs>> {
	const { application, read, resolve, definition, matchesPlugin, location, signal } = options
	const id = application.entry
	const code = await read(id)
	const ast = parseStandaloneWithLang(code, id, { cache: false })
	const loc = (node: AstNode, file = id) => location(file, Number(node.start), Number(node.end))
	const gaps: InspectionDiagnostic[] = []
	const diagnostic = (failure: unknown, node?: AstNode, file = id): InspectionDiagnostic => {
		if (!(failure instanceof DeclarationGap)) throw failure
		const position = failure.node ?? node
		const source = failure.file ?? file
		return {
			code: failure.code,
			message: failure.message,
			file: source,
			...(position ? { location: loc(position, source) } : {}),
		}
	}
	const fail = (message: string): never => {
		throw new DeclarationGap('invalid_declaration', message)
	}
	const unsupported = (
		message: string,
		detail?: { code: string; node?: AstNode; file?: string },
	): never => {
		throw new DeclarationGap(
			detail?.code ?? 'unsupported_expression',
			message,
			detail?.node,
			detail?.file,
		)
	}
	if (!ast)
		return {
			status: 'unavailable',
			reason: { code: 'invalid_declaration', message: 'Cannot parse application entry.', file: id },
		}
	let declaration: ReturnType<typeof readApplicationDeclaration>
	try {
		declaration = readApplicationDeclaration({ ast, code, id, error: unsupported })
	} catch (failure) {
		return { status: 'unavailable', reason: diagnostic(failure, ast as unknown as AstNode) }
	}
	// Resolver deliberately receives the query's observed read set and budget owner.
	let readFailure: unknown
	const resolver = createConfigSchemaSourceResolver(
		{
			async resolve(source, importer) {
				signal?.throwIfAborted()
				if (!importer) return null
				let resolved: string | undefined
				try {
					resolved = await resolve(source, importer)
				} catch (failure) {
					readFailure = failure
					throw failure
				}
				return resolved
					? { id: resolved, external: false, moduleSideEffects: null, meta: {} }
					: null
			},
		},
		async (file) => {
			try {
				return await read(file)
			} catch (failure) {
				readFailure = failure
				throw failure
			}
		},
		{ cache: false },
	)
	const checked = async <T>(promise: Promise<T>): Promise<T> => {
		const value = await promise
		signal?.throwIfAborted()
		if (readFailure) throw readFailure
		return value
	}
	const bindings: InspectionConfigBinding[] = []
	const seen = new Map<string, readonly (readonly string[])[]>()
	const nodes = await checked(
		readApplicationNodes({
			...declaration,
			sourceResolver: resolver,
			error: unsupported,
			recover(failure, file, node) {
				gaps.push(diagnostic(failure, node, file))
			},
		}),
	)
	let config: InspectionSourceLocation | null = null
	const matches = new Map<AstNode, string | null>()
	const definitionKey = pluginDefinitionIndexKey(definition)
	const sameDefinition = (address: PluginDefinitionAddress): boolean =>
		pluginDefinitionIndexKey(address) === definitionKey
	for (const node of nodes) {
		signal?.throwIfAborted()
		const { fields, module } = node
		const file = module.id
		const declared = node.forkId === undefined ? fields.get('config')?.value : undefined
		if (!declared && !fields.has('envBindings') && !fields.has('fileBindings')) continue
		let owner: { name: string }
		try {
			if (!matches.has(node.selector)) {
				const candidate = await checked(resolveApplicationNodeOwner(node, resolver, unsupported))
				let selected: boolean
				if (candidate.kind === 'literal') selected = sameDefinition(candidate.definition)
				else {
					const control =
						candidate.kind === 'reference'
							? await readControlDefinition(candidate.symbol, read)
							: undefined
					selected = control ? sameDefinition(control) : await matchesPlugin(candidate.symbol)
				}
				matches.set(node.selector, selected ? candidate.name : null)
			}
			const name = matches.get(node.selector)
			if (!name) continue
			owner = { name }
		} catch (failure) {
			if (failure instanceof DeclarationGap) {
				gaps.push(diagnostic(failure, node.selector, file))
				continue
			}
			if (
				!(failure instanceof Error) ||
				!('code' in failure) ||
				failure.code !== 'unresolved_symbol'
			)
				throw failure
			gaps.push(
				diagnostic(new DeclarationGap('unresolved_symbol', failure.message), node.selector, file),
			)
			continue
		}
		if (declared) config = loc(declared, file)
		for (const kind of ['env', 'file'] as const) {
			let array: readonly (AstNode | null)[]
			try {
				array = readApplicationBindingArray(node, kind, unsupported)
			} catch (failure) {
				gaps.push(diagnostic(failure, fields.get(`${kind}Bindings`)?.value, file))
				continue
			}
			for (const [index, binding] of array.entries()) {
				const label = `${node.label}.${kind}Bindings[${index}]`
				let bindingFields: ReturnType<typeof readApplicationBinding>
				try {
					bindingFields = readApplicationBinding(binding, kind, label, module, unsupported)
				} catch (failure) {
					gaps.push(diagnostic(failure, binding ?? fields.get(`${kind}Bindings`)?.value, file))
					continue
				}
				const descriptor = bindingFields.get('config')?.value
				if (!descriptor) continue
				try {
					readBindingNamespace(bindingFields, label, file, unsupported)
					const { schemaExpression, source } = readBindingDescriptor(
						unwrapExpression(descriptor),
						kind,
						'config',
						file,
						unsupported,
					)
					const unwrapped = unwrapExpression(schemaExpression)
					const inline = !['Identifier', 'MemberExpression'].includes(String(unwrapped.type))
					const schemaSymbol = await checked(resolver.resolveSymbol(module, unwrapped))
					let schemaDeclaration: InspectionSourceLocation | null = inline
						? loc(schemaExpression, file)
						: null
					if (schemaSymbol) {
						const schemaCode = await read(schemaSymbol.moduleId)
						const schemaAst = parseStandaloneWithLang(schemaCode, schemaSymbol.moduleId, {
							cache: false,
						})
						const schemaNode = schemaAst
							? collectConfigSchemaModule(
									schemaAst,
									schemaCode,
									schemaSymbol.moduleId,
								).declarations.get(schemaSymbol.local)
							: undefined
						if (schemaNode)
							schemaDeclaration = location(
								schemaSymbol.moduleId,
								Number(schemaNode.start),
								Number(schemaNode.end),
							)
					}
					if (!schemaDeclaration)
						gaps.push(
							diagnostic(
								new DeclarationGap(
									'unresolved_symbol',
									'Cannot locate binding schema declaration.',
								),
								schemaExpression,
								file,
							),
						)
					const schema = {
						expression: module.code.slice(
							Number(schemaExpression.start),
							Number(schemaExpression.end),
						),
						usage: loc(schemaExpression, file),
						declaration: schemaDeclaration,
						symbol: schemaSymbol?.local ?? null,
					}
					if (kind === 'env') {
						const leaves = parseDirectMapping(
							source,
							[],
							'config mapping',
							file,
							unsupported,
							(failure, expression) => gaps.push(diagnostic(failure, expression, file)),
						)
						registerConfigBindingPaths(
							seen,
							JSON.stringify([kind, node.forkId ?? null]),
							leaves.map((leaf) => leaf.path),
							owner.name,
							file,
							unsupported,
						)
						for (const leaf of leaves)
							bindings.push({
								...(node.forkId === undefined ? {} : { forkId: node.forkId }),
								configPath: leaf.path,
								declaration: loc(binding!, file),
								schema,
								source: { kind, name: leaf.environmentName, usage: loc(leaf.node, file) },
							})
					} else {
						const path = readLiteralString(source)
						if (path === undefined)
							unsupported('Config file path must be a literal string.', {
								code: 'unsupported_expression',
								node: source,
							})
						if (!path || path.includes('\0'))
							fail('Config file path must be nonempty and contain no null character.')
						bindings.push({
							...(node.forkId === undefined ? {} : { forkId: node.forkId }),
							configPath: [],
							declaration: loc(binding!, file),
							schema,
							source: { kind, path, usage: loc(source, file) },
						})
					}
				} catch (failure) {
					gaps.push(diagnostic(failure, descriptor, file))
				}
			}
		}
	}

	bindings.sort(
		(a, b) =>
			a.declaration.file.localeCompare(b.declaration.file) ||
			a.declaration.start.line - b.declaration.start.line ||
			a.declaration.start.column - b.declaration.start.column ||
			JSON.stringify(a.configPath).localeCompare(JSON.stringify(b.configPath)),
	)
	const value = { application, bindings, config }
	return gaps.length > 0 ? { status: 'partial', value, gaps } : { status: 'complete', value }
}

/** Read the canonical definition of the generated control reference without importing it. */
async function readControlDefinition(
	symbol: ConfigSourceSymbol,
	read: (id: string) => Promise<string>,
): Promise<PluginDefinitionAddress | undefined> {
	const code = await read(symbol.moduleId)
	const ast = parseStandaloneWithLang(code, symbol.moduleId, { cache: false })
	if (!ast) return undefined
	const module = collectConfigSchemaModule(ast, code, symbol.moduleId)
	const reference = module.declarations.get(symbol.local)
	if (reference?.type !== 'CallExpression') return undefined
	const helper = readIdentifier(reference.callee)
	const binding = helper ? module.imports.get(helper) : undefined
	if (
		binding?.source !== '@pluxel/host/internal/control-reference' ||
		binding.imported !== 'createPluginControlReference' ||
		binding.namespace
	)
		return undefined
	const args = reference.arguments as AstNode[]
	if (args.length !== 1) return undefined
	const input = args[0]!
	try {
		return parsePluginControlDescriptor(
			JSON.parse(code.slice(Number(input.start), Number(input.end))),
		).definition
	} catch (cause) {
		throw Object.assign(new Error('Cannot read generated Plugin control definition.', { cause }), {
			code: 'unresolved_symbol',
		})
	}
}
