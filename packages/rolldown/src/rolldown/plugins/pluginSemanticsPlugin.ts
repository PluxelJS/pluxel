import type { Program } from 'oxc-parser'
import type { ViteCompatPlugin } from './compat.ts'
import {
	type AstNode,
	normalizePatterns,
	parseWithLang,
	readIdentifier,
	readLiteralString,
	walkAst,
} from './pluginUtils.ts'

const ABSENT_PREFIX = '\0pluxel:optional-plugin-absent:'

export type PluginDependencyMode = 'required' | 'optional'

export type OptionalPluginCall = {
	readonly argumentCount: number
	readonly loaderEnd?: number
	readonly packageSpecifier?: string
	readonly exportName?: string
	readonly packageAnnotation?: string
	readonly topLevel: boolean
}

export type PluginSemantics = {
	readonly optionalPlugins: readonly OptionalPluginCall[]
	readonly requiredPackages: readonly string[]
}

export type PluginSemanticsPluginOptions = {
	prefixes?: readonly string[]
	include?: string | string[]
	exclude?: string | string[]
	optionalImportMode?: 'bundle' | 'external'
}

export type PluginSemanticsCollector = {
	plugin: ViteCompatPlugin
	snapshot(): Map<string, PluginDependencyMode>
}

type ImportBinding = {
	readonly source: string
	readonly namespace: boolean
	readonly imported?: string
}

/** One source pass owns optional lowering and package dependency facts. */
export function createPluginSemanticsPlugin(
	options: PluginSemanticsPluginOptions = {},
): PluginSemanticsCollector {
	const optionalImportMode = options.optionalImportMode ?? 'bundle'
	const include = normalizePatterns(options.include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
		'**/*.js',
		'**/*.jsx',
		'**/*.mjs',
		'**/*.cjs',
	])
	const exclude = normalizePatterns(options.exclude, [
		...(optionalImportMode === 'external' ? ['**/node_modules/**'] : []),
		'**/*.d.*',
	])
	const prefixes = options.prefixes ?? []
	const dependencies = new Map<string, PluginDependencyMode>()
	const pluginImports = new Map<string, Map<string, PluginDependencyMode>>()

	const record = (source: string, mode: PluginDependencyMode) => {
		const name = normalizePackage(source, prefixes)
		if (name && (mode === 'required' || !dependencies.has(name))) dependencies.set(name, mode)
	}

	const plugin: ViteCompatPlugin = {
		name: 'pluxel:plugin-semantics',
		enforce: 'pre',
		buildStart() {
			dependencies.clear()
			pluginImports.clear()
		},
		transform: {
			filter: {
				id: { include, exclude },
				code: {
					include: prefixes.length > 0 ? /\boptionalPlugin\b|\bPlugin\b/ : /\boptionalPlugin\b/,
				},
			},
			handler(code, id) {
				const ast = parseWithLang(this, code, id)
				if (!ast) return null
				const semantics = analyzePluginSemantics(ast)
				for (const call of semantics.optionalPlugins) {
					if (call.packageSpecifier) record(call.packageSpecifier, 'optional')
				}
				for (const source of semantics.requiredPackages) record(source, 'required')

				const calls = semantics.optionalPlugins.map((call) => {
					const validArguments =
						call.argumentCount === 1 ||
						(call.argumentCount === 2 && call.packageAnnotation === call.packageSpecifier)
					if (
						!validArguments ||
						!call.packageSpecifier ||
						!call.exportName ||
						call.loaderEnd === undefined
					) {
						this.error(
							`[pluxel:optional-plugin] ${id} expects optionalPlugin(() => import(<literal>).then(<export selection>))`,
						)
					}
					if (!call.topLevel) {
						this.error(
							`[pluxel:optional-plugin] ${id} optionalPlugin() must be assigned to a module-level const`,
						)
					}
					return call as Required<OptionalPluginCall>
				})
				const cleanId = stripQuery(id)
				const imports = new Map<string, PluginDependencyMode>()
				for (const call of calls) imports.set(call.packageSpecifier, 'optional')
				for (const source of semantics.requiredPackages) {
					if (optionalImportMode === 'bundle' || normalizePackage(source, prefixes)) {
						imports.set(source, 'required')
					}
				}
				if (imports.size > 0) {
					pluginImports.set(id, imports)
					pluginImports.set(cleanId, imports)
				}
				if (calls.length === 0) return null
				if (optionalImportMode === 'bundle') return null
				let transformed = code
				for (const call of [...calls]
					.filter((candidate) => !candidate.packageAnnotation)
					.sort((a, b) => b.loaderEnd - a.loaderEnd)) {
					transformed = `${transformed.slice(0, call.loaderEnd)},${JSON.stringify(call.packageSpecifier)}${transformed.slice(call.loaderEnd)}`
				}
				return { code: transformed, map: null }
			},
		},
		async resolveId(source, importer, resolveOptions) {
			if (!importer) return null
			const mode = pluginImports.get(importer)?.get(source)
			if (!mode) return null
			if (optionalImportMode === 'external') return { id: source, external: true }
			if (mode !== 'optional') return null
			const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true })
			if (resolved) return resolved
			return `${ABSENT_PREFIX}${encodeURIComponent(source)}`
		},
		load(id) {
			if (!id.startsWith(ABSENT_PREFIX)) return null
			const source = decodeURIComponent(id.slice(ABSENT_PREFIX.length))
			return [
				`const error = new Error(${JSON.stringify(`Optional plugin package is absent: ${source}`)});`,
				`error.code = 'PLUXEL_OPTIONAL_PLUGIN_ABSENT';`,
				`error.packageSpecifier = ${JSON.stringify(source)};`,
				'throw error;',
			].join('\n')
		},
	}

	return {
		plugin,
		snapshot() {
			return new Map(dependencies)
		},
	}
}

