/**
 * Extracts the single Plugin config declaration before TypeScript class fields are lowered.
 *
 * The authoring contract is intentionally narrow: a concrete marked Plugin may declare at most
 * one non-#private class field initialized by `this.configs.use(ObjectSchema)`. A PluginPart uses
 * the same authoring shape and lowers to Part-owned metadata. The runtime helper
 * performs the final Standard Schema/ObjectSchema validation while this pass owns declaration
 * shape, cardinality and source capture. There is no Config decorator or cfg/layout protocol.
 */
import { readFile } from 'node:fs/promises'
import type { Program } from 'oxc-parser'
import type { TransformPluginContext } from 'rolldown'
import { normalizeSchemaSource } from '../utils/configHandler.ts'
import { allowOptionalQuerySuffix, type ViteCompatPlugin } from './compat.ts'
import {
	type AstNode,
	normalizePatterns,
	parseStandaloneWithLang,
	parseWithLang,
	readIdentifier,
	readLiteralString,
} from './pluginUtils.ts'

export interface ConfigSourcePluginOptions {
	include?: string | string[]
	exclude?: string | string[]
	/** @default '@pluxel/runtime' */
	metadataHelperImportSource?: string
}

type ImportBinding = {
	readonly source: string
	readonly imported: string
	readonly namespace: boolean
}

type ConfigDeclaration = {
	readonly className: string
	readonly fieldName: string
	readonly schemaExpression: string
	readonly source: string
	readonly target: 'plugin' | 'part'
}

type SourceExport =
	| { readonly kind: 'local'; readonly local: string }
	| { readonly kind: 'reexport'; readonly source: string; readonly imported: string }

type SchemaModule = {
	readonly id: string
	readonly code: string
	readonly imports: ReadonlyMap<string, ImportBinding>
	readonly declarations: ReadonlyMap<string, AstNode>
	readonly exports: ReadonlyMap<string, SourceExport>
}

type SchemaSourceResolver = {
	render(module: SchemaModule, expression: AstNode): Promise<string>
}

const AUTHORING_PACKAGES = new Set([
	'@pluxel/core',
	'@pluxel/core/test',
	'@pluxel/runtime',
	'@pluxel/runtime/test',
	'@pluxel/test',
])
const DEFAULT_METADATA_HELPER_IMPORT_SOURCE = '@pluxel/runtime'

export function configSourcePlugin(options: ConfigSourcePluginOptions = {}): ViteCompatPlugin {
	const helperSource =
		options.metadataHelperImportSource?.trim() || DEFAULT_METADATA_HELPER_IMPORT_SOURCE
	const include = normalizePatterns(options.include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
	]).map(allowOptionalQuerySuffix)
	const exclude = normalizePatterns(options.exclude, [
		'**/node_modules/**',
		'**/*.d.ts',
		'**/*.d.mts',
		'**/*.d.cts',
	]).map(allowOptionalQuerySuffix)

	return {
		name: 'pluxel-config-source',
		enforce: 'pre',
		transform: {
			filter: { id: { include, exclude } },
			async handler(this: TransformPluginContext, code, id) {
				if (code.includes('// [pluxel-config] Injected definition')) return null
				if (!/\.configs\.use\s*\(|\b(?:Config|cfg)\b/.test(code)) {
					return null
				}
				const ast = parseWithLang(this, code, id)
				if (!ast) this.error(`[pluxel-config] failed to parse ${id}`)
				const removed = removedConfigDsl(ast)
				if (removed) {
					this.error(
						`[pluxel-config] ${id} uses removed ${removed} authoring DSL; use one Plugin field initialized with this.configs.use(ObjectSchema)`,
					)
				}
				const declarations = await extractDeclarations(
					ast,
					code,
					id,
					createSchemaSourceResolver(this),
					(message) => this.error(message),
				)
				if (declarations.length === 0) return null
				const hasPluginConfigs = declarations.some((item) => item.target === 'plugin')
				const hasPartConfigs = declarations.some((item) => item.target === 'part')
				const imports = [
					hasPluginConfigs ? '__setPluginConfig as __pluxelSetPluginConfig' : undefined,
					hasPartConfigs ? '__setPluginPartConfig as __pluxelSetPluginPartConfig' : undefined,
				].filter((value): value is string => Boolean(value))
				const lines = [
					'// [pluxel-config] Injected definition',
					`import { ${imports.join(', ')} } from ${JSON.stringify(helperSource)};`,
				]
				for (const declaration of declarations) {
					const helper =
						declaration.target === 'plugin'
							? '__pluxelSetPluginConfig'
							: '__pluxelSetPluginPartConfig'
					lines.push(
						`${helper}(${declaration.className}, { fieldName: ${JSON.stringify(declaration.fieldName)}, schema: ${declaration.schemaExpression}, source: ${JSON.stringify(declaration.source)} });`,
					)
				}
				return { code: `${code}\n${lines.join('\n')}\n`, map: null }
			},
		},
	}
}

