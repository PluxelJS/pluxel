/**
 * Rolldown plugin to fix `import type` -> `import` for @Plugin decorated classes.
 *
 * Problem:
 * When a class constructor parameter uses a type-only import (`import type { Foo }`),
 * TypeScript's emitDecoratorMetadata cannot emit runtime type information for DI.
 * This plugin converts such imports back to value imports for classes decorated with @Plugin.
 *
 * Vite 8+ plugins are Rolldown plugins and support hook filters, so a single plugin works for both:
 * - Vite/Vitest (dev + test pipeline)
 * - Rolldown (CLI build pipeline)
 *
 * Features:
 * - Uses hook filters to avoid per-module JS filtering in userland
 * - Uses this.parse() with lang option for TypeScript-aware parsing
 * - Only affects imports used as constructor parameter types in @Plugin classes
 * - Preserves other type-only imports that aren't needed at runtime
 */
import type { ImportDeclaration, Program } from 'oxc-parser'
import type { TransformPluginContext } from 'rolldown'
import type { ViteCompatPlugin } from './compat'
import { allowOptionalQuerySuffix } from './compat'
import { normalizeViteId } from './viteNormalizeId'
import { normalizePatterns, parseWithLang } from './pluginUtils'

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

const CODE_HINT = /@Plugin|\bPlugin\s*\(|__decorate\s*\(/

export function importTypeFixerPlugin(options: ImportTypeFixerPluginOptions = {}): ViteCompatPlugin {
	const includePatterns = normalizePatterns(options.include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
	]).map(
		allowOptionalQuerySuffix,
	)
	const excludePatterns = normalizePatterns(options.exclude, [
		'**/node_modules/**',
		'**/*.d.ts',
		'**/*.d.mts',
		'**/*.d.cts',
	]).map(allowOptionalQuerySuffix)

	return {
		name: 'pluxel-import-type-fixer',
		enforce: 'pre',

		transform: {
			filter: {
				id: {
					include: includePatterns,
					exclude: excludePatterns,
				},
				// 只处理包含 @Plugin 的文件
				code: {
					include: CODE_HINT,
				},
			},
			handler(this: TransformPluginContext, code, id) {
				const normalizedId = normalizeViteId(id)
				const ast = parseWithLang(this, code, normalizedId)
				if (!ast) {
					this.warn(`Failed to parse ${id}`)
					return null
				}
				try {
					const fixed = rewriteTypeOnlyImports(code, ast)
					if (!fixed) return null
					return { code: fixed, map: null as null }
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
	specifiers: Array<{
		localName: string
		isTypeOnly: boolean
		start: number
		end: number
		type: 'ImportSpecifier' | 'ImportDefaultSpecifier' | 'ImportNamespaceSpecifier'
	}>
}

function rewriteTypeOnlyImports(code: string, ast: Program): string | null {
	// 1. 收集所有 type-only imports
	const typeOnlyImports = collectTypeOnlyImports(code, ast)
	if (typeOnlyImports.length === 0) return null

	// 2. 收集 @Plugin 类的构造函数参数类型
	const constructorParamTypes = collectConstructorParamTypes(code, ast)
	if (constructorParamTypes.size === 0) return null

	// 3. 找出需要修复的 imports（构造函数参数中使用的 type-only imports）
	const importsToFix: ImportToFix[] = []
	for (const importInfo of typeOnlyImports) {
		const usedTypeSpecifiers = importInfo.specifiers.filter(
			(spec) => spec.isTypeOnly && constructorParamTypes.has(spec.localName),
		)
		if (usedTypeSpecifiers.length === 0) continue
		const original = code.slice(importInfo.start, importInfo.end)
		const fixed = convertTypeImportToValueImport(original, importInfo, usedTypeSpecifiers)
		if (fixed && fixed !== original) {
			importsToFix.push({
				start: importInfo.start,
				end: importInfo.end,
				original,
				fixed,
			})
		}
	}

	if (importsToFix.length === 0) return null

	// 4. 应用修复（从后向前，避免位置偏移）
	let result = code
	importsToFix.sort((a, b) => b.start - a.start)
	for (const fix of importsToFix) {
		result = result.slice(0, fix.start) + fix.fixed + result.slice(fix.end)
	}

	return result
}

/**
 * 收集所有 type-only imports
 * - `import type { Foo } from 'bar'` (整体 type-only)
 * - `import { type Foo } from 'bar'` (单个 specifier type-only)
 */
function collectTypeOnlyImports(code: string, ast: Program): TypeOnlyImportInfo[] {
	const result: TypeOnlyImportInfo[] = []

	for (const node of ast.body) {
		if (node.type !== 'ImportDeclaration') continue

		const importNode = node as ImportDeclaration
		const isWholeTypeOnly = importNode.importKind === 'type'
		const specifiers: TypeOnlyImportInfo['specifiers'] = []

		for (const spec of importNode.specifiers) {
			if (spec.type === 'ImportSpecifier') {
				// 检查是否是 type-only（整体或单个）
				const raw = code.slice(spec.start, spec.end)
				const isTypeOnly =
					isWholeTypeOnly || spec.importKind === 'type' || /^\s*type\b/.test(raw)
				if (!isTypeOnly) continue
				const localName = spec.local.name
				specifiers.push({
					localName,
					isTypeOnly,
					start: spec.start,
					end: spec.end,
					type: 'ImportSpecifier',
				})
			} else if (spec.type === 'ImportDefaultSpecifier' && isWholeTypeOnly) {
				specifiers.push({
					localName: spec.local.name,
					isTypeOnly: true,
					start: spec.start,
					end: spec.end,
					type: 'ImportDefaultSpecifier',
				})
			} else if (spec.type === 'ImportNamespaceSpecifier' && isWholeTypeOnly) {
				specifiers.push({
					localName: spec.local.name,
					isTypeOnly: true,
					start: spec.start,
					end: spec.end,
					type: 'ImportNamespaceSpecifier',
				})
			}
		}

		if (specifiers.length > 0) {
			result.push({
				node: importNode,
				start: importNode.start,
				end: importNode.end,
				specifiers,
			})
		}
	}

	return result
}

/**
 * 收集 @Plugin 类的构造函数参数类型名
 */
function collectConstructorParamTypes(code: string, ast: Program): Set<string> {
	const result = new Set<string>()
	const allowUndecorated = code.includes('@Plugin')

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
		if (!hasPluginDecorator(classDecl.decorators) && !allowUndecorated) continue

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
function convertTypeImportToValueImport(
	original: string,
	info: TypeOnlyImportInfo,
	usedTypeSpecifiers: Array<TypeOnlyImportInfo['specifiers'][number]>,
): string | null {
	// Case 1 & 2: 整体 type-only import
	if (info.node.importKind === 'type') {
		// 简单情况：直接移除 'type' 关键字
		// `import type { ... }` -> `import { ... }`
		return original.replace(/^(\s*import)\s+type\s+/, '$1 ')
	}
	// Case 3 & 4: 单个 specifier 的 type-only
	// `import { type Foo, Bar }` -> `import { Foo, Bar }`
	const replacements: Array<{ start: number; end: number; text: string }> = []
	for (const spec of usedTypeSpecifiers) {
		if (spec.type !== 'ImportSpecifier') continue
		const relStart = spec.start - info.start
		const relEnd = spec.end - info.start
		const specText = original.slice(relStart, relEnd)
		const nextText = specText.replace(/^(\\s*)type\\s+/, '$1')
		if (nextText !== specText) {
			replacements.push({ start: relStart, end: relEnd, text: nextText })
		}
	}
	if (replacements.length === 0) {
		let fallback = original
		for (const spec of usedTypeSpecifiers) {
			fallback = dropTypeKeywordForSpecifier(fallback, spec.localName)
		}
		return fallback
	}
	return applyRelativeReplacements(original, replacements)
}

function applyRelativeReplacements(
	source: string,
	replacements: Array<{ start: number; end: number; text: string }>,
): string {
	let result = ''
	let cursor = 0
	const sorted = replacements.slice().sort((a, b) => a.start - b.start)
	for (const rep of sorted) {
		if (rep.start < cursor) continue
		result += source.slice(cursor, rep.start)
		result += rep.text
		cursor = rep.end
	}
	result += source.slice(cursor)
	return result
}

function dropTypeKeywordForSpecifier(source: string, localName: string): string {
	const pattern = new RegExp(`(\\{[^}]*?)\\btype\\s+([^,}]*?\\b${localName}\\b)`, 'g')
	return source.replace(pattern, '$1$2')
}
