/**
 * Rolldown plugin to extract config/feature metadata from plugin source code at compile time.
 *
 * Vite 8+ plugins are Rolldown plugins and support hook filters, so a single plugin works for both:
 * - Vite/Vitest (dev + test pipeline)
 * - Rolldown (CLI build pipeline)
 *
 * Features:
 * - Uses hook filters to avoid per-module JS filtering in userland
 * - Uses this.parse() with lang option for TypeScript-aware parsing
 * - Uses fs.readFile() for reliable cross-file schema resolution
 * - Extracts and injects:
 *   - `@Config(schema)` field decorator source (`__setConfigSource__`)
 *   - `this.configs.use(schema)` class-field initializer source + schema registration (`__setConfigSource__` + `__registerConfigSchema__`)
 *   - `this.features.use(FeatureCtor)` class-field initializer (DI-required deps + feature config attribution) via `__registerUsedFeatures__(Ctor, FeatureCtor)`
 *
 * Important limitations:
 * - `config(s).use(...)` on `#private` fields is rejected (runtime injection can't assign to `#private`).
 * - `features.use(...)` is only extracted from class-field initializers. If you call it dynamically in `init()`,
 *   use `@UseFeature(FeatureCtor)` (or call `__registerUsedFeatures__(PluginCtor, FeatureCtor)` at module eval time).
 */

import { readFile } from 'node:fs/promises'
import type {
	CallExpression,
	Decorator,
	Expression,
	IdentifierName,
	Program,
	PrivateIdentifier,
	PropertyDefinition,
	SpreadElement,
} from 'oxc-parser'
import type { TransformPluginContext } from 'rolldown'
import { normalizeSchemaSource } from '../utils/configHandler'
import type { ViteCompatPlugin } from './compat'
import { allowOptionalQuerySuffix } from './compat'
import { normalizeViteId } from './viteNormalizeId'
import { normalizePatterns, parseWithLang } from './pluginUtils'

export interface ConfigSourcePluginOptions {
	/** File patterns to include (default: *.ts, *.tsx in plugin directories) */
	include?: string | string[]
	/** File patterns to exclude */
	exclude?: string | string[]
}

interface ExtractedConfig {
	className: string
	fieldName: string
	source: string
	registerExpr?: string
}

interface ExtractedFeatureUse {
	className: string
	featureExpr: string
}

interface DeclarationInfo {
	node: Expression
	start: number
	end: number
	source: string
}

interface ImportInfo {
	source: string
	imported: string
}

interface ModuleInfo {
	id: string
	code: string
	declarations: Map<string, DeclarationInfo>
	imports: Map<string, ImportInfo>
	exports: Map<string, string>
	reExports: Map<string, ImportInfo>
}

interface ModuleInfoStore {
	cache: Map<string, ModuleInfo>
	promises: Map<string, Promise<ModuleInfo | undefined>>
}

function createModuleInfoStore(): ModuleInfoStore {
	return {
		cache: new Map(),
		promises: new Map(),
	}
}

function isExpressionNode(node: { type?: unknown } | null | undefined): node is Expression {
	if (!node || typeof node.type !== 'string') return false
	const type = node.type
	if (type === 'Identifier' || type === 'Literal' || type === 'TemplateLiteral') return true
	if (type === 'MetaProperty' || type === 'Super' || type === 'ThisExpression') return true
	if (type === 'ObjectExpression' || type === 'ArrayExpression') return true
	return type.endsWith('Expression')
}

/**
 * 解析上下文 - 用于缓存已解析的标识符值，避免重复解析
 */
interface ResolveContext {
	moduleResolver: ModuleResolver
	/** 解析代码为 AST（使用 rolldown 的 this.parse） */
	parse: (code: string, moduleId: string) => Program
	/** Module info cache for cross-file resolution */
	moduleInfoStore: ModuleInfoStore
	/** 已解析的标识符值缓存: key = "moduleId::name", value = resolved source */
	resolvedValues: Map<string, string>
	/** 正在解析的标识符（用于循环检测） */
	pending: Set<string>
}

const DEFAULT_EXPORT = '__pluxel_default_export__'
const CONFIG_DECORATOR_SOURCES = ['@pluxel/core', '@pluxel/hmr'] as const

