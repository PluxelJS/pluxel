/**
 * Rolldown plugin to fix `import type` -> `import` for @Plugin decorated classes.
 *
 * Problem:
 * When a class constructor parameter uses a type-only import (`import type { Foo }`),
 * TypeScript's emitDecoratorMetadata cannot emit runtime type information for DI.
 * This plugin converts such imports back to value imports for classes decorated with @Plugin.
 *
 * Features:
 * - Uses rolldown filter pattern for efficient JS-Rust communication
 * - Uses this.parse() with lang option for TypeScript-aware parsing
 * - Only affects imports used as constructor parameter types in @Plugin classes
 * - Preserves other type-only imports that aren't needed at runtime
 */
import type { ImportDeclaration, Program } from 'oxc-parser'
import type { Plugin } from 'rolldown'

export interface ImportTypeFixerPluginOptions {
	/** File patterns to include (default: *.ts, *.tsx) */
	include?: string | string[]
	/** File patterns to exclude */
	exclude?: string | string[]
}

interface ImportToFix {
	/** Start position of the import statement */
	start: number
	/** End position of the import statement */
	end: number
	/** The original import statement */
	original: string
	/** The fixed import statement (type -> value) */
	fixed: string
}

/** 根据文件扩展名获取 parser lang 选项 */
function getLangFromId(id: string): 'ts' | 'tsx' | 'js' | 'jsx' {
	if (id.endsWith('.tsx')) return 'tsx'
	if (id.endsWith('.ts')) return 'ts'
	if (id.endsWith('.jsx')) return 'jsx'
	return 'js'
}

export function importTypeFixerPlugin(options: ImportTypeFixerPluginOptions = {}): Plugin {
	const includePatterns = options.include ?? ['**/*.ts', '**/*.tsx']
	const excludePatterns = options.exclude ?? ['**/node_modules/**', '**/*.d.ts']

	return {
		name: 'pluxel-import-type-fixer',

		transform: {
			filter: {
				id: {
					include: includePatterns,
					exclude: excludePatterns,
				},
				// 只处理包含 @Plugin 的文件
				code: {
					include: /@Plugin/,
				},
			},
			handler(code, id) {
				let ast: Program
				try {
					// 使用 this.parse() 的 lang 选项支持 TypeScript
					ast = this.parse(code, { lang: getLangFromId(id) }) as Program
				} catch (err) {
					this.warn(`Failed to parse ${id}: ${err}`)
					return null
				}

				try {
					// 1. 收集所有 type-only imports
					const typeOnlyImports = collectTypeOnlyImports(ast)
					if (typeOnlyImports.size === 0) return null

					// 2. 收集 @Plugin 类的构造函数参数类型
					const constructorParamTypes = collectConstructorParamTypes(code, ast)
					if (constructorParamTypes.size === 0) return null

					// 3. 找出需要修复的 imports（构造函数参数中使用的 type-only imports）
					const importsToFix: ImportToFix[] = []
					for (const [localName, importInfo] of typeOnlyImports) {
						if (constructorParamTypes.has(localName)) {
							const original = code.slice(importInfo.start, importInfo.end)
							const fixed = convertTypeImportToValueImport(original, importInfo.node)
							if (fixed && fixed !== original) {
								importsToFix.push({
									start: importInfo.start,
									end: importInfo.end,
									original,
									fixed,
								})
							}
						}
					}

					if (importsToFix.length === 0) return null

					// 4. 应用修复（从后向前，避免位置偏移）
					let result = code
					importsToFix.sort((a, b) => b.start - a.start)
					for (const fix of importsToFix) {
						result = result.slice(0, fix.start) + fix.fixed + result.slice(fix.end)
					}

					return {
						code: result,
						map: null,
					}
				} catch (err) {
					this.warn(`Failed to fix import types in ${id}: ${err}`)
					return null
				}
			},
		},
	}
}

interface TypeOnlyImportInfo {
	node: ImportDeclaration
	start: number
	end: number
	source: string
	specifiers: Array<{
		localName: string
		importedName: string
		isTypeOnly: boolean
	}>
}

/**
 * 收集所有 type-only imports
 * - `import type { Foo } from 'bar'` (整体 type-only)
 * - `import { type Foo } from 'bar'` (单个 specifier type-only)
 */
function collectTypeOnlyImports(ast: Program): Map<string, TypeOnlyImportInfo> {
	const result = new Map<string, TypeOnlyImportInfo>()

	for (const node of ast.body) {
		if (node.type !== 'ImportDeclaration') continue

		const importNode = node as ImportDeclaration
		const isWholeTypeOnly = importNode.importKind === 'type'
		const source = importNode.source.value

		for (const spec of importNode.specifiers) {
			if (spec.type === 'ImportSpecifier') {
				// 检查是否是 type-only（整体或单个）
				const isTypeOnly = isWholeTypeOnly || spec.importKind === 'type'
				if (isTypeOnly) {
					const localName = spec.local.name
					const importedName =
						spec.imported.type === 'Identifier'
							? spec.imported.name
							: (spec.imported as { value: string }).value

					result.set(localName, {
						node: importNode,
						start: importNode.start,
						end: importNode.end,
						source,
						specifiers: [{ localName, importedName, isTypeOnly }],
					})
				}
			} else if (spec.type === 'ImportDefaultSpecifier' && isWholeTypeOnly) {
				result.set(spec.local.name, {
					node: importNode,
					start: importNode.start,
					end: importNode.end,
					source,
					specifiers: [{ localName: spec.local.name, importedName: 'default', isTypeOnly: true }],
				})
			}
		}
	}

	return result
}