function removedConfigDsl(ast: Program): 'Config' | 'cfg' | undefined {
	const imports = collectImports(ast)
	let removed: 'Config' | 'cfg' | undefined
	walkAst(ast as unknown as AstNode, (node) => {
		if (removed) return
		const expression =
			node.type === 'CallExpression'
				? (node.callee as AstNode | undefined)
				: node.type === 'TaggedTemplateExpression'
					? (node.tag as AstNode | undefined)
					: node.type === 'Decorator'
						? (node.expression as AstNode | undefined)
						: undefined
		const helper = authoringHelperName(expression, imports)
		if (helper === 'Config' || helper === 'cfg') removed = helper
	})
	return removed
}

function authoringHelperName(
	expression: AstNode | undefined,
	imports: ReadonlyMap<string, ImportBinding>,
): string | undefined {
	if (!expression) return undefined
	const target =
		expression.type === 'CallExpression' ? (expression.callee as AstNode | undefined) : expression
	if (target?.type === 'Identifier') {
		const binding = imports.get(readIdentifier(target) ?? '')
		return binding && !binding.namespace && AUTHORING_PACKAGES.has(binding.source)
			? binding.imported
			: undefined
	}
	if (target?.type !== 'MemberExpression') return undefined
	const binding = imports.get(readIdentifier(target.object) ?? '')
	return binding?.namespace && AUTHORING_PACKAGES.has(binding.source)
		? propertyName(target.property)
		: undefined
}

function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
	visit(node)
	for (const value of Object.values(node)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === 'object' && typeof (item as AstNode).type === 'string') {
					walkAst(item as AstNode, visit)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && typeof (value as AstNode).type === 'string') {
			walkAst(value as AstNode, visit)
		}
	}
}

