/**
 * Rolldown plugin to extract @Config decorator source code at compile time.
 *
 * Features:
 * - Uses rolldown filter pattern for efficient JS-Rust communication
 * - Uses this.parse() with lang option for TypeScript-aware parsing
 * - Uses fs.readFile() for reliable cross-file schema resolution
 * - Injects __setConfigSource__ calls with string literals into output
 */

import { readFile } from 'node:fs/promises'
import type {
	CallExpression,
	Decorator,
	Expression,
	IdentifierName,
	ObjectProperty,
	Program,
	PropertyDefinition,
	SpreadElement,
} from 'oxc-parser'
import { normalize as normalizePath } from 'pathe'
import type { Plugin } from 'vite'
import { normalizeSchemaSource } from '../utils/configHandler'

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

/**
 * 解析上下文 - 用于缓存已解析的标识符值，避免重复解析
 */
interface ResolveContext {
	moduleResolver: ModuleResolver
	/** 解析代码为 AST（使用 rolldown 的 this.parse） */
	parse: (code: string, moduleId: string) => Program
	/** 已解析的标识符值缓存: key = "moduleId::name", value = resolved source */
	resolvedValues: Map<string, string>
	/** 正在解析的标识符（用于循环检测） */
	pending: Set<string>
}

// 模块级 schema 信息缓存
const moduleInfoCache = new Map<string, ModuleInfo>()
const moduleInfoPromises = new Map<string, Promise<ModuleInfo | undefined>>()
const DEFAULT_EXPORT = '__pluxel_default_export__'
const CONFIG_DECORATOR_SOURCES = ['@pluxel/core', '@pluxel/hmr'] as const

/** 根据文件扩展名获取 parser lang 选项 */
function getLangFromId(id: string): 'ts' | 'tsx' | 'js' | 'jsx' {
	if (id.endsWith('.tsx')) return 'tsx'
	if (id.endsWith('.ts')) return 'ts'
	if (id.endsWith('.jsx')) return 'jsx'
	return 'js'
}

