/**
 * Rolldown plugin to extract @Config decorator source code at compile time.
 *
 * Features:
 * - Uses rolldown filter pattern for efficient JS-Rust communication
 * - Uses oxc-parser to parse TypeScript/JavaScript code
 * - Supports cross-file schema references via module resolution
 * - Injects __setConfigSource__ calls with string literals into output
 */
import { readFile } from 'node:fs/promises'
import { parseSync, type Decorator, type Program, type PropertyDefinition } from 'oxc-parser'
import type { Plugin } from 'vite'
import { normalizePath } from 'vite'

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

export function configSourcePlugin(options: ConfigSourcePluginOptions = {}): Plugin {
	const includePatterns = options.include ?? ['**/*.ts', '**/*.tsx']
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
				// 只处理包含 @Config 或可能有 schema 定义的文件
				code: {
					include: /@Config|v\.|valibot\.|f\./,
				},
			},
			async handler(code, id) {
				// 如果没有 @Config，只收集 schema 定义
				if (!code.includes('@Config')) {
					try {
						const ast = parseSync(id, code, { sourceType: 'module' }).program
						collectExportedSchemas(code, id, ast)
					} catch {
						// 解析失败，忽略
					}
					return null
				}

				let ast: Program
				try {
					ast = parseSync(id, code, { sourceType: 'module' }).program
				} catch (err) {
					this.warn(`Failed to parse ${id}: ${err}`)
					return null
				}

				try {
					// 第一步：收集并缓存本模块的导出 schema 定义
					collectExportedSchemas(code, id, ast)

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
								const source = moduleSchemas.get(pending.importedName) ?? moduleSchemas.get(pending.localName)
								if (source) {
									extracted.push({
										className: pending.className,
										fieldName: pending.fieldName,
										source,
									})
									continue
								}
							}
							// 如果目标模块未被处理，尝试直接读取并解析它
							try {
								const targetCode = await readFile(resolvedId, 'utf-8')
								const targetAst = parseSync(resolvedId, targetCode, { sourceType: 'module' }).program
								collectExportedSchemas(targetCode, resolvedId, targetAst)
								const targetSchemas = schemaCache.get(resolvedId)
								if (targetSchemas) {
									const source = targetSchemas.get(pending.importedName) ?? targetSchemas.get(pending.localName)
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
		if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
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
					const imported = spec.imported.type === 'Identifier'
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
		if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
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

	// 第二遍：查找带 @Config 的类
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
				if (cachedModuleId.includes(importInfo.source.replace(/^\.\//, '').replace(/^\.\.\//, ''))) {
					const exportedName = importInfo.imported === 'default' ? 'default' : importInfo.imported
					const cachedSource = moduleSchemas.get(exportedName) ?? moduleSchemas.get(name)
					if (cachedSource) return { type: 'resolved', source: cachedSource }
				}
			}

			// 返回待解析信息，让调用方通过 Vite resolve 解析
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
		const compactSource = source.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/{\s+/g, '{').replace(/\s+}/g, '}').replace(/,\s+/g, ',').replace(/:\s+/g, ':').trim()
		const escapedSource = JSON.stringify(compactSource)
		lines.push(`__setConfigSource__(${className}, ${JSON.stringify(fieldName)}, ${escapedSource});`)
	}

	return lines.join('\n')
}
