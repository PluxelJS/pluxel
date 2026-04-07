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
import { allowOptionalQuerySuffix, type ViteCompatPlugin } from './compat'
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

interface ExtractedBinding {
	className: string
	fieldName: string
	keys: string[]
}

interface ExtractedConfigLayout {
	className: string
	fieldName: string
	layout: unknown[]
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

function readLiteralString(
	node: { type?: unknown; value?: unknown } | null | undefined,
): string | null {
	return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null
}

function readLiteralNumber(
	node: { type?: unknown; value?: unknown } | null | undefined,
): number | null {
	return node?.type === 'Literal' && typeof node.value === 'number' ? node.value : null
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
const CONFIG_DECORATOR_SOURCES = ['@pluxel/core', '@pluxel/runtime'] as const

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

				// Avoid double-injecting when a module is re-transformed by Vite/Vitest pipelines.
				// This can happen when other transforms produce a new module graph and our plugin
				// is applied again to already-injected code.
				if (typeof code === 'string' && code.includes('[pluxel-config-source] Injected metadata')) {
					return null
				}

				// Prefer extracting from on-disk TS source when possible.
				// This keeps cfg tagged templates / decorators in their authored form even if other transforms
				// downlevel them (we still output based on the incoming `code` to avoid undoing transforms).
				let sourceText = code
				if (typeof code === 'string') {
					try {
						sourceText = await readFile(normalizedId, 'utf-8')
					} catch {
						// ignore: not a real file or not readable; fall back to provided code
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
						: { configs: [], bindings: [], layouts: [] }

					if (
						extracted.configs.length === 0 &&
						extracted.bindings.length === 0 &&
						extracted.layouts.length === 0 &&
						extractedFeatures.length === 0
					)
						return null

					// 生成注入代码
					const injection = generateInjection(
						extracted.configs,
						extracted.bindings,
						extracted.layouts,
						extractedFeatures,
						parseProgram,
					)
					return {
						code: code + '\n' + injection,
						map: null as null,
					}
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err)
					this.error(`Failed to extract config metadata from ${id}: ${detail}`)
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

function ensureModuleInfo(moduleId: string, ctx: ResolveContext): Promise<ModuleInfo | undefined> {
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

async function resolveExportedExpressionNode(
	moduleInfo: ModuleInfo,
	exportedName: string,
	ctx: ResolveContext,
): Promise<{ moduleInfo: ModuleInfo; expr: Expression } | undefined> {
	const localName = moduleInfo.exports.get(exportedName)
	if (localName) {
		const decl = moduleInfo.declarations.get(localName)
		if (decl) return { moduleInfo, expr: decl.node }
	}

	const reExport = moduleInfo.reExports.get(exportedName)
	if (reExport && reExport.imported !== '*') {
		const resolvedId = await ctx.moduleResolver(reExport.source, moduleInfo.id)
		if (resolvedId) {
			const targetInfo = await ensureModuleInfo(resolvedId, ctx)
			if (targetInfo) return resolveExportedExpressionNode(targetInfo, reExport.imported, ctx)
		}
	}

	return undefined
}

async function resolveIdentifierExpressionNode(
	moduleInfo: ModuleInfo,
	name: string,
	ctx: ResolveContext,
): Promise<{ moduleInfo: ModuleInfo; expr: Expression } | undefined> {
	const decl = moduleInfo.declarations.get(name)
	if (decl) return { moduleInfo, expr: decl.node }

	const importInfo = moduleInfo.imports.get(name)
	if (!importInfo || importInfo.imported === '*') return undefined

	const resolvedId = await ctx.moduleResolver(importInfo.source, moduleInfo.id)
	if (!resolvedId) return undefined
	const targetInfo = await ensureModuleInfo(resolvedId, ctx)
	if (!targetInfo) return undefined
	return resolveExportedExpressionNode(targetInfo, importInfo.imported, ctx)
}

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
	const sorted = [...replacements].sort((a, b) => a.start - b.start)
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
): Promise<{
	configs: ExtractedConfig[]
	bindings: ExtractedBinding[]
	layouts: ExtractedConfigLayout[]
}> {
	const extracted: ExtractedConfig[] = []
	const bindings: ExtractedBinding[] = []
	const layouts: ExtractedConfigLayout[] = []
	const seenSchemaKeys = new Set<string>()
	const seenBindings = new Set<string>()
	const seenLayouts = new Set<string>()

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
						const schemaKey = fieldName
						const key = `${className}::schema::${schemaKey}`
						if (!seenSchemaKeys.has(key)) {
							seenSchemaKeys.add(key)
							extracted.push({ className, fieldName: schemaKey, source })
						}
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

				// cfg(schemaMap) path: `field = this.configs.use(cfg(schemaMap))`
				const cfgSchemaMapExpr = extractCfgSchemaMapExpr(moduleInfo, ast, useMatch.schemaExpr)
				if (cfgSchemaMapExpr) {
					const cfg = await extractCfgSchemasFromSchemaMapExpr(
						moduleInfo,
						ast,
						cfgSchemaMapExpr,
						'cfg(schemaMap)',
						ctx,
					)

					const layout = extractCfgLayout(useMatch.schemaExpr)
					if (layout) {
						const layoutKey = `${className}::layout::${fieldName}`
						if (!seenLayouts.has(layoutKey)) {
							seenLayouts.add(layoutKey)
							layouts.push({ className, fieldName, layout })
						}
					}

					const bindKey = `${className}::bind::${fieldName}`
					if (!seenBindings.has(bindKey)) {
						seenBindings.add(bindKey)
						bindings.push({ className, fieldName, keys: cfg.keys })
					}

					for (const entry of cfg.entries) {
						const schemaKey = entry.key
						const schemaSeen = `${className}::schema::${schemaKey}`
						if (seenSchemaKeys.has(schemaSeen)) continue
						seenSchemaKeys.add(schemaSeen)

						const source = await expandExpressionWithModule(entry.moduleInfo, entry.schemaExpr, ctx)
						extracted.push({
							className,
							fieldName: schemaKey,
							source,
							registerExpr: entry.registerExpr,
						})
					}
					continue
				}

				// Reject legacy `cfg` tagged template (`cfg`...``) explicitly.
				// cfg(schemaMap)`...` is supported (static markdown; interpolation is allowed only for cfg tokens).
				if (useMatch.schemaExpr.type === 'TaggedTemplateExpression') {
					const tag = (useMatch.schemaExpr as any).tag
					const normalizedTag = tag ? unwrapExpression(tag) : null
					const isLegacyCfgTag =
						normalizedTag?.type === 'Identifier' && normalizedTag.name === 'cfg'
					if (isLegacyCfgTag) {
						throw new Error(
							`[cfg] Use cfg(schemaMap) (legacy cfg\`...\` is not supported): ${moduleInfo.id}`,
						)
					}
				}

				// schema path: `field = this.configs.use(schema)`
				{
					const bindKey = `${className}::bind::${fieldName}`
					if (!seenBindings.has(bindKey)) {
						seenBindings.add(bindKey)
						bindings.push({ className, fieldName, keys: [fieldName] })
					}

					const schemaKey = fieldName
					const schemaSeen = `${className}::schema::${schemaKey}`
					if (seenSchemaKeys.has(schemaSeen)) continue
					seenSchemaKeys.add(schemaSeen)

					const source = await expandExpressionWithModule(moduleInfo, useMatch.schemaExpr, ctx)
					const registerExpr =
						useMatch.schemaExpr.type === 'Identifier'
							? useMatch.schemaExpr.name
							: moduleInfo.code.slice(useMatch.schemaExpr.start, useMatch.schemaExpr.end)
					extracted.push({ className, fieldName: schemaKey, source, registerExpr })
				}
			}
		}
	}