async function extractDeclarations(
	ast: Program,
	code: string,
	id: string,
	sourceResolver: SchemaSourceResolver,
	error: (message: string) => never,
): Promise<ConfigDeclaration[]> {
	const imports = collectImports(ast)
	const module = collectSchemaModule(ast, code, id)
	const out: ConfigDeclaration[] = []
	for (const statement of ast.body ?? []) {
		const top = statement as unknown as AstNode
		const node =
			top.type === 'ExportNamedDeclaration' || top.type === 'ExportDefaultDeclaration'
				? (top.declaration as AstNode | undefined)
				: top
		if (node?.type !== 'ClassDeclaration') continue
		const className = readIdentifier(node.id)
		if (!className) continue
		const marked = hasPluginMarker(node, imports)
		const part = extendsPluginPart(node, imports)
		const declarations: ConfigDeclaration[] = []
		for (const rawMember of arrayOf((node.body as AstNode | undefined)?.body)) {
			const member = rawMember as AstNode
			if (member.type !== 'PropertyDefinition') continue
			const use = configsUse(member.value)
			if (!use) continue
			if (!marked && !part) {
				error(
					`[pluxel-config] ${id} ${className} declares config but is not a concrete @Plugin or PluginPart`,
				)
			}
			if ((member.key as AstNode | undefined)?.type === 'PrivateIdentifier') {
				error(`[pluxel-config] ${id} ${className} config field must not use #private syntax`)
			}
			const fieldName = propertyName(member.key)
			if (!fieldName) {
				error(`[pluxel-config] ${id} ${className} config field name must be static`)
			}
			const args = arrayOf(use.arguments)
			if (args.length !== 1 || (args[0] as AstNode).type === 'SpreadElement') {
				error(`[pluxel-config] ${id} ${className}.${fieldName} expects configs.use(ObjectSchema)`)
			}
			const schema = args[0] as AstNode
			if (isClearlyNonObjectSchema(schema, imports)) {
				error(`[pluxel-config] ${id} ${className}.${fieldName} must use a valibot ObjectSchema`)
			}
			const start = position(schema.start, error, `${className}.${fieldName} schema start`)
			const end = position(schema.end, error, `${className}.${fieldName} schema end`)
			const schemaExpression = code.slice(start, end)
			if (!schemaExpression.trim()) {
				error(`[pluxel-config] ${id} ${className}.${fieldName} schema is empty`)
			}
			declarations.push({
				className,
				fieldName,
				schemaExpression,
				source: await sourceResolver.render(module, schema),
				target: marked ? 'plugin' : 'part',
			})
		}
		if (declarations.length > 1) {
			error(
				`[pluxel-config] ${id} ${className} declares ${declarations.length} configs.use() fields; each Plugin or PluginPart may declare at most one ObjectSchema`,
			)
		}
		out.push(...declarations)
	}
	return out
}

function extendsPluginPart(node: AstNode, imports: ReadonlyMap<string, ImportBinding>): boolean {
	const name = readIdentifier(node.superClass)
	if (!name) return false
	const binding = imports.get(name)
	return Boolean(
		binding &&
		!binding.namespace &&
		binding.imported === 'PluginPart' &&
		AUTHORING_PACKAGES.has(binding.source),
	)
}

function collectSchemaModule(ast: Program, code: string, id: string): SchemaModule {
	const declarations = new Map<string, AstNode>()
	const exports = new Map<string, SourceExport>()
	const collectVariables = (declaration: AstNode | undefined, exported: boolean) => {
		if (declaration?.type !== 'VariableDeclaration') return
		for (const rawItem of arrayOf(declaration.declarations)) {
			const item = rawItem as AstNode
			const name = readIdentifier(item.id)
			const init = item.init as AstNode | undefined
			if (!name || !init) continue
			declarations.set(name, init)
			if (exported) exports.set(name, { kind: 'local', local: name })
		}
	}

	for (const statement of ast.body ?? []) {
		const node = statement as unknown as AstNode
		if (node.type === 'VariableDeclaration') {
			collectVariables(node, false)
			continue
		}
		if (node.type === 'ExportDefaultDeclaration') {
			const declaration = node.declaration as AstNode | undefined
			const local = readIdentifier(declaration)
			if (local) {
				exports.set('default', { kind: 'local', local })
			} else if (declaration && typeof declaration.start === 'number') {
				const defaultLocal = '__pluxel_default_schema__'
				declarations.set(defaultLocal, declaration)
				exports.set('default', { kind: 'local', local: defaultLocal })
			}
			continue
		}
		if (node.type !== 'ExportNamedDeclaration') continue
		collectVariables(node.declaration as AstNode | undefined, true)
		const source = readLiteralString(node.source)
		for (const rawSpecifier of arrayOf(node.specifiers)) {
			const specifier = rawSpecifier as AstNode
			const exported = propertyName(specifier.exported)
			const local = propertyName(specifier.local)
			if (!exported || !local) continue
			exports.set(
				exported,
				source ? { kind: 'reexport', source, imported: local } : { kind: 'local', local },
			)
		}
	}

	return { id, code, imports: collectImports(ast), declarations, exports }
}

