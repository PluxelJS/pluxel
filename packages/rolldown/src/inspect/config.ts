import { createReadStream } from 'node:fs'
import {
	collectConfigSchemaModule,
	createConfigSchemaSourceResolver,
	extractConfigDeclarations,
	type ConfigSchemaModule,
} from '../rolldown/plugins/configSourcePlugin.ts'
import { type AstNode, parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'

type SourceFile = { readonly id: string; readonly code: string }
type SourceRange = { readonly moduleId: string; readonly start: number; readonly end: number }
type OwnerConfig = SourceRange & {
	readonly className: string
	readonly fieldName: string
	readonly schema: SourceRange & {
		readonly expression: string
		readonly inline: boolean
		readonly declaration?: SourceRange & { readonly symbol: string }
	}
}
type Diagnostic = { readonly code: string; readonly message: string; readonly file?: string }

/** Uses the compiler's declaration validator without rendering or executing schema expressions. */
export async function inspectOwnerConfigs(
	files: readonly SourceFile[],
	resolve: (source: string, importer: string) => Promise<string | undefined>,
	options: { readonly signal?: AbortSignal } = {},
): Promise<{
	declarations: readonly OwnerConfig[]
	diagnostics: readonly Diagnostic[]
	files: readonly SourceFile[]
}> {
	const observed = new Map(files.map((file) => [file.id, file]))
	const modules = new Map<string, ConfigSchemaModule>()
	const diagnostics: Diagnostic[] = []
	const declarations: OwnerConfig[] = []
	let sourceBytes = [...observed.values()].reduce(
		(bytes, file) => bytes + Buffer.byteLength(file.code),
		0,
	)
	const maxBytes = 32 * 1024 * 1024
	let readFailure: Error | undefined
	const check = () => options.signal?.throwIfAborted()
	check()
	if (observed.size > 4096 || sourceBytes > maxBytes)
		throw sourceBudgetError('Inspection source budget exceeded (4096 files / 32 MiB).')
	const readSource = async (id: string): Promise<string> => {
		check()
		const known = observed.get(id)
		if (known) return known.code
		if (observed.size >= 4096) {
			readFailure = sourceBudgetError('Inspection source file budget exceeded (4096 files).')
			throw readFailure
		}
		const stream = createReadStream(id, { signal: options.signal, highWaterMark: 64 * 1024 })
		const chunks: Buffer[] = []
		let bytes = 0
		try {
			for await (const chunk of stream) {
				const buffer = chunk as Buffer
				bytes += buffer.byteLength
				if (sourceBytes + bytes > maxBytes) {
					readFailure = sourceBudgetError('Inspection source byte budget exceeded (32 MiB).')
					throw readFailure
				}
				chunks.push(buffer)
			}
		} finally {
			stream.destroy()
		}
		const code = Buffer.concat(chunks, bytes).toString('utf8')
		sourceBytes += bytes
		check()
		observed.set(id, { id, code })
		return code
	}
	const resolver = createConfigSchemaSourceResolver(
		{
			async resolve(source, importer) {
				check()
				if (!importer) return null
				const id = await resolve(source, importer)
				check()
				return id ? { id, external: false, moduleSideEffects: null, meta: {} } : null
			},
		},
		readSource,
		{ cache: false },
	)
	const getModule = (file: SourceFile): ConfigSchemaModule | undefined => {
		let module = modules.get(file.id)
		if (module) return module
		const ast = parseStandaloneWithLang(file.code, file.id, { cache: false })
		if (!ast) return undefined
		module = collectConfigSchemaModule(ast, file.code, file.id)
		modules.set(file.id, module)
		return module
	}
	for (const file of files) {
		check()
		const ast = parseStandaloneWithLang(file.code, file.id, { cache: false })
		if (!ast) {
			diagnostics.push({
				code: 'config_parse_failed',
				message: 'Cannot parse config declarations.',
				file: file.id,
			})
			continue
		}
		const expressions: { module: ConfigSchemaModule; expression: AstNode }[] = []
		try {
			const found = await extractConfigDeclarations(
				ast,
				file.code,
				file.id,
				{
					...resolver,
					async render(module, expression) {
						expressions.push({ module, expression })
						return module.code.slice(Number(expression.start), Number(expression.end))
					},
				},
				(message) => {
					throw new Error(message)
				},
			)
			for (const [index, config] of found.entries()) {
				check()
				const { module, expression } = expressions[index]!
				const start = Number(expression.start)
				const end = Number(expression.end)
				const owner =
					module.classes.get(config.className) ??
					ast.body
						.map((statement) => statement as unknown as AstNode)
						.map((statement) =>
							statement.type === 'ExportDefaultDeclaration'
								? (statement.declaration as AstNode)
								: statement,
						)
						.find(
							(statement) =>
								statement.type === 'ClassDeclaration' &&
								(statement.id as AstNode | undefined)?.name === config.className,
						)
				const members = (owner?.body as AstNode | undefined)?.body
				const field = Array.isArray(members)
					? (members.find(
							(member: AstNode) =>
								member.type === 'PropertyDefinition' &&
								Number(member.start) <= start &&
								Number(member.end) >= end,
						) as AstNode | undefined)
					: undefined
				let declaration: OwnerConfig['schema']['declaration']
				let unwrapped = expression
				while (
					[
						'TSAsExpression',
						'TSSatisfiesExpression',
						'TSNonNullExpression',
						'ParenthesizedExpression',
					].includes(String(unwrapped.type))
				) {
					unwrapped = unwrapped.expression as AstNode
				}
				const inline = unwrapped.type !== 'Identifier' && unwrapped.type !== 'MemberExpression'
				const symbol = await resolver.resolveSymbol(module, unwrapped)
				check()
				if (readFailure) throw readFailure
				if (symbol) {
					const targetFile = observed.get(symbol.moduleId)
					const target = targetFile
						? getModule(targetFile)?.declarations.get(symbol.local)
						: undefined
					if (target && typeof target.start === 'number' && typeof target.end === 'number') {
						declaration = {
							moduleId: symbol.moduleId,
							symbol: symbol.local,
							start: target.start,
							end: target.end,
						}
					}
				}
				if (!declaration && !inline) {
					diagnostics.push({
						code: 'config_schema_unresolved',
						message: `Cannot locate schema declaration for ${config.className}.${config.fieldName}.`,
						file: file.id,
					})
				}
				declarations.push({
					moduleId: file.id,
					className: config.className,
					fieldName: config.fieldName,
					start: Number(field?.start ?? start),
					end: Number(field?.end ?? end),
					schema: {
						moduleId: file.id,
						start,
						end,
						expression: config.schemaExpression,
						inline,
						...(declaration ? { declaration } : {}),
					},
				})
			}
		} catch (error) {
			check()
			if (readFailure) throw readFailure
			diagnostics.push({
				code: 'config_declaration_invalid',
				message: error instanceof Error ? error.message : String(error),
				file: file.id,
			})
		}
	}
	return { declarations, diagnostics, files: [...observed.values()] }
}

function sourceBudgetError(message: string): Error {
	return Object.assign(new Error(message), { code: 'analysis_unavailable' })
}
