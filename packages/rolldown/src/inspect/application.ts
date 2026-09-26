import {
	collectConfigSchemaModule,
	createConfigSchemaSourceResolver,
	type ConfigSourceSymbol,
} from '../rolldown/plugins/configSourcePlugin.ts'
import {
	parseStandaloneWithLang,
	readLiteralString,
	type AstNode,
} from '../rolldown/plugins/pluginUtils.ts'
import {
	readApplicationDeclaration,
	readApplicationBinding,
	readBindingDescriptor,
	readBindingNamespace,
	registerBindingTarget,
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
	) {
		super(message)
	}
}

/** Application source navigation uses the build parser's declarations, never schema restoration. */
export async function inspectApplicationInputs(options: {
	application: InspectionInputs['application']
	read(id: string): Promise<string>
	resolve(source: string, importer: string): Promise<string | undefined>
	matchesPlugin(symbol: ConfigSourceSymbol): Promise<boolean>
	location(id: string, start: number, end: number): InspectionSourceLocation
	signal?: AbortSignal
}): Promise<InspectionSection<InspectionInputs>> {
	const { application, read, resolve, matchesPlugin, location, signal } = options
	const id = application.entry
	const code = await read(id)
	const ast = parseStandaloneWithLang(code, id, { cache: false })
	const loc = (node: AstNode) => location(id, Number(node.start), Number(node.end))
	const gaps: InspectionDiagnostic[] = []
	const diagnostic = (failure: unknown, node?: AstNode): InspectionDiagnostic => {
		if (!(failure instanceof DeclarationGap)) throw failure
		const position = failure.node ?? node
		return {
			code: failure.code,
			message: failure.message,
			file: id,
			...(position ? { location: loc(position) } : {}),
		}
	}
	const fail = (message: string): never => {
		throw new DeclarationGap('invalid_declaration', message)
	}
	const unsupported = (message: string, detail?: { code: string; node?: AstNode }): never => {
		throw new DeclarationGap(detail?.code ?? 'unsupported_expression', message, detail?.node)
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
	const { module, fields } = declaration
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
	const seen = new Set<string>()
	for (const kind of ['env', 'file'] as const) {
		const expression = fields.get(`${kind}Bindings`)?.value
		if (!expression) continue
		if (expression.type !== 'ArrayExpression') {
			gaps.push(
				diagnostic(
					new DeclarationGap(
						'unsupported_expression',
						`${kind}Bindings must be a direct array literal.`,
					),
					expression,
				),
			)
			continue
		}
		for (const [index, raw] of (expression.elements as (AstNode | null)[]).entries()) {
			signal?.throwIfAborted()
			const binding = raw ? unwrapExpression(raw) : undefined
			let target: ReturnType<typeof readApplicationBinding>
			try {
				target = readApplicationBinding(binding, kind, index, module, id, unsupported)
			} catch (failure) {
				gaps.push(diagnostic(failure, binding ?? expression))
				continue
			}
			const symbol = await checked(resolver.resolveSymbol(module, target.pluginNode))
			if (!symbol) {
				gaps.push(
					diagnostic(
						new DeclarationGap('unresolved_symbol', 'Cannot resolve binding Plugin target.'),
						target.pluginNode,
					),
				)
				continue
			}
			try {
				if (!(await matchesPlugin(symbol))) continue
			} catch (failure) {
				if (
					!(failure instanceof Error) ||
					!('code' in failure) ||
					failure.code !== 'unresolved_symbol'
				)
					throw failure
				gaps.push(
					diagnostic(new DeclarationGap('unresolved_symbol', failure.message), target.pluginNode),
				)
				continue
			}
			const descriptor = target.bindingFields.get('config')?.value
			if (!descriptor) continue
			try {
				registerBindingTarget(seen, kind, target.pluginName, id, unsupported)
				readBindingNamespace(target.bindingFields, kind, index, id, unsupported)
				const { schemaExpression, source } = readBindingDescriptor(
					descriptor,
					kind,
					'config',
					id,
					unsupported,
				)
				const unwrapped = unwrapExpression(schemaExpression)
				const inline = !['Identifier', 'MemberExpression'].includes(String(unwrapped.type))
				const schemaSymbol = await checked(resolver.resolveSymbol(module, unwrapped))
				let schemaDeclaration: InspectionSourceLocation | null = inline
					? loc(schemaExpression)
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
							new DeclarationGap('unresolved_symbol', 'Cannot locate binding schema declaration.'),
							schemaExpression,
						),
					)
				const schema = {
					expression: code.slice(Number(schemaExpression.start), Number(schemaExpression.end)),
					usage: loc(schemaExpression),
					declaration: schemaDeclaration,
					symbol: schemaSymbol?.local ?? null,
				}
				if (kind === 'env') {
					const leaves = parseDirectMapping(
						source,
						[],
						'config mapping',
						id,
						unsupported,
						(failure, node) => gaps.push(diagnostic(failure, node)),
					)
					for (const leaf of leaves)
						bindings.push({
							configPath: leaf.path,
							declaration: loc(binding!),
							schema,
							source: { kind, name: leaf.environmentName, usage: loc(leaf.node) },
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
						configPath: [],
						declaration: loc(binding!),
						schema,
						source: { kind, path, usage: loc(source) },
					})
				}
			} catch (failure) {
				gaps.push(diagnostic(failure, descriptor))
			}
		}
	}
	bindings.sort(
		(a, b) =>
			a.declaration.start.line - b.declaration.start.line ||
			a.declaration.start.column - b.declaration.start.column ||
			JSON.stringify(a.configPath).localeCompare(JSON.stringify(b.configPath)),
	)
	const records = fields.get('configRecords')?.value
	const value = { application, configRecords: records ? loc(records) : null, bindings }
	return gaps.length > 0 ? { status: 'partial', value, gaps } : { status: 'complete', value }
}