	return { configs: extracted, bindings, layouts }
}

function normalizeMarkdownTemplate(input: string): string {
	const lines = String(input ?? '')
		.replaceAll('\r\n', '\n')
		.split('\n')
	while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
	while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
	let minIndent = Number.POSITIVE_INFINITY
	for (const line of lines) {
		if (!line.trim()) continue
		const match = line.match(/^[\t ]+/)
		const indent = match ? match[0].length : 0
		minIndent = Math.min(minIndent, indent)
	}
	if (!Number.isFinite(minIndent) || minIndent <= 0) return lines.join('\n')
	return lines.map((line) => (line.trim() ? line.slice(minIndent) : '')).join('\n')
}

type ExtractedLayoutPart =
	| { kind: 'md'; text: string }
	| { kind: 'schema'; key: string }
	| { kind: 'schemas'; keys: string[] | null } // null => remaining

function mergeAdjacentMarkdown(parts: ExtractedLayoutPart[]): ExtractedLayoutPart[] {
	const merged: ExtractedLayoutPart[] = []
	for (const part of parts) {
		const prev = merged.at(-1)
		if (part.kind === 'md' && prev?.kind === 'md') {
			prev.text += part.text
			continue
		}
		merged.push(part.kind === 'md' ? { ...part } : part)
	}
	return merged
}