/**
 * 收集 @Plugin 类的构造函数参数类型名
 */
function collectConstructorParamTypes(code: string, ast: Program): Set<string> {
	const result = new Set<string>()

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

		// 找到 constructor
		for (const member of classDecl.body.body) {
			if (member.type === 'MethodDefinition' && member.kind === 'constructor') {
				const params = member.value.params
				for (const param of params) {
					// 提取参数类型注解中的类型名
					const typeNames = extractTypeNamesFromParam(param, code)
					for (const name of typeNames) {
						result.add(name)
					}
				}
			}
		}
	}

	return result
}

/**
 * 从参数中提取类型名
 */
function extractTypeNamesFromParam(param: any, _code: string): string[] {
	const names: string[] = []

	// 处理普通参数和带 accessibility modifier 的参数
	let targetParam = param
	if (param.type === 'TSParameterProperty') {
		targetParam = param.parameter
	}

	// 获取类型注解
	const typeAnnotation = targetParam.typeAnnotation?.typeAnnotation

	if (typeAnnotation) {
		extractTypeNamesFromTypeNode(typeAnnotation, names)
	}

	return names
}

/**
 * 递归提取类型节点中的类型名
 */
function extractTypeNamesFromTypeNode(typeNode: any, names: string[]): void {
	if (!typeNode) return

	switch (typeNode.type) {
		case 'TSTypeReference':
			// Foo, Bar.Baz, etc.
			if (typeNode.typeName.type === 'Identifier') {
				names.push(typeNode.typeName.name)
			} else if (typeNode.typeName.type === 'TSQualifiedName') {
				// 只取最左边的标识符（如 Bar.Baz 中的 Bar）
				let current = typeNode.typeName
				while (current.type === 'TSQualifiedName') {
					current = current.left
				}
				if (current.type === 'Identifier') {
					names.push(current.name)
				}
			}
			// 处理泛型参数
			if (typeNode.typeParameters?.params) {
				for (const tp of typeNode.typeParameters.params) {
					extractTypeNamesFromTypeNode(tp, names)
				}
			}
			break

		case 'TSUnionType':
		case 'TSIntersectionType':
			for (const t of typeNode.types) {
				extractTypeNamesFromTypeNode(t, names)
			}
			break

		case 'TSArrayType':
			extractTypeNamesFromTypeNode(typeNode.elementType, names)
			break

		case 'TSTupleType':
			for (const el of typeNode.elementTypes) {
				extractTypeNamesFromTypeNode(el, names)
			}
			break

		case 'TSConditionalType':
			extractTypeNamesFromTypeNode(typeNode.checkType, names)
			extractTypeNamesFromTypeNode(typeNode.extendsType, names)
			extractTypeNamesFromTypeNode(typeNode.trueType, names)
			extractTypeNamesFromTypeNode(typeNode.falseType, names)
			break

		case 'TSMappedType':
			extractTypeNamesFromTypeNode(typeNode.typeAnnotation, names)
			break

		case 'TSIndexedAccessType':
			extractTypeNamesFromTypeNode(typeNode.objectType, names)
			extractTypeNamesFromTypeNode(typeNode.indexType, names)
			break
	}
}

/**
 * 检查装饰器列表是否包含 @Plugin
 */
function hasPluginDecorator(decorators: any[] | undefined | null): boolean {
	if (!decorators) return false
	for (const decorator of decorators) {
		const expr = decorator.expression
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
		if (expr.type === 'Identifier' && expr.name === 'Plugin') return true
	}
	return false
}

/**
 * 将 type-only import 转换为 value import
 *
 * Cases:
 * 1. `import type { Foo } from 'bar'` -> `import { Foo } from 'bar'`
 * 2. `import type { Foo, Bar } from 'bar'` (if only Foo needed) -> keep as is, this is complex
 * 3. `import { type Foo } from 'bar'` -> `import { Foo } from 'bar'`
 * 4. `import { type Foo, Bar } from 'bar'` -> `import { Foo, Bar } from 'bar'`
 */
function convertTypeImportToValueImport(original: string, node: ImportDeclaration): string | null {
	// Case 1 & 2: 整体 type-only import
	if (node.importKind === 'type') {
		// 简单情况：直接移除 'type' 关键字
		// `import type { ... }` -> `import { ... }`
		return original.replace(/^(\s*import)\s+type\s+/, '$1 ')
	}

	// Case 3 & 4: 单个 specifier 的 type-only
	// `import { type Foo, Bar }` -> `import { Foo, Bar }`
	// 这需要更精细的处理
	let result = original

	for (const spec of node.specifiers) {
		if (spec.type === 'ImportSpecifier' && spec.importKind === 'type') {
			// 找到并移除这个 specifier 前面的 'type '
			const localName = spec.local.name
			// 匹配 `type Foo` 或 `type Foo as Bar`
			const typeSpecPattern = new RegExp(`(\\{[^}]*?)\\btype\\s+(${localName}\\b)`, 'g')
			result = result.replace(typeSpecPattern, '$1$2')
		}
	}

	return result
}