const CODE_HINT =
	/@Plugin|\bPlugin\s*\(|@Config|\bConfig\s*\(|\.(?:config|configs)\.use\s*\(|\.features\.use\s*\(|__decorate\s*\(|v\.|valibot\.|f\./

export function configSourcePlugin(options: ConfigSourcePluginOptions = {}): ViteCompatPlugin {
	const includePatterns = normalizePatterns(options.include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
	]).map(allowOptionalQuerySuffix)
	const excludePatterns = normalizePatterns(options.exclude, [
		'**/node_modules/**',
		'**/*.d.ts',
		'**/*.d.mts',
		'**/*.d.cts',
	]).map(allowOptionalQuerySuffix)
	const moduleInfoStore = createModuleInfoStore()

	return {
		name: 'pluxel-config-source',
		enforce: 'pre',
		buildStart() {
			// Vite can reuse plugin instances during dev; keep caches tied to the active graph.
			moduleInfoStore.cache.clear()
			moduleInfoStore.promises.clear()
		},
		hotUpdate() {
			// We can't cheaply track transitive schema dependencies across files.
			// Clearing the cache keeps extraction correct during HMR edits.
			moduleInfoStore.cache.clear()
			moduleInfoStore.promises.clear()
		},
		transform: {
			filter: {
				id: {
					include: includePatterns,
					exclude: excludePatterns,
				},
				code: { include: CODE_HINT },
			},
			async handler(this: TransformPluginContext, code, id) {
				const normalizedId = normalizeViteId(id)

				let sourceText = code
				// If a previous transform downleveled decorators, prefer extracting from raw TS source.
				// We keep the output based on the incoming `code` to avoid undoing other transforms.
				if (typeof code === 'string') {
					const looksDownleveledDecorators =
						code.includes('__decorate') ||
						(code.includes('Plugin(') && !code.includes('@Plugin') && !code.includes('@Config'))

					if (looksDownleveledDecorators) {
						try {
							sourceText = await readFile(normalizedId, 'utf-8')
						} catch {
							// ignore: not a real file or not readable; fall back to provided code
						}
					}
				}

				if (!CODE_HINT.test(sourceText)) return null

				const ast = parseWithLang(this, sourceText, normalizedId)
				if (!ast) {
					this.warn(`Failed to parse ${id}`)
					return null
				}

				try {
					// 第一步：收集并缓存本模块的导出 schema 定义（为跨文件引用做准备）
					const moduleInfo = collectModuleInfo(sourceText, normalizedId, ast, moduleInfoStore)

					const extractedFeatures = extractFeatureUses(moduleInfo, ast)
					const parseProgram = (source: string, filename: string) => {
						const parsed = parseWithLang(this, source, filename)
						if (!parsed) throw new Error(`Failed to parse module: ${filename}`)
						return parsed
					}

					const resolveModuleId: ModuleResolver = async (sourceSpecifier, importer) => {
						const resolved = await this.resolve(sourceSpecifier, importer)
						if (!resolved) return null
						return normalizeViteId(resolved.id)
					}

					// NOTE: @Config may be imported under an alias; keep this check permissive.
					const hasConfigHints = /\.(?:config|configs)\.use\s*\(|\bConfig\b/.test(sourceText)
					const extracted = hasConfigHints
						? await (async () => {
								// 第二步：提取 @Config 装饰器源代码
								const ctx: ResolveContext = {
									moduleResolver: resolveModuleId,
									parse: (source, moduleId) => {
										const parsed = parseWithLang(this, source, moduleId)
										if (!parsed) throw new Error(`Failed to parse module: ${moduleId}`)
										return parsed
									},
									moduleInfoStore,
									resolvedValues: new Map(),
									pending: new Set(),
								}
								return await extractConfigSources(moduleInfo, ast, ctx)
							})()
						: []

					if (extracted.length === 0 && extractedFeatures.length === 0) return null

					// 生成注入代码
					const injection = generateInjection(extracted, extractedFeatures, parseProgram)
					return {
						code: code + '\n' + injection,
						map: null as null,
					}
				} catch (err) {
					this.warn(`Failed to extract @Config sources from ${id}: ${err}`)
					return null
				}
			},
		},
	}
}

/**
 * 收集模块内的声明/导入/导出信息，缓存后返回
 */
function collectModuleInfo(
	code: string,
	moduleId: string,
	ast: Program,
	store: ModuleInfoStore,
): ModuleInfo {
	const info: ModuleInfo = {
		id: moduleId,
		code,
		declarations: new Map(),
		imports: new Map(),
		exports: new Map(),
		reExports: new Map(),
	}

	const addDeclaration = (name: string, init: Expression) => {
		info.declarations.set(name, {
			node: init,
			start: init.start,
			end: init.end,
			source: code.slice(init.start, init.end),
		})
	}

	for (const node of ast.body) {
		switch (node.type) {
			case 'ImportDeclaration': {
				const source = node.source.value
				for (const spec of node.specifiers) {
					if (spec.type === 'ImportSpecifier') {
						const imported =
							spec.imported.type === 'Identifier'
								? spec.imported.name
								: (spec.imported as { value: string }).value
						info.imports.set(spec.local.name, { source, imported })
					} else if (spec.type === 'ImportDefaultSpecifier') {
						info.imports.set(spec.local.name, { source, imported: 'default' })
					} else if (spec.type === 'ImportNamespaceSpecifier') {
						info.imports.set(spec.local.name, { source, imported: '*' })
					}
				}
				break
			}
			case 'ExportNamedDeclaration': {
				if (node.declaration?.type === 'VariableDeclaration' && node.declaration.kind === 'const') {
					for (const decl of node.declaration.declarations) {
						if (decl.id.type === 'Identifier' && decl.init) {
							addDeclaration(decl.id.name, decl.init)
							info.exports.set(decl.id.name, decl.id.name)
						}
					}
				}

				for (const spec of node.specifiers ?? []) {
					if (spec.type !== 'ExportSpecifier') continue
					const exported =
						spec.exported.type === 'Identifier'
							? spec.exported.name
							: (spec.exported as { value: string }).value
					const local =
						spec.local.type === 'Identifier'
							? spec.local.name
							: (spec.local as { value: string }).value
					if (node.source) {
						info.reExports.set(exported, { source: node.source.value, imported: local })
					} else {
						info.exports.set(exported, local)
					}
				}
				break
			}
			case 'ExportDefaultDeclaration': {
				const decl = node.declaration
				if (decl.type === 'Identifier') {
					info.exports.set('default', decl.name)
				} else if (
					(decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') &&
					decl.id
				) {
					info.exports.set('default', decl.id.name)
				} else if (
					decl.type !== 'FunctionDeclaration' &&
					decl.type !== 'ClassDeclaration' &&
					isExpressionNode(decl)
				) {
					const key = DEFAULT_EXPORT
					info.declarations.set(key, {
						node: decl,
						start: decl.start,
						end: decl.end,
						source: code.slice(decl.start, decl.end),
					})
					info.exports.set('default', key)
				}
				break
			}
			case 'VariableDeclaration': {
				if (node.kind !== 'const') break
				for (const decl of node.declarations) {
					if (decl.id.type === 'Identifier' && decl.init) {
						addDeclaration(decl.id.name, decl.init)
					}
				}
				break
			}
			default:
				break
		}
	}

	store.cache.set(moduleId, info)
	return info
}

async function ensureModuleInfo(
	moduleId: string,
	ctx: ResolveContext,
): Promise<ModuleInfo | undefined> {
	const cached = ctx.moduleInfoStore.cache.get(moduleId)
	if (cached) return cached

	const pending = ctx.moduleInfoStore.promises.get(moduleId)
	if (pending) return pending

	const promise = (async () => {
		try {
			const source = await readFile(moduleId, 'utf-8')
			const parsed = ctx.parse(source, moduleId)
			return collectModuleInfo(source, moduleId, parsed, ctx.moduleInfoStore)
		} catch {
			return undefined
		} finally {
			ctx.moduleInfoStore.promises.delete(moduleId)
		}
	})()

	ctx.moduleInfoStore.promises.set(moduleId, promise)
	return promise
}

type ModuleResolver = (source: string, importer: string) => Promise<string | null>

function isConfigImportSource(source: string): boolean {
	for (const base of CONFIG_DECORATOR_SOURCES) {
		if (source === base || source.startsWith(`${base}/`)) return true
	}
	return false
}

function isValibotNamespaceImport(name: string, moduleInfo: ModuleInfo): boolean {
	if (name === 'v') return true
	const importInfo = moduleInfo.imports.get(name)
	return Boolean(importInfo && importInfo.imported === '*' && importInfo.source === 'valibot')
}

function rewriteRuntimeNamespaces(source: string, moduleInfo: ModuleInfo): string {
	// Replace `<valibotNs>.foo` => `v.foo`, `<valibotFormNs>.foo` => `f.foo`,
	// but skip string literals so we don't mutate embedded strings.
	const valibotAliases = new Set<string>()
	const valibotFormAliases = new Set<string>()
	for (const [local, info] of moduleInfo.imports) {
		if (info.imported !== '*') continue
		if (info.source === 'valibot') valibotAliases.add(local)
		if (info.source === 'valibot-form') valibotFormAliases.add(local)
	}
	valibotAliases.delete('v')
	valibotFormAliases.delete('f')
	if (valibotAliases.size === 0 && valibotFormAliases.size === 0) return source

	const isIdentStart = (ch: string) => /[A-Za-z_$]/.test(ch)
	const isIdentPart = (ch: string) => /[A-Za-z0-9_$]/.test(ch)

	let out = ''
	let i = 0
	let inSingle = false
	let inDouble = false
	let inTemplate = false
	let isEscaped = false

	while (i < source.length) {
		const ch = source[i]

		if (isEscaped) {
			out += ch
			isEscaped = false
			i++
			continue
		}
		if (ch === '\\') {
			out += ch
			isEscaped = true
			i++
			continue
		}

		if (inSingle) {
			out += ch
			if (ch === "'") inSingle = false
			i++
			continue
		}
		if (inDouble) {
			out += ch
			if (ch === '"') inDouble = false
			i++
			continue
		}
		if (inTemplate) {
			out += ch
			if (ch === '`') inTemplate = false
			i++
			continue
		}

		if (ch === "'") {
			inSingle = true
			out += ch
			i++
			continue
		}
		if (ch === '"') {
			inDouble = true
			out += ch
			i++
			continue
		}
		if (ch === '`') {
			inTemplate = true
			out += ch
			i++
			continue
		}

		if (!isIdentStart(ch)) {
			out += ch
			i++
			continue
		}

		let j = i + 1
		while (j < source.length && isIdentPart(source[j]!)) j++
		const ident = source.slice(i, j)
		const next = source[j]
		const prev = i > 0 ? source[i - 1] : ''

		if (next === '.' && !(prev && isIdentPart(prev))) {
			if (valibotAliases.has(ident)) {
				out += 'v'
				i = j
				continue
			}
			if (valibotFormAliases.has(ident)) {
				out += 'f'
				i = j
				continue
			}
		}

		out += ident
		i = j
	}

	return out
}

function isConfigIdentifier(name: string, moduleInfo: ModuleInfo): boolean {
	if (name === 'Config') return true
	const importInfo = moduleInfo.imports.get(name)
	if (!importInfo) return false
	return importInfo.imported === 'Config' && isConfigImportSource(importInfo.source)
}

async function expandExpressionWithModule(
	moduleInfo: ModuleInfo,
	expr: Expression,
	ctx: ResolveContext,
): Promise<string> {
	const normalized = unwrapExpression(expr)
	if (normalized.type === 'Identifier') {
		const resolved = await resolveIdentifierValue(moduleInfo, normalized.name, ctx)
		return resolved ?? normalized.name
	}
	if (normalized.type === 'CallExpression' && isObjectSchemaCall(moduleInfo, normalized.callee)) {
		return rewriteRuntimeNamespaces(
			await expandObjectCallWithInlining(moduleInfo, normalized, ctx),
			moduleInfo,
		)
	}
	const replacements = await collectIdentifierReplacements(normalized, moduleInfo, ctx)
	if (replacements.length === 0)
		return rewriteRuntimeNamespaces(
			moduleInfo.code.slice(normalized.start, normalized.end),
			moduleInfo,
		)
	return rewriteRuntimeNamespaces(
		applyReplacements(moduleInfo.code, normalized.start, normalized.end, replacements),
		moduleInfo,
	)
}

async function resolveIdentifierValue(
	moduleInfo: ModuleInfo,
	name: string,
	ctx: ResolveContext,
): Promise<string | undefined> {
	const key = `${moduleInfo.id}::${name}`

	// 检查缓存
	const cached = ctx.resolvedValues.get(key)
	if (cached !== undefined) return cached

	// 循环检测
	if (ctx.pending.has(key)) return undefined
	ctx.pending.add(key)

	try {
		let result: string | undefined

		const decl = moduleInfo.declarations.get(name)
		if (decl) {
			result = await expandExpressionWithModule(moduleInfo, decl.node, ctx)
		} else {
			const importInfo = moduleInfo.imports.get(name)
			if (importInfo && importInfo.imported !== '*') {
				// Runtime eval of schemaSource only injects `v` (valibot) and `f` (valibot-form).
				// If users import named helpers (`import { object } from 'valibot'`), we rewrite the
				// identifier to `v.object` so the expression remains evaluatable.
				if (importInfo.imported !== 'default') {
					if (importInfo.source === 'valibot') result = `v.${importInfo.imported}`
					if (importInfo.source === 'valibot-form') result = `f.${importInfo.imported}`
				}
				if (result !== undefined) {
					ctx.resolvedValues.set(key, result)
					return result
				}
				const resolvedId = await ctx.moduleResolver(importInfo.source, moduleInfo.id)
				if (resolvedId) {
					const targetInfo = await ensureModuleInfo(resolvedId, ctx)
					if (targetInfo) {
						result = await resolveExportedValue(targetInfo, importInfo.imported, ctx)
					}
				}
			}
		}

		// 缓存结果
		if (result !== undefined) {
			ctx.resolvedValues.set(key, result)
		}
		return result
	} finally {
		ctx.pending.delete(key)
	}
}

async function resolveExportedValue(
	moduleInfo: ModuleInfo,
	exportedName: string,
	ctx: ResolveContext,
): Promise<string | undefined> {
	const key = `${moduleInfo.id}::export::${exportedName}`

	// 检查缓存
	const cached = ctx.resolvedValues.get(key)
	if (cached !== undefined) return cached

	// 循环检测
	if (ctx.pending.has(key)) return undefined
	ctx.pending.add(key)

	try {
		let result: string | undefined

		const localName = moduleInfo.exports.get(exportedName)
		if (localName) {
			const decl = moduleInfo.declarations.get(localName)
			if (decl) {
				result = await expandExpressionWithModule(moduleInfo, decl.node, ctx)
			}
		}

		if (result === undefined) {
			const reExport = moduleInfo.reExports.get(exportedName)
			if (reExport && reExport.imported !== '*') {
				const resolvedId = await ctx.moduleResolver(reExport.source, moduleInfo.id)
				if (resolvedId) {
					const targetInfo = await ensureModuleInfo(resolvedId, ctx)
					if (targetInfo) {
						result = await resolveExportedValue(targetInfo, reExport.imported, ctx)
					}
				}
			}
		}

		// 缓存结果
		if (result !== undefined) {
			ctx.resolvedValues.set(key, result)
		}
		return result
	} finally {
		ctx.pending.delete(key)
	}
}

function isObjectSchemaCall(moduleInfo: ModuleInfo, callee: Expression): boolean {
	if (callee.type !== 'MemberExpression') return false
	if (callee.computed) return false
	if (callee.property.type !== 'Identifier') return false
	const propName = callee.property.name
	if (propName !== 'object' && propName !== 'objectAsync') return false
	if (callee.object.type !== 'Identifier') return false
	const objName = (callee.object as IdentifierName).name
	return isValibotNamespaceImport(objName, moduleInfo)
}

async function expandObjectCallWithInlining(
	moduleInfo: ModuleInfo,
	expr: CallExpression,
	ctx: ResolveContext,
): Promise<string> {
	const baseSource = moduleInfo.code.slice(expr.start, expr.end)
	const rawArg = expr.arguments[0]
	if (!rawArg) return baseSource
	const argExpr = unwrapExpression(rawArg.type === 'SpreadElement' ? rawArg.argument : rawArg)
	if (!argExpr || argExpr.type !== 'ObjectExpression') return baseSource

	const replacements: Replacement[] = []

	for (const prop of argExpr.properties) {
		if (isSpreadElement(prop)) {
			replacements.push(...(await collectIdentifierReplacements(prop.argument, moduleInfo, ctx)))
			continue
		}
		if (prop.type !== 'Property') continue
		if (prop.shorthand && prop.key.type === 'Identifier') {
			const resolved = await resolveIdentifierValue(moduleInfo, prop.key.name, ctx)
			if (!resolved) continue
			const keySource = moduleInfo.code.slice(prop.key.start, prop.key.end)
			replacements.push({
				start: prop.start,
				end: prop.end,
				text: `${keySource}:${resolved}`,
			})
			continue
		}
		if (prop.computed && prop.key.type !== 'Identifier') {
			replacements.push(
				...(await collectIdentifierReplacements(prop.key as Expression, moduleInfo, ctx)),
			)
		}
		if (prop.value) {
			replacements.push(...(await collectIdentifierReplacements(prop.value, moduleInfo, ctx)))
		}
	}

	for (const extraArg of expr.arguments.slice(1)) {
		if (extraArg.type === 'SpreadElement') {
			replacements.push(
				...(await collectIdentifierReplacements(extraArg.argument, moduleInfo, ctx)),
			)
		} else {
			replacements.push(...(await collectIdentifierReplacements(extraArg, moduleInfo, ctx)))
		}
	}

	if (replacements.length === 0) return baseSource
	return applyReplacements(moduleInfo.code, expr.start, expr.end, replacements)
}

function unwrapExpression(expr: Expression): Expression {
	let current = expr
	while (true) {
		if (
			current.type === 'TSAsExpression' ||
			current.type === 'TSSatisfiesExpression' ||
			current.type === 'TSTypeAssertion' ||
			current.type === 'TSInstantiationExpression' ||
			current.type === 'TSNonNullExpression'
		) {
			current = current.expression
			continue
		}
		if (current.type === 'ParenthesizedExpression') {
			current = current.expression
			continue
		}
		break
	}
	return current
}

function applyReplacements(
	source: string,
	start: number,
	end: number,
	replacements: Array<{ start: number; end: number; text: string }>,
): string {
	let cursor = start
	let result = ''
	const sorted = replacements.slice().sort((a, b) => a.start - b.start)
	for (const rep of sorted) {
		if (rep.start < cursor) continue
		result += source.slice(cursor, rep.start)
		result += rep.text
		cursor = rep.end
	}
	result += source.slice(cursor, end)
	return result
}

type Replacement = { start: number; end: number; text: string }

async function collectIdentifierReplacements(
	node: Expression,
	moduleInfo: ModuleInfo,
	ctx: ResolveContext,
): Promise<Replacement[]> {
	const normalized = unwrapExpression(node)
	const replacements: Replacement[] = []

	const visit = async (child: Expression | PrivateIdentifier | null | undefined) => {
		if (!child) return
		if (child.type === 'PrivateIdentifier') return
		replacements.push(...(await collectIdentifierReplacements(child, moduleInfo, ctx)))
	}

	switch (normalized.type) {
		case 'Identifier': {
			const resolved = await resolveIdentifierValue(moduleInfo, normalized.name, ctx)
			if (resolved) {
				replacements.push({
					start: normalized.start,
					end: normalized.end,
					text: resolved,
				})
			}
			break
		}
		case 'CallExpression': {
			await visit(normalized.callee)
			for (const arg of normalized.arguments) {
				if (arg.type === 'SpreadElement') await visit(arg.argument)
				else await visit(arg)
			}
			break
		}
		case 'MemberExpression': {
			await visit(normalized.object)
			if (normalized.computed) await visit(normalized.property as Expression)
			break
		}
		case 'ArrayExpression': {
			for (const element of normalized.elements) {
				if (!element) continue
				if (element.type === 'SpreadElement') await visit(element.argument)
				else await visit(element)
			}
			break
		}
		case 'ObjectExpression': {
			for (const prop of normalized.properties) {
				if (isSpreadElement(prop)) {
					await visit(prop.argument)
					continue
				}
				if (prop.type !== 'Property') continue
				if (prop.shorthand && prop.key.type === 'Identifier') {
					const resolved = await resolveIdentifierValue(moduleInfo, prop.key.name, ctx)
					if (resolved) {
						const keySource = moduleInfo.code.slice(prop.key.start, prop.key.end)
						replacements.push({
							start: prop.start,
							end: prop.end,
							text: `${keySource}:${resolved}`,
						})
						continue
					}
				}
				if (prop.computed && isExpressionNode(prop.key)) {
					await visit(prop.key)
				}
				await visit(prop.value)
			}
			break
		}
		case 'UnaryExpression':
		case 'AwaitExpression': {
			await visit(normalized.argument)
			break
		}
		case 'UpdateExpression': {
			// 不替换自增运算符目标
			break
		}
		case 'YieldExpression': {
			await visit(normalized.argument ?? undefined)
			break
		}
		case 'BinaryExpression':
		case 'LogicalExpression': {
			await visit(normalized.left)
			await visit(normalized.right)
			break
		}
		case 'AssignmentExpression': {
			await visit(normalized.right)
			break
		}
		case 'ConditionalExpression': {
			await visit(normalized.test)
			await visit(normalized.consequent)
			await visit(normalized.alternate)
			break
		}
		case 'SequenceExpression': {
			for (const exprItem of normalized.expressions) await visit(exprItem)
			break
		}
		case 'NewExpression': {
			await visit(normalized.callee)
			for (const arg of normalized.arguments ?? []) {
				if (arg.type === 'SpreadElement') await visit(arg.argument)
				else await visit(arg)
			}
			break
		}
		case 'TaggedTemplateExpression': {
			await visit(normalized.tag)
			await visit(normalized.quasi)
			break
		}
		case 'TemplateLiteral': {
			for (const exprItem of normalized.expressions) await visit(exprItem)
			break
		}
		case 'ChainExpression': {
			await visit(normalized.expression)
			break
		}
		case 'ParenthesizedExpression': {
			await visit(normalized.expression)
			break
		}
		default:
			break
	}

	return replacements
}

function isSpreadElement(node: unknown): node is SpreadElement {
	return Boolean(
		node && typeof node === 'object' && (node as { type?: unknown }).type === 'SpreadElement',
	)
}

/**
 * 提取 @Config 装饰器的源代码
 */
async function extractConfigSources(
	moduleInfo: ModuleInfo,
	ast: Program,
	ctx: ResolveContext,
): Promise<ExtractedConfig[]> {
	const extracted: ExtractedConfig[] = []

	// Find classes that have @Config-decorated fields (plugins and features).
	for (const node of ast.body) {
		const classDecl =
			node.type === 'ClassDeclaration'
				? node
				: node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration'
					? node.declaration
					: node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'ClassDeclaration'
						? node.declaration
						: null

		if (!classDecl) continue

		const className = classDecl.id?.name
		if (!className) continue

		for (const member of classDecl.body.body) {
			if (member.type !== 'PropertyDefinition') continue

			const propDef = member as PropertyDefinition
			const isHashPrivate = propDef.key.type === 'PrivateIdentifier'
			const fieldName =
				propDef.key.type === 'Identifier'
					? propDef.key.name
					: propDef.key.type === 'PrivateIdentifier'
						? propDef.key.name
						: null

			if (!fieldName) continue

			let hasDecoratedConfig = false
			if (propDef.decorators) {
				for (const decorator of propDef.decorators) {
					const source = await extractConfigDecoratorSource(decorator, moduleInfo, ctx)
					if (source) {
						hasDecoratedConfig = true
						extracted.push({ className, fieldName, source })
					}
				}
			}

			const useMatch = extractConfigsUseCall(propDef.value ?? null)
			if (useMatch) {
				if (isHashPrivate) {
					throw new Error(
						`config(s).use(...) is not supported on #private fields: ${className}.#${fieldName}. Use a normal (non-#) field so runtime injection can work.`,
					)
				}
				if (hasDecoratedConfig) {
					throw new Error(
						`Config conflict on ${className}.${fieldName}: cannot use both @Config(...) and config(s).use(...)`,
					)
				}
				const source = await expandExpressionWithModule(moduleInfo, useMatch.schemaExpr, ctx)
				const registerExpr =
					useMatch.schemaExpr.type === 'Identifier'
						? useMatch.schemaExpr.name
						: moduleInfo.code.slice(useMatch.schemaExpr.start, useMatch.schemaExpr.end)
				extracted.push({ className, fieldName, source, registerExpr })
			}
		}
	}

	return extracted
}

function extractFeatureUses(moduleInfo: ModuleInfo, ast: Program): ExtractedFeatureUse[] {
	const extracted: ExtractedFeatureUse[] = []
	const seen = new Set<string>()

	for (const node of ast.body) {
		const classDecl =
			node.type === 'ClassDeclaration'
				? node
				: node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration'
					? node.declaration
					: node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'ClassDeclaration'
						? node.declaration
						: null

		if (!classDecl) continue

		const className = classDecl.id?.name
		if (!className) continue

		for (const member of classDecl.body.body) {
			if (member.type !== 'PropertyDefinition') continue

			const propDef = member as PropertyDefinition
			const useMatch = extractFeaturesUseCall(propDef.value ?? null)
			if (!useMatch) continue

			const featureExpr = moduleInfo.code.slice(
				useMatch.featureExpr.start,
				useMatch.featureExpr.end,
			)
			const key = `${className}::${featureExpr}`
			if (seen.has(key)) continue
			seen.add(key)
			extracted.push({ className, featureExpr })
		}
	}

	return extracted
}

function extractConfigsUseCall(
	value: Expression | null | undefined,
): { schemaExpr: Expression } | null {
	if (!value) return null
	const normalized = unwrapExpression(value)

	if (normalized.type !== 'CallExpression') return null
	const callee = normalized.callee
	if (callee.type !== 'MemberExpression') return null

	// Match: this.configs.use(...)
	const prop = callee.property
	if (prop.type !== 'Identifier' || prop.name !== 'use') return null

	const obj = callee.object
	if (obj.type !== 'MemberExpression') return null
	const objProp = obj.property
	if (objProp.type !== 'Identifier' || objProp.name !== 'configs') return null

	const objObj = obj.object
	if (objObj.type !== 'ThisExpression') return null

	if (normalized.arguments.length === 0) return null
	const arg = normalized.arguments[0]
	const resolved = arg.type === 'SpreadElement' ? arg.argument : arg
	if (!resolved) return null
	return { schemaExpr: resolved }
}

function extractFeaturesUseCall(
	value: Expression | null | undefined,
): { featureExpr: Expression } | null {
	if (!value) return null
	const normalized = unwrapExpression(value)

	if (normalized.type !== 'CallExpression') return null
	const callee = normalized.callee
	if (callee.type !== 'MemberExpression') return null

	// Match: this.features.use(...)
	const prop = callee.property
	if (prop.type !== 'Identifier' || prop.name !== 'use') return null

	const obj = callee.object
	if (obj.type !== 'MemberExpression') return null
	const objProp = obj.property
	if (objProp.type !== 'Identifier' || objProp.name !== 'features') return null

	const objObj = obj.object
	if (objObj.type !== 'ThisExpression') return null

	if (normalized.arguments.length === 0) return null
	const arg = normalized.arguments[0]
	const resolved = arg.type === 'SpreadElement' ? arg.argument : arg
	if (!resolved) return null
	return { featureExpr: resolved }
}

/**
 * 从装饰器提取 schema 源代码
 */
async function extractConfigDecoratorSource(
	decorator: Decorator,
	moduleInfo: ModuleInfo,
	ctx: ResolveContext,
): Promise<string | undefined> {
	const expr = decorator.expression
	if (expr.type !== 'CallExpression') return undefined

	// 检查是否是 @Config 调用
	const callee = expr.callee
	const isConfigCall =
		(callee.type === 'Identifier' && isConfigIdentifier(callee.name, moduleInfo)) ||
		(callee.type === 'MemberExpression' &&
			callee.property.type === 'Identifier' &&
			callee.property.name === 'Config')

	if (!isConfigCall) return undefined
	if (expr.arguments.length === 0) return undefined

	const arg = expr.arguments[0]
	const resolvedArg = arg.type === 'SpreadElement' ? arg.argument : arg

	if (!resolvedArg) return undefined

	if (resolvedArg.type === 'Identifier') {
		const viaIdentifier = await resolveIdentifierValue(moduleInfo, resolvedArg.name, ctx)
		return viaIdentifier ?? resolvedArg.name
	}

	return expandExpressionWithModule(moduleInfo, resolvedArg, ctx)
}

/**
 * 生成注入代码 - 直接将 schema source 作为字符串字面量注入
 */
function generateInjection(
	configs: ExtractedConfig[],
	features: ExtractedFeatureUse[],
	parseProgram: (code: string, filename: string) => Program,
): string {
	if (configs.length === 0 && features.length === 0) return ''

	const needsRegister = configs.some(
		(c) => typeof c.registerExpr === 'string' && c.registerExpr.length > 0,
	)

	const lines: string[] = ['// [pluxel-config-source] Injected metadata']

	if (configs.length > 0 || features.length > 0) {
		const imports: string[] = []
		if (configs.length > 0) {
			imports.push('__setConfigSource__')
			if (needsRegister) imports.push('__registerConfigSchema__')
		}
		if (features.length > 0) imports.push('__registerUsedFeatures__')
		// Keep import stable/deterministic for snapshots and caching.
		imports.sort()
		lines.push(`import { ${imports.join(', ')} } from "@pluxel/core";`)

		for (const { className, fieldName, source } of configs) {
			const final = normalizeSchemaSource(source, parseProgram)
			const escapedSource = JSON.stringify(final)
			lines.push(
				`__setConfigSource__(${className}, ${JSON.stringify(fieldName)}, ${escapedSource});`,
			)
		}
	}

	if (configs.length > 0 && needsRegister) {
		for (const cfg of configs) {
			if (!cfg.registerExpr) continue
			lines.push(
				`__registerConfigSchema__(${cfg.className}, ${JSON.stringify(cfg.fieldName)}, ${cfg.registerExpr});`,
			)
		}
	}

	if (features.length > 0) {
		const groups = new Map<string, string[]>()
		for (const { className, featureExpr } of features) {
			const list = groups.get(className)
			if (list) list.push(featureExpr)
			else groups.set(className, [featureExpr])
		}
		for (const [className, featureExprs] of groups) {
			lines.push(`__registerUsedFeatures__(${className}, ${featureExprs.join(', ')});`)
		}
	}

	return lines.join('\n')
}