function assertValidExtractedLayout(parts: readonly ExtractedLayoutPart[]): void {
	const placed = new Set<string>()
	let hasRemaining = false

	for (const part of parts) {
		if (part.kind === 'md') continue
		if (hasRemaining) {
			throw new Error('[cfg] schemas() must be the last schema-placement token')
		}
		if (part.kind === 'schema') {
			const key = String(part.key ?? '').trim()
			if (placed.has(key)) {
				throw new Error(`[cfg] duplicate schema placement for key "${key}"`)
			}
			placed.add(key)
			continue
		}
		if (part.keys === null) {
			hasRemaining = true
			continue
		}
		for (const rawKey of part.keys) {
			const key = String(rawKey ?? '').trim()
			if (!key) continue
			if (placed.has(key)) {
				throw new Error(`[cfg] duplicate schema placement for key "${key}"`)
			}
			placed.add(key)
		}
	}
}

function extractCfgLayout(expr: Expression): ExtractedLayoutPart[] | null {
	const normalized = unwrapExpression(expr as any) as any
	if (!normalized || normalized.type !== 'TaggedTemplateExpression') return null

	const quasi = normalized.quasi as any
	const expressions = Array.isArray(quasi?.expressions) ? quasi.expressions : []

	const quasis = Array.isArray(quasi?.quasis) ? quasi.quasis : []
	const readQuasi = (q: unknown): string => {
		if (!q || typeof q !== 'object') return ''
		const v =
			(q as any)?.value?.cooked ??
			(q as any)?.value?.raw ??
			(typeof (q as any)?.value === 'string' ? (q as any).value : '')
		return String(v ?? '')
	}

	const toPart = (e: unknown): ExtractedLayoutPart => {
		const node = e ? unwrapExpression(e as any) : null
		if (!node || typeof node !== 'object') {
			throw new Error('[cfg] invalid interpolation in cfg(schemaMap)`...`')
		}
		// Allow only:
		// - c.schema('key')
		// - c.schemas(...keys)   (no args => remaining)
		if ((node as any).type !== 'CallExpression') {
			throw new Error('[cfg] invalid interpolation in cfg(schemaMap)`...` (expected call)')
		}
		const call = node as any
		const callee = call.callee ? unwrapExpression(call.callee) : null
		if (!callee || callee.type !== 'MemberExpression' || callee.computed) {
			throw new Error(
				'[cfg] invalid interpolation in cfg(schemaMap)`...` (expected c.schema(...) / c.schemas(...))',
			)
		}
		const prop = callee.property
		const propName = prop?.type === 'Identifier' ? prop.name : readLiteralString(prop)
		if (propName !== 'schema' && propName !== 'schemas') {
			throw new Error(
				'[cfg] invalid interpolation in cfg(schemaMap)`...` (expected c.schema(...) / c.schemas(...))',
			)
		}

		const args = Array.isArray(call.arguments) ? call.arguments : []
		const readStr = (arg: any): string | null => {
			const a = arg?.type === 'SpreadElement' ? arg.argument : arg
			const n = a ? unwrapExpression(a) : null
			if (!n) return null
			return n.type === 'Literal' && typeof n.value === 'string' ? String(n.value) : null
		}

		if (propName === 'schema') {
			if (args.length !== 1) {
				throw new Error('[cfg] c.schema(key) requires exactly 1 string literal argument')
			}
			const key = readStr(args[0])
			if (!key) throw new Error('[cfg] c.schema(key) requires a string literal argument')
			return { kind: 'schema', key: String(key).trim() }
		}

		if (propName === 'schemas') {
			if (args.length === 0) return { kind: 'schemas', keys: null }
			const keys: string[] = []
			for (const a of args) {
				const k = readStr(a)
				if (!k) throw new Error('[cfg] c.schemas(...keys) requires string literal arguments')
				const kk = String(k).trim()
				if (kk) keys.push(kk)
			}
			return { kind: 'schemas', keys: keys.length > 0 ? keys : null }
		}

		throw new Error('[cfg] invalid interpolation in cfg(schemaMap)`...`')
	}

	const marker = '\u0000__CFG_VAL__\u0000'
	let raw = ''
	const n = Math.max(quasis.length, expressions.length + 1)
	for (let i = 0; i < n; i++) {
		raw += readQuasi(quasis[i])
		if (i < expressions.length) raw += `${marker}${i}${marker}`
	}

	raw = normalizeMarkdownTemplate(raw)

	const parts: ExtractedLayoutPart[] = []
	const re = new RegExp(`${marker}(\\d+)${marker}`, 'g')
	let last = 0
	for (;;) {
		const match = re.exec(raw)
		if (!match) break
		const start = match.index
		const end = start + match[0].length
		const chunk = raw.slice(last, start)
		if (chunk) parts.push({ kind: 'md', text: chunk })
		const idx = Number(match[1])
		if (!Number.isInteger(idx) || idx < 0 || idx >= expressions.length) {
			throw new Error('[cfg] internal interpolation index out of range')
		}
		parts.push(toPart(expressions[idx]))
		last = end
	}
	const tail = raw.slice(last)
	if (tail) parts.push({ kind: 'md', text: tail })

	const merged = mergeAdjacentMarkdown(parts)
	assertValidExtractedLayout(merged)
	// Drop empty layout (no text, no tokens).
	const hasContent = merged.some((p) => (p.kind === 'md' ? p.text.trim() : true))
	return hasContent ? merged : null
}