function createSchemaSourceResolver(context: TransformPluginContext): SchemaSourceResolver {
	const modules = new Map<string, Promise<SchemaModule | undefined>>()
	const pending = new Set<string>()

	const loadModule = (id: string): Promise<SchemaModule | undefined> => {
		const clean = stripQuery(id)
		let result = modules.get(clean)
		if (!result) {
			result = readFile(clean, 'utf8')
				.then((code) => {
					const ast = parseStandaloneWithLang(code, clean)
					return ast ? collectSchemaModule(ast, code, clean) : undefined
				})
				.catch((): undefined => undefined)
			modules.set(clean, result)
		}
		return result
	}

	const resolveModule = async (
		source: string,
		importer: string,
	): Promise<SchemaModule | undefined> => {
		if (typeof context.resolve !== 'function') return undefined
		const resolved = await context.resolve(source, importer, { skipSelf: true })
		return resolved?.id ? loadModule(resolved.id) : undefined
	}

	const renderExport = async (module: SchemaModule, name: string): Promise<string | undefined> => {
		const target = module.exports.get(name)
		if (!target) return undefined
		if (target.kind === 'local') return renderIdentifier(module, target.local)
		const next = await resolveModule(target.source, module.id)
		return next ? renderExport(next, target.imported) : undefined
	}

	const renderIdentifier = async (module: SchemaModule, name: string): Promise<string> => {
		const declaration = module.declarations.get(name)
		if (declaration) {
			const key = `${module.id}#${name}`
			if (pending.has(key)) return name
			pending.add(key)
			try {
				return await renderExpression(module, declaration)
			} finally {
				pending.delete(key)
			}
		}

		const binding = module.imports.get(name)
		if (!binding) return name
		if (binding.source === 'valibot') {
			return binding.namespace ? 'v' : `v.${binding.imported}`
		}
		if (binding.source === 'valibot-form') {
			return binding.namespace ? 'f' : `f.${binding.imported}`
		}
		const target = await resolveModule(binding.source, module.id)
		return (target && (await renderExport(target, binding.imported))) ?? name
	}

	const renderExpression = async (module: SchemaModule, node: AstNode): Promise<string> => {
		if (node.type === 'Identifier') return renderIdentifier(module, readIdentifier(node) ?? '')
		const start = typeof node.start === 'number' ? node.start : undefined
		const end = typeof node.end === 'number' ? node.end : undefined
		if (start === undefined || end === undefined) return ''
		if (
			node.type === 'ArrowFunctionExpression' ||
			node.type === 'FunctionExpression' ||
			node.type === 'ClassExpression'
		) {
			return module.code.slice(start, end)
		}
		if (node.type === 'Property' && node.shorthand === true) {
			const value = node.value as AstNode | undefined
			const name = propertyName(node.key)
			return value && name
				? `${name}:${await renderExpression(module, value)}`
				: module.code.slice(start, end)
		}

		type Replacement = { start: number; end: number; text: string }
		const replacements: Replacement[] = []
		const seen = new Set<string>()
		for (const [field, value] of Object.entries(node)) {
			if (
				field === 'typeAnnotation' ||
				field === 'typeArguments' ||
				field === 'typeParameters' ||
				((node.type === 'Property' || node.type === 'MemberExpression') && field === 'key') ||
				(node.type === 'MemberExpression' && field === 'property')
			) {
				continue
			}
			const values = Array.isArray(value) ? value : [value]
			for (const rawChild of values) {
				if (!rawChild || typeof rawChild !== 'object') continue
				const child = rawChild as AstNode
				if (typeof child.type !== 'string') continue
				const childStart = typeof child.start === 'number' ? child.start : undefined
				const childEnd = typeof child.end === 'number' ? child.end : undefined
				if (
					childStart === undefined ||
					childEnd === undefined ||
					childStart < start ||
					childEnd > end ||
					(childStart === start && childEnd === end)
				) {
					continue
				}
				const key = `${childStart}:${childEnd}`
				if (seen.has(key)) continue
				seen.add(key)
				replacements.push({
					start: childStart,
					end: childEnd,
					text: await renderExpression(module, child),
				})
			}
		}

		let source = module.code.slice(start, end)
		for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
			const localStart = replacement.start - start
			const localEnd = replacement.end - start
			source = `${source.slice(0, localStart)}${replacement.text}${source.slice(localEnd)}`
		}
		return source
	}

	return {
		async render(module, expression) {
			const source = await renderExpression(module, expression)
			return normalizeSchemaSource(
				source,
				(code, filename) => {
					const ast = parseStandaloneWithLang(code, filename)
					if (!ast) throw new Error(`[pluxel-config] failed to parse schema source for ${filename}`)
					return ast
				},
				module.id,
			)
		},
	}
}