export function analyzePluginSemantics(ast: Program): PluginSemantics {
	const imports = collectImports(ast)
	const topLevelCalls = collectTopLevelConstCalls(ast.body as unknown[])
	const optionalPlugins: OptionalPluginCall[] = []
	const requiredPackages: string[] = []

	walkAst(ast, (node) => {
		if (node.type === 'CallExpression' && isOptionalPluginCall(node, imports)) {
			optionalPlugins.push(
				analyzeOptionalPluginCall(
					node,
					typeof node.start === 'number' && topLevelCalls.has(node.start),
				),
			)
			return
		}
		if (!isPluginClass(node, imports)) return
		const members = (node.body as { body?: unknown } | undefined)?.body
		if (!Array.isArray(members)) return
		for (const member of members) {
			if (!isConstructor(member)) continue
			const params = ((member.value as { params?: unknown } | undefined)?.params ?? []) as unknown[]
			for (const param of params) {
				const source = resolveParameterImport(param, imports)
				if (source) requiredPackages.push(source)
			}
		}
	})

	return { optionalPlugins, requiredPackages }
}

function analyzeOptionalPluginCall(node: AstNode, topLevel: boolean): OptionalPluginCall {
	const args = Array.isArray(node.arguments) ? node.arguments : []
	const loader = args[0] as AstNode | undefined
	const imports: string[] = []
	if (loader) {
		walkAst(loader, (child) => {
			if (child.type !== 'ImportExpression') return
			const source = readLiteralString(child.source)
			if (source) imports.push(source)
		})
	}
	return {
		argumentCount: args.length,
		loaderEnd: typeof loader?.end === 'number' ? loader.end : undefined,
		packageSpecifier: imports.length === 1 ? imports[0] : undefined,
		exportName: loader ? readSelectedExport(loader) : undefined,
		packageAnnotation: readLiteralString(args[1]),
		topLevel,
	}
}

function collectImports(ast: Program): Map<string, ImportBinding> {
	const imports = new Map<string, ImportBinding>()
	for (const statement of ast.body ?? []) {
		const node = statement as unknown as AstNode
		if (node.type !== 'ImportDeclaration') continue
		const source = readLiteralString(node.source)
		if (!source) continue
		for (const raw of Array.isArray(node.specifiers) ? node.specifiers : []) {
			const specifier = raw as AstNode
			const local = readIdentifier(specifier.local)
			if (!local) continue
			imports.set(local, {
				source,
				namespace: specifier.type === 'ImportNamespaceSpecifier',
				imported: readIdentifier(specifier.imported),
			})
		}
	}
	return imports
}

function isOptionalPluginCall(node: AstNode, imports: Map<string, ImportBinding>): boolean {
	const callee = node.callee as AstNode | undefined
	if (callee?.type === 'Identifier') {
		const binding = imports.get(readIdentifier(callee) ?? '')
		return Boolean(
			binding &&
			!binding.namespace &&
			binding.imported === 'optionalPlugin' &&
			isAuthoringPackage(binding.source),
		)
	}
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'optionalPlugin') {
		return false
	}
	const binding = imports.get(readIdentifier(callee.object) ?? '')
	return Boolean(binding?.namespace && isAuthoringPackage(binding.source))
}