function extractCfgSchemaMapExpr(
	moduleInfo: ModuleInfo,
	ast: Program,
	expr: Expression,
): Expression | null {
	const normalized = unwrapExpression(expr as any) as any

	const isCfgCallee = (callee: any): boolean => {
		if (!callee) return false
		const c = unwrapExpression(callee) as any
		if (c?.type === 'Identifier' && c.name === 'cfg') return true
		if (c?.type === 'MemberExpression' && !c.computed) {
			const p = c.property
			if (p?.type === 'Identifier' && p.name === 'cfg') return true
			if (readLiteralString(p) === 'cfg') return true
			return false
		}
		if (c?.type === 'SequenceExpression') {
			const exprs = Array.isArray(c.expressions) ? c.expressions : []
			return exprs.length > 0 ? isCfgCallee(exprs.at(-1)) : false
		}
		return false
	}

	const resolveCfgCallExpr = (raw: any): CallExpression | null => {
		const node = raw ? (unwrapExpression(raw) as any) : null
		if (!node) return null

		if (node.type === 'CallExpression') {
			return isCfgCallee(node.callee) ? (node as CallExpression) : null
		}

		if (node.type === 'Identifier') {
			const decl = moduleInfo.declarations.get(node.name)
			if (!decl) return null
			const n = unwrapExpression(decl.node as any) as any
			return n?.type === 'CallExpression' && isCfgCallee(n.callee) ? (n as CallExpression) : null
		}

		if (node.type === 'MemberExpression' && !node.computed) {
			const obj = node.object
			const prop = node.property
			if (obj?.type !== 'Identifier') return null
			const className = obj.name
			const propName = prop?.type === 'Identifier' ? prop.name : readLiteralString(prop)
			if (!className || !propName) return null

			// Static class field: `class X { static c = cfg(...) }`
			for (const stmt of ast.body) {
				const classDecl =
					stmt.type === 'ClassDeclaration'
						? stmt
						: stmt.type === 'ExportNamedDeclaration' &&
							  stmt.declaration?.type === 'ClassDeclaration'
							? stmt.declaration
							: stmt.type === 'ExportDefaultDeclaration' &&
								  stmt.declaration.type === 'ClassDeclaration'
								? stmt.declaration
								: null
				if (!classDecl) continue
				if (classDecl.id?.name !== className) continue
				for (const m of classDecl.body.body) {
					if (m.type !== 'PropertyDefinition') continue
					const pd = m as any
					if (!pd.static) continue
					const key = pd.key
					const k = key?.type === 'Identifier' ? key.name : readLiteralString(key)
					if (k !== propName) continue
					const init = pd.value ? unwrapExpression(pd.value) : null
					if (init?.type === 'CallExpression' && isCfgCallee(init.callee))
						return init as CallExpression
				}
			}

			// Static assignment: `X.c = cfg(...)` in module scope
			for (const stmt of ast.body) {
				if (stmt.type !== 'ExpressionStatement') continue
				const e = unwrapExpression((stmt as any).expression) as any
				if (!e || e.type !== 'AssignmentExpression') continue
				const left = unwrapExpression(e.left) as any
				if (!left || left.type !== 'MemberExpression' || left.computed) continue
				const lo = left.object
				const lp = left.property
				if (lo?.type !== 'Identifier' || lo.name !== className) continue
				const lk = lp?.type === 'Identifier' ? lp.name : readLiteralString(lp)
				if (lk !== propName) continue
				const right = unwrapExpression(e.right) as any
				if (right?.type === 'CallExpression' && isCfgCallee(right.callee))
					return right as CallExpression
			}
		}

		return null
	}

	// Tagged template: cfg(schemaMap)`...` (layout source extraction happens elsewhere)
	if (normalized?.type === 'TaggedTemplateExpression') {
		const rawTag = normalized.tag
		const tag = rawTag ? unwrapExpression(rawTag) : null
		// Reject legacy `cfg`...` without schemaMap.
		if (tag?.type === 'Identifier' && tag.name === 'cfg') {
			throw new Error(`[cfg] cfg(schemaMap) is required: ${String((expr as any).start ?? '')}`)
		}
		const call = resolveCfgCallExpr(tag)
		if (!call) return null
		const args = call.arguments ?? []
		const firstArg = args[0]
		const mapExpr = firstArg
			? firstArg.type === 'SpreadElement'
				? firstArg.argument
				: firstArg
			: null
		return mapExpr ? (mapExpr as Expression) : null
	}

	// Canonical form: cfg(schemaMap)
	if (normalized?.type === 'CallExpression') {
		if (isCfgCallee(normalized.callee)) {
			const args = (normalized as CallExpression).arguments ?? []
			const firstArg = args[0]
			const mapExpr = firstArg
				? firstArg.type === 'SpreadElement'
					? firstArg.argument
					: firstArg
				: null
			return mapExpr ? (mapExpr as Expression) : null
		}
		// Downleveled tagged-template: c(templateObject()) where c is `cfg(schemaMap)`
		{
			const call = resolveCfgCallExpr(normalized.callee)
			if (call) {
				const args = (call as CallExpression).arguments ?? []
				const firstArg = args[0]
				const mapExpr = firstArg
					? firstArg.type === 'SpreadElement'
						? firstArg.argument
						: firstArg
					: null
				return mapExpr ? (mapExpr as Expression) : null
			}
		}
	}

	// Direct reference: `const c = cfg(schemaMap); ... this.configs.use(c)`
	if (normalized?.type === 'Identifier' || normalized?.type === 'MemberExpression') {
		const call = resolveCfgCallExpr(normalized)
		if (call) {
			const args = call.arguments ?? []
			const firstArg = args[0]
			const mapExpr = firstArg
				? firstArg.type === 'SpreadElement'
					? firstArg.argument
					: firstArg
				: null
			return mapExpr ? (mapExpr as Expression) : null
		}
	}

	return null
}