function stripQuery(id: string): string {
	return id.replace(/[?#].*$/, '')
}

function collectImports(ast: Program): Map<string, ImportBinding> {
	const imports = new Map<string, ImportBinding>()
	for (const statement of ast.body ?? []) {
		const node = statement as unknown as AstNode
		if (node.type !== 'ImportDeclaration') continue
		const source = readLiteralString(node.source)
		if (!source) continue
		for (const rawSpecifier of arrayOf(node.specifiers)) {
			const specifier = rawSpecifier as AstNode
			const local = readIdentifier(specifier.local)
			if (!local) continue
			imports.set(local, {
				source,
				imported:
					specifier.type === 'ImportDefaultSpecifier'
						? 'default'
						: (readIdentifier(specifier.imported) ?? local),
				namespace: specifier.type === 'ImportNamespaceSpecifier',
			})
		}
	}
	return imports
}

function hasPluginMarker(node: AstNode, imports: Map<string, ImportBinding>): boolean {
	for (const rawDecorator of arrayOf(node.decorators)) {
		const expression = (rawDecorator as AstNode).expression as AstNode | undefined
		const callee =
			expression?.type === 'CallExpression' ? (expression.callee as AstNode) : expression
		if (callee?.type === 'Identifier') {
			const binding = imports.get(readIdentifier(callee) ?? '')
			if (
				binding &&
				!binding.namespace &&
				binding.imported === 'Plugin' &&
				AUTHORING_PACKAGES.has(binding.source)
			) {
				return true
			}
		}
		if (callee?.type === 'MemberExpression' && propertyName(callee.property) === 'Plugin') {
			const binding = imports.get(readIdentifier(callee.object) ?? '')
			if (binding?.namespace && AUTHORING_PACKAGES.has(binding.source)) return true
		}
	}
	return false
}

function configsUse(value: unknown): AstNode | undefined {
	const call = value as AstNode | undefined
	if (call?.type !== 'CallExpression') return undefined
	const callee = call.callee as AstNode | undefined
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'use')
		return undefined
	const configs = callee.object as AstNode | undefined
	if (configs?.type !== 'MemberExpression' || propertyName(configs.property) !== 'configs') {
		return undefined
	}
	return (configs.object as AstNode | undefined)?.type === 'ThisExpression' ? call : undefined
}

function isClearlyNonObjectSchema(
	schema: AstNode,
	imports: ReadonlyMap<string, ImportBinding>,
): boolean {
	if (schema.type !== 'CallExpression') return false
	const callee = schema.callee as AstNode | undefined
	if (callee?.type === 'Identifier') {
		const binding = imports.get(readIdentifier(callee) ?? '')
		if (binding?.source !== 'valibot') return false
		return binding.imported !== 'object' && binding.imported !== 'objectAsync'
	}
	if (callee?.type !== 'MemberExpression') return false
	const object = readIdentifier(callee.object)
	const binding = object ? imports.get(object) : undefined
	if (!binding?.namespace || binding.source !== 'valibot') return false
	const factory = propertyName(callee.property)
	return factory !== 'object' && factory !== 'objectAsync'
}

function propertyName(value: unknown): string | undefined {
	return readIdentifier(value) ?? readLiteralString(value)
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function position(value: unknown, error: (message: string) => never, label: string): number {
	if (typeof value === 'number') return value
	return error(`[pluxel-config] cannot locate ${label}`)
}