function isPluginClass(node: AstNode, imports: Map<string, ImportBinding>): boolean {
	if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return false
	const decorators = Array.isArray(node.decorators) ? node.decorators : []
	return decorators.some((raw) => {
		const expression = (raw as AstNode).expression as AstNode | undefined
		const callee =
			expression?.type === 'CallExpression' ? (expression.callee as AstNode) : expression
		if (callee?.type === 'Identifier') {
			const binding = imports.get(readIdentifier(callee) ?? '')
			return Boolean(
				binding &&
				!binding.namespace &&
				binding.imported === 'Plugin' &&
				isAuthoringPackage(binding.source),
			)
		}
		if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'Plugin') {
			return false
		}
		const binding = imports.get(readIdentifier(callee.object) ?? '')
		return Boolean(binding?.namespace && isAuthoringPackage(binding.source))
	})
}

function resolveParameterImport(param: unknown, imports: Map<string, ImportBinding>) {
	let node = param as AstNode | undefined
	if (node?.type === 'TSParameterProperty') node = node.parameter as AstNode | undefined
	const annotation = node?.typeAnnotation as AstNode | undefined
	const type =
		annotation?.type === 'TSTypeAnnotation' ? (annotation.typeAnnotation as AstNode) : annotation
	if (type?.type !== 'TSTypeReference') return undefined
	const name = type.typeName as AstNode | undefined
	if (name?.type === 'Identifier') return imports.get(readIdentifier(name) ?? '')?.source
	if (name?.type !== 'TSQualifiedName') return undefined
	return imports.get(leftmostIdentifier(name) ?? '')?.source
}

function readSelectedExport(loader: AstNode): string | undefined {
	const body = loader.type === 'ArrowFunctionExpression' ? (loader.body as AstNode) : undefined
	const callee = body?.type === 'CallExpression' ? (body.callee as AstNode) : undefined
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'then')
		return undefined
	const selector = Array.isArray(body?.arguments) ? (body.arguments[0] as AstNode) : undefined
	if (selector?.type !== 'ArrowFunctionExpression') return undefined
	const selected = selector.body as AstNode | undefined
	if (selected?.type === 'MemberExpression') return propertyName(selected.property)
	const selectedName = readIdentifier(selected)
	const firstParam = Array.isArray(selector.params) ? (selector.params[0] as AstNode) : undefined
	if (!selectedName || firstParam?.type !== 'ObjectPattern') return undefined
	for (const raw of Array.isArray(firstParam.properties) ? firstParam.properties : []) {
		const property = raw as AstNode
		if (readIdentifier(property.value) === selectedName) return propertyName(property.key)
	}
	return undefined
}

function collectTopLevelConstCalls(body: unknown[]): Set<number> {
	const starts = new Set<number>()
	for (const raw of body) {
		let node = raw as AstNode
		if (node.type === 'ExportNamedDeclaration' && node.declaration) {
			node = node.declaration as AstNode
		}
		if (node.type !== 'VariableDeclaration' || node.kind !== 'const') continue
		for (const rawDeclaration of Array.isArray(node.declarations) ? node.declarations : []) {
			const init = (rawDeclaration as AstNode).init as AstNode | undefined
			if (init?.type === 'CallExpression' && typeof init.start === 'number') starts.add(init.start)
		}
	}
	return starts
}

function isConstructor(value: unknown): value is AstNode {
	if (!value || typeof value !== 'object') return false
	const node = value as AstNode
	return node.type === 'MethodDefinition' && node.kind === 'constructor'
}

function leftmostIdentifier(node: AstNode): string | undefined {
	const left = node.left as AstNode | undefined
	return left?.type === 'Identifier'
		? readIdentifier(left)
		: left
			? leftmostIdentifier(left)
			: undefined
}

function propertyName(value: unknown): string | undefined {
	return readIdentifier(value) ?? readLiteralString(value)
}

function isAuthoringPackage(source: string): boolean {
	return (
		source === '@pluxel/core' ||
		source === '@pluxel/runtime' ||
		source === '@pluxel/runtime/authoring'
	)
}

function normalizePackage(source: string, prefixes: readonly string[]): string | undefined {
	if (prefixes.length === 0) return undefined
	const clean = source.split(/[?#]/, 1)[0] ?? source
	if (!clean || clean.startsWith('.') || clean.startsWith('/')) return undefined
	const parts = clean.split('/')
	const name = clean.startsWith('@') ? parts[1] : parts[0]
	if (!name || !prefixes.some((prefix) => name.startsWith(prefix))) return undefined
	return clean.startsWith('@') ? `${parts[0]}/${name}` : name
}

function stripQuery(id: string): string {
	return id.split('?', 1)[0] ?? id
}