async function extractCfgSchemasFromSchemaMapExpr(
	moduleInfo: ModuleInfo,
	ast: Program,
	mapExpr: Expression,
	kind: string,
	ctx: ResolveContext,
): Promise<{
	keys: string[]
	entries: Array<{
		key: string
		schemaExpr: Expression
		moduleInfo: ModuleInfo
		registerExpr: string
	}>
}> {
	const entries: Array<{
		key: string
		schemaExpr: Expression
		moduleInfo: ModuleInfo
		registerExpr: string
	}> = []
	const keys: string[] = []
	const seen = new Set<string>()

	const normalizedMapExpr = unwrapExpression(mapExpr as any) as any
	const mapRefExpr =
		normalizedMapExpr &&
		typeof normalizedMapExpr.start === 'number' &&
		typeof normalizedMapExpr.end === 'number'
			? moduleInfo.code.slice(normalizedMapExpr.start, normalizedMapExpr.end)
			: null
	const canUseMapAccessForRegister =
		normalizedMapExpr?.type === 'Identifier' || normalizedMapExpr?.type === 'MemberExpression'

	const resolveStaticClassSchemaMap = (member: any): Expression | null => {
		// Support `SomeClass.schemas` when it is a static property initialized with an object literal
		// in the same module (common pattern in tests and plugin classes).
		if (!member || member.type !== 'MemberExpression') return null
		if (member.computed) return null
		if (member.object?.type !== 'Identifier') return null
		if (member.property?.type !== 'Identifier') return null

		const className = member.object.name
		const propName = member.property.name
		if (!className || !propName) return null

		for (const node of ast.body) {
			const classDecl =
				node.type === 'ClassDeclaration'
					? node
					: node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration'
						? node.declaration
						: node.type === 'ExportDefaultDeclaration' &&
							  node.declaration.type === 'ClassDeclaration'
							? node.declaration
							: null
			if (!classDecl || classDecl.id?.name !== className) continue

			for (const m of classDecl.body.body) {
				if (m.type !== 'PropertyDefinition') continue
				const pd = m as any
				if (!pd.static) continue
				const key = pd.key
				if (key?.type !== 'Identifier' || key.name !== propName) continue
				const v = pd.value ? unwrapExpression(pd.value as any) : null
				if (!v) return null
				return v as Expression
			}
		}

		return null
	}

	const parseObjectSchemaMap = async (obj: Expression, schemaKind: string) => {
		const normalizedObj = unwrapExpression(obj as any) as any

		let targetModule = moduleInfo
		let target: any = normalizedObj

		if (target.type === 'Identifier') {
			const resolved = await resolveIdentifierExpressionNode(moduleInfo, target.name, ctx)
			if (!resolved) {
				throw new Error(
					`[cfg] ${schemaKind} schemaMap identifier must be a module-scope const or an imported const export: ${moduleInfo.id}`,
				)
			}
			targetModule = resolved.moduleInfo
			target = unwrapExpression(resolved.expr as any)
		} else if (target.type === 'MemberExpression') {
			const resolved = resolveStaticClassSchemaMap(target)
			if (resolved) target = resolved
		}

		if (!target || target.type !== 'ObjectExpression') {
			throw new Error(`[cfg] ${schemaKind} must receive an object literal: ${moduleInfo.id}`)
		}

		for (const prop of target.properties) {
			if (prop.type !== 'Property') {
				throw new Error(`[cfg] ${schemaKind} does not support spread properties: ${moduleInfo.id}`)
			}
			if (prop.computed) {
				throw new Error(
					`[cfg] ${schemaKind} keys must be static (no computed keys): ${moduleInfo.id}`,
				)
			}
			let key: string | null = null
			if (prop.key.type === 'Identifier') key = prop.key.name
			else {
				const stringKey = readLiteralString(prop.key)
				const numberKey = readLiteralNumber(prop.key)
				if (stringKey !== null && stringKey !== undefined) key = stringKey
				else if (numberKey !== null && numberKey !== undefined) key = String(numberKey)
			}
			if (key === null || key === undefined) {
				throw new Error(`[cfg] ${kind} key type not supported: ${moduleInfo.id}`)
			}
			const k = String(key ?? '').trim()
			if (!k) throw new Error(`[cfg] ${kind} key is empty: ${moduleInfo.id}`)
			const v = prop.value as Expression
			if (seen.has(k)) throw new Error(`[cfg] duplicate ${kind} key "${k}" in ${moduleInfo.id}`)
			seen.add(k)
			keys.push(k)

			// Register schema with a stable reference when possible:
			// - schemaMap identifier / member access: map["key"]
			// - inline object literal: inline expression source
			const registerExpr =
				canUseMapAccessForRegister && mapRefExpr
					? `${mapRefExpr}[${JSON.stringify(k)}]`
					: moduleInfo.code.slice(v.start, v.end)

			entries.push({ key: k, schemaExpr: v, moduleInfo: targetModule, registerExpr })
		}
	}

	await parseObjectSchemaMap(mapExpr as Expression, kind)
	return { keys, entries }
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
	// Allow wrappers like `(expr)` / `expr as const` around the declaration.
	return { schemaExpr: unwrapExpression(resolved as any) as Expression }
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
	// Allow wrappers like `(expr)` / `expr as const`.
	return { featureExpr: unwrapExpression(resolved as any) as Expression }
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
	bindings: ExtractedBinding[],
	layouts: ExtractedConfigLayout[],
	features: ExtractedFeatureUse[],
	parseProgram: (code: string, filename: string) => Program,
): string {
	if (
		configs.length === 0 &&
		bindings.length === 0 &&
		layouts.length === 0 &&
		features.length === 0
	)
		return ''

	const needsRegister = configs.some(
		(c) => typeof c.registerExpr === 'string' && c.registerExpr.length > 0,
	)

	const lines: string[] = ['// [pluxel-config-source] Injected metadata']

	if (configs.length > 0 || bindings.length > 0 || layouts.length > 0 || features.length > 0) {
		const imports: string[] = []
		if (configs.length > 0) {
			imports.push('__setConfigSource__')
			if (needsRegister) imports.push('__registerConfigSchema__')
		}
		if (layouts.length > 0) imports.push('__setConfigLayout__')
		if (bindings.length > 0) imports.push('__registerConfigBinding__')
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

		for (const { className, fieldName, layout } of layouts) {
			lines.push(
				`__setConfigLayout__(${className}, ${JSON.stringify(fieldName)}, ${JSON.stringify(layout)});`,
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

	if (bindings.length > 0) {
		for (const b of bindings) {
			lines.push(
				`__registerConfigBinding__(${b.className}, ${JSON.stringify(b.fieldName)}, ${JSON.stringify(b.keys)});`,
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
