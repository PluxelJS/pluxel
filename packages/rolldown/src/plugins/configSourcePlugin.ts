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
import type { Decorator, Program, PropertyDefinition } from 'oxc-parser'
import { parseSync } from 'oxc-parser'
import type { Plugin } from 'vite'
import { normalizePath } from 'vite'
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

interface PendingResolve {
	className: string
	fieldName: string
	importSource: string
	importedName: string
	localName: string
}

interface ExtractResult {
	extracted: ExtractedConfig[]
	pendingResolve: PendingResolve[]
}

// 跨文件 schema 缓存：moduleId -> Map<exportName, source>
const schemaCache = new Map<string, Map<string, string>>()

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
				// 以 @Plugin 为标记（@Plugin 和 @Config 必须一起出现）
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
						collectExportedSchemas(code, normalizedId, ast)
					} catch {
						// 解析失败，忽略
					}
					return null
				}

				// 没有 @Config 就不需要提取
				if (!code.includes('@Config')) {
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
					collectExportedSchemas(code, normalizedId, ast)

					// 第二步：提取 @Config 装饰器源代码
					const { extracted, pendingResolve } = extractConfigSources(code, id, ast)

					// 第三步：尝试解析跨文件引用
					for (const pending of pendingResolve) {
						const resolved = await this.resolve(pending.importSource, id)
						if (resolved) {
							const resolvedId = normalizePath(resolved.id)

							// 检查缓存中是否已有该模块的 schema
							const moduleSchemas = schemaCache.get(resolvedId)
							if (moduleSchemas) {
								const source =
									moduleSchemas.get(pending.importedName) ?? moduleSchemas.get(pending.localName)
								if (source) {
									extracted.push({
										className: pending.className,
										fieldName: pending.fieldName,
										source,
									})
									continue
								}
							}

							// 直接从文件系统读取源码（更可靠）
							try {
								const targetCode = await readFile(resolvedId, 'utf-8')
								const targetAst = this.parse(targetCode, { sourceType: 'module' }) as Program
								collectExportedSchemas(targetCode, resolvedId, targetAst)

								// 再次检查缓存
								const targetSchemas = schemaCache.get(resolvedId)
								if (targetSchemas) {
									const source =
										targetSchemas.get(pending.importedName) ?? targetSchemas.get(pending.localName)
									if (source) {
										extracted.push({
											className: pending.className,
											fieldName: pending.fieldName,
											source,
										})
									}
								}
							} catch {
								// 读取或解析失败，跳过
							}
						}
					}

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
 * 收集模块中导出的 schema 定义，并更新缓存
 */
function collectExportedSchemas(code: string, moduleId: string, ast: Program): void {
	const moduleCache = new Map<string, string>()

	for (const node of ast.body) {
		// export const schema = v.object({...})
		if (
			node.type === 'ExportNamedDeclaration' &&
			node.declaration?.type === 'VariableDeclaration'
		) {
			const varDecl = node.declaration
			if (varDecl.kind === 'const') {
				for (const decl of varDecl.declarations) {
					if (decl.id.type === 'Identifier' && decl.init) {
						const initSource = code.slice(decl.init.start, decl.init.end)
						if (isLikelyValibotSchema(initSource)) {
							moduleCache.set(decl.id.name, initSource)
						}
					}
				}
			}
		}

		// const schema = v.object({...})（非导出，但可能被本地使用）
		if (node.type === 'VariableDeclaration' && node.kind === 'const') {
			for (const decl of node.declarations) {
				if (decl.id.type === 'Identifier' && decl.init) {
					const initSource = code.slice(decl.init.start, decl.init.end)
					if (isLikelyValibotSchema(initSource)) {
						moduleCache.set(decl.id.name, initSource)
					}
				}
			}
		}
	}

	if (moduleCache.size > 0) {
		schemaCache.set(moduleId, moduleCache)
	}
}

/**
 * 简单启发式检测是否是 valibot schema
 */
function isLikelyValibotSchema(source: string): boolean {
	return /\bv\./.test(source) || /\bvalibot\./.test(source) || /\bf\./.test(source)
}

/**
 * 提取 @Config 装饰器的源代码
 */
function extractConfigSources(code: string, moduleId: string, ast: Program): ExtractResult {
	const extracted: ExtractedConfig[] = []
	const pendingResolve: PendingResolve[] = []

	// 收集本文件的顶层声明
	const localDeclarations = new Map<string, string>()
	// 收集导入映射：localName -> { source, imported }
	const imports = new Map<string, { source: string; imported: string }>()

	// 第一遍：收集声明和导入
	for (const node of ast.body) {
		// 收集导入
		if (node.type === 'ImportDeclaration') {
			const source = node.source.value
			for (const spec of node.specifiers) {
				if (spec.type === 'ImportSpecifier') {
					const imported =
						spec.imported.type === 'Identifier'
							? spec.imported.name
							: (spec.imported as { value: string }).value
					imports.set(spec.local.name, { source, imported })
				} else if (spec.type === 'ImportDefaultSpecifier') {
					imports.set(spec.local.name, { source, imported: 'default' })
				}
			}
		}

		// 收集本地 const 声明
		if (node.type === 'VariableDeclaration' && node.kind === 'const') {
			for (const decl of node.declarations) {
				if (decl.id.type === 'Identifier' && decl.init) {
					localDeclarations.set(decl.id.name, code.slice(decl.init.start, decl.init.end))
				}
			}
		}

		// 收集导出的 const 声明
		if (
			node.type === 'ExportNamedDeclaration' &&
			node.declaration?.type === 'VariableDeclaration'
		) {
			const varDecl = node.declaration
			if (varDecl.kind === 'const') {
				for (const decl of varDecl.declarations) {
					if (decl.id.type === 'Identifier' && decl.init) {
						localDeclarations.set(decl.id.name, code.slice(decl.init.start, decl.init.end))
					}
				}
			}
		}
	}

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
				const result = extractConfigDecoratorSource(
					decorator,
					code,
					localDeclarations,
					imports,
					className,
					fieldName,
					moduleId,
				)
				if (result.type === 'resolved') {
					extracted.push({
						className,
						fieldName,
						source: result.source,
					})
				} else if (result.type === 'pending') {
					pendingResolve.push(result.pending)
				}
			}
		}
	}

	return { extracted, pendingResolve }
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