export function configSourcePlugin(options: ConfigSourcePluginOptions = {}): Plugin {
	const includePatterns = options.include ?? ['**/*.ts']
	const excludePatterns = options.exclude ?? ['**/node_modules/**', '**/*.d.ts']

	return {
		name: 'pluxel-config-source',
		enforce: 'pre',
		// 使用 rolldown filter 模式减少 JS-Rust 通信开销
		transform: {
			filter: {
				id: {
					include: includePatterns,
					exclude: excludePatterns,
				},
				// 以 @Plugin 为标记（@Config 可能被重命名）
				// 同时匹配可能有 schema 定义的文件（v./valibot./f.）
				code: {
					include: /@Plugin|v\.|valibot\.|f\./,
				},
			},
			async handler(code, id) {
				const normalizedId = normalizePath(id)

				// 如果没有 @Plugin，只收集 schema 定义（为跨文件引用做准备）
				if (!code.includes('@Plugin')) {
					try {
						const ast = this.parse(code, { lang: getLangFromId(id) }) as Program
						collectModuleInfo(code, normalizedId, ast)
					} catch {
						// 解析失败，忽略
					}
					return null
				}

				let ast: Program
				try {
					// 使用 this.parse() 的 lang 选项支持 TypeScript
					ast = this.parse(code, { lang: getLangFromId(id) }) as Program
				} catch (err) {
					this.warn(`Failed to parse ${id}: ${err}`)
					return null
				}

				try {
					// 第一步：收集并缓存本模块的导出 schema 定义
					const moduleInfo = collectModuleInfo(code, normalizedId, ast)

					const resolveModuleId: ModuleResolver = async (sourceSpecifier, importer) => {
						const resolved = await this.resolve(sourceSpecifier, importer)
						if (!resolved) return null
						const cleaned = resolved.id.split('?')[0]
						return normalizePath(cleaned)
					}

					// 第二步：提取 @Config 装饰器源代码
					const ctx: ResolveContext = {
						moduleResolver: resolveModuleId,
						parse: (source, moduleId) =>
							this.parse(source, { lang: getLangFromId(moduleId) }) as Program,
						resolvedValues: new Map(),
						pending: new Set(),
					}
					const extracted = await extractConfigSources(moduleInfo, ast, ctx)

					if (extracted.length === 0) return null

					// 生成注入代码
					const injection = generateInjection(extracted)
					return {
						code: code + '\n' + injection,
						map: null,
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
function collectModuleInfo(code: string, moduleId: string, ast: Program): ModuleInfo {
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
				} else if (decl.type !== 'FunctionDeclaration' && decl.type !== 'ClassDeclaration') {
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

	moduleInfoCache.set(moduleId, info)
	return info
}

async function ensureModuleInfo(
	moduleId: string,
	ctx: ResolveContext,
): Promise<ModuleInfo | undefined> {
	const cached = moduleInfoCache.get(moduleId)
	if (cached) return cached

	const pending = moduleInfoPromises.get(moduleId)
	if (pending) return pending

	const promise = (async () => {
		try {
			const source = await readFile(moduleId, 'utf-8')
			const parsed = ctx.parse(source, moduleId)
			return collectModuleInfo(source, moduleId, parsed)
		} catch {
			return undefined
		} finally {
			moduleInfoPromises.delete(moduleId)
		}
	})()

	moduleInfoPromises.set(moduleId, promise)
	return promise
}

type ModuleResolver = (source: string, importer: string) => Promise<string | null>

function isConfigImportSource(source: string): boolean {
	for (const base of CONFIG_DECORATOR_SOURCES) {
		if (source === base || source.startsWith(`${base}/`)) return true
	}
	return false
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
	if (normalized.type === 'CallExpression' && isObjectSchemaCall(normalized.callee)) {
		return expandObjectCallWithInlining(moduleInfo, normalized, ctx)
	}
	const replacements = await collectIdentifierReplacements(normalized, moduleInfo, ctx)
	if (replacements.length === 0) return moduleInfo.code.slice(normalized.start, normalized.end)
	return applyReplacements(moduleInfo.code, normalized.start, normalized.end, replacements)
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

function isObjectSchemaCall(callee: Expression): boolean {
	if (callee.type !== 'MemberExpression') return false
	if (callee.computed) return false
	if (callee.property.type !== 'Identifier') return false
	const propName = callee.property.name
	if (propName !== 'object' && propName !== 'objectAsync') return false
	if (callee.object.type !== 'Identifier') return false
	const objName = (callee.object as IdentifierName).name
	return objName === 'v' || objName === 'valibot'
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

	const visit = async (child: Expression | null | undefined) => {
		if (!child) return
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
				if (prop.computed && prop.key.type !== 'Identifier') {
					await visit(prop.key as Expression)
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

function isSpreadElement(node: any): node is SpreadElement {
	return node?.type === 'SpreadElement'
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

	// 第二遍：查找带 @Plugin 的类（因为 @Config 和 @Plugin 必须一起出现）
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

		// 检查类是否有 @Plugin 装饰器
		if (!hasPluginDecorator(classDecl.decorators)) continue

		const className = classDecl.id?.name ?? 'AnonymousClass'

		for (const member of classDecl.body.body) {
			if (member.type !== 'PropertyDefinition') continue

			const propDef = member as PropertyDefinition
			const fieldName =
				propDef.key.type === 'Identifier'
					? propDef.key.name
					: propDef.key.type === 'PrivateIdentifier'
						? propDef.key.name
						: null

			if (!fieldName || !propDef.decorators) continue

			for (const decorator of propDef.decorators) {
				const source = await extractConfigDecoratorSource(decorator, moduleInfo, ctx)
				if (source) {
					extracted.push({
						className,
						fieldName,
						source,
					})
				}
			}
		}
	}

	return extracted
}

/**
 * 检查装饰器列表是否包含 @Plugin
 */
function hasPluginDecorator(decorators: Decorator[] | undefined | null): boolean {
	if (!decorators) return false
	for (const decorator of decorators) {
		const expr = decorator.expression
		// @Plugin() 或 @Plugin(...)
		if (expr.type === 'CallExpression') {
			const callee = expr.callee
			if (callee.type === 'Identifier' && callee.name === 'Plugin') return true
			if (
				callee.type === 'MemberExpression' &&
				callee.property.type === 'Identifier' &&
				callee.property.name === 'Plugin'
			)
				return true
		}
		// @Plugin（无括号，理论上不应该出现但防御性处理）
		if (expr.type === 'Identifier' && expr.name === 'Plugin') return true
	}
	return false
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
function generateInjection(configs: ExtractedConfig[]): string {
	if (configs.length === 0) return ''

	const lines: string[] = [
		'// [pluxel-config-source] Injected @Config source metadata',
		'import { __setConfigSource__ } from "@pluxel/core";',
	]

	for (const { className, fieldName, source } of configs) {
		// 将 source 压缩（移除多余空白和尾随逗号）后作为字符串字面量注入
		const compactSource = source
			.replace(/\s+/g, ' ')
			.replace(/\(\s+/g, '(')
			.replace(/\s+\)/g, ')')
			.replace(/{\s+/g, '{')
			.replace(/\s+}/g, '}')
			.replace(/,\s+/g, ',')
			.replace(/:\s+/g, ':')
			.replace(/,\)/g, ')') // 移除尾随逗号 ,) -> )
			.replace(/,}/g, '}') // 移除尾随逗号 ,} -> }
			.replace(/,]/g, ']') // 移除尾随逗号 ,] -> ]
			.trim()
		const final = normalizeSchemaSource(compactSource)
		const escapedSource = JSON.stringify(final)
		lines.push(`__setConfigSource__(${className}, ${JSON.stringify(fieldName)}, ${escapedSource});`)
	}

	return lines.join('\n')
}