type ExtractDecoratorResult =
	| { type: 'resolved'; source: string }
	| { type: 'pending'; pending: PendingResolve }
	| { type: 'none' }

/**
 * 从装饰器提取 schema 源代码
 */
function extractConfigDecoratorSource(
	decorator: Decorator,
	code: string,
	localDecls: Map<string, string>,
	imports: Map<string, { source: string; imported: string }>,
	className: string,
	fieldName: string,
	_moduleId: string,
): ExtractDecoratorResult {
	const expr = decorator.expression
	if (expr.type !== 'CallExpression') return { type: 'none' }

	// 检查是否是 @Config 调用
	const callee = expr.callee
	const isConfigCall =
		(callee.type === 'Identifier' && callee.name === 'Config') ||
		(callee.type === 'MemberExpression' &&
			callee.property.type === 'Identifier' &&
			callee.property.name === 'Config')

	if (!isConfigCall) return { type: 'none' }
	if (expr.arguments.length === 0) return { type: 'none' }

	const arg = expr.arguments[0]

	// 如果参数是标识符，尝试解析
	if (arg.type === 'Identifier') {
		const name = arg.name

		// 1. 先查本地声明
		const localSource = localDecls.get(name)
		if (localSource) return { type: 'resolved', source: localSource }

		// 2. 查导入，返回待解析信息
		const importInfo = imports.get(name)
		if (importInfo) {
			// 先尝试从缓存中解析跨文件引用
			for (const entry of Array.from(schemaCache.entries())) {
				const [cachedModuleId, moduleSchemas] = entry
				if (
					cachedModuleId.includes(importInfo.source.replace(/^\.\//, '').replace(/^\.\.\//, ''))
				) {
					const exportedName = importInfo.imported === 'default' ? 'default' : importInfo.imported
					const cachedSource = moduleSchemas.get(exportedName) ?? moduleSchemas.get(name)
					if (cachedSource) return { type: 'resolved', source: cachedSource }
				}
			}

			// 返回待解析信息，让调用方通过 this.resolve/this.load 解析
			return {
				type: 'pending',
				pending: {
					className,
					fieldName,
					importSource: importInfo.source,
					importedName: importInfo.imported,
					localName: name,
				},
			}
		}

		// 无法解析，返回标识符名作为 fallback
		return { type: 'resolved', source: name }
	}

	// 否则，直接提取参数源代码
	return { type: 'resolved', source: code.slice(arg.start, arg.end) }
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
		// 将 source 压缩（移除多余空白）后作为字符串字面量注入
		const compactSource = source
			.replace(/\s+/g, ' ')
			.replace(/\(\s+/g, '(')
			.replace(/\s+\)/g, ')')
			.replace(/{\s+/g, '{')
			.replace(/\s+}/g, '}')
			.replace(/,\s+/g, ',')
			.replace(/:\s+/g, ':')
			.trim()
		const final = normalizeSchemaSource(compactSource)
		const escapedSource = JSON.stringify(final)
		lines.push(`__setConfigSource__(${className}, ${JSON.stringify(fieldName)}, ${escapedSource});`)
	}

	return lines.join('\n')
}
