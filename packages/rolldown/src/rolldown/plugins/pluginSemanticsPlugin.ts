import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type PluginEntryAddress,
} from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import type { Program } from 'oxc-parser'
import type { ViteCompatPlugin } from './compat.ts'
import {
	type AstNode,
	normalizePatterns,
	parseStandaloneWithLang,
	parseWithLang,
	readIdentifier,
	readLiteralString,
	walkAst,
} from './pluginUtils.ts'

export type PluginDependencyMode = 'required' | 'optional'

export type { PluginDefinitionAddress, PluginEntryAddress } from '@pluxel/core'

export type PluginSemanticDefinition = {
	readonly className: string
	readonly kind: 'plugin' | 'abstract'
	readonly definition: PluginDefinitionAddress
	readonly requires: readonly PluginDefinitionAddress[]
	readonly optional: readonly PluginDefinitionAddress[]
	readonly provides?: PluginDefinitionAddress
}

export type PluginSemantics = {
	readonly definitions: readonly PluginSemanticDefinition[]
	readonly packageDependencies: ReadonlyMap<string, PluginDependencyMode>
	readonly transformedCode?: string
}

export type PluginSemanticsPluginOptions = {
	include?: string | string[]
	exclude?: string | string[]
	/** Host root mapped to the built-in app source space. */
	root?: string
	/** Additional stable logical source spaces. Relative roots resolve from root. */
	sourceSpaces?: readonly Readonly<{ name: string; root: string }>[]
	/** Enables package-root provenance and package entry/export invariants. */
	packageJsonPath?: string
	/** Generated helper import. Must name a dedicated toolchain subpath. */
	helperImportSource?: '@pluxel/runtime/toolchain' | '@pluxel/core/toolchain'
}

export type PluginSemanticsCollector = {
	plugin: ViteCompatPlugin
	snapshot(): Map<string, PluginDependencyMode>
	definitions(): readonly PluginSemanticDefinition[]
}

type ImportBinding = {
	readonly source: string
	readonly imported: string
	readonly local: string
	readonly namespace: boolean
	readonly typeOnly: boolean
}

type RawClass = {
	readonly node: AstNode
	readonly name: string
	readonly marked: boolean
	readonly abstract: boolean
	readonly basePluginSubclass: boolean
	readonly pluginPartSubclass: boolean
	readonly marker?: AstNode
}

type RawRef = {
	readonly name: string
	readonly call: AstNode
	readonly targetType: string
}

type ModuleAnalysis = {
	readonly ast: Program
	readonly imports: Map<string, ImportBinding>
	readonly classes: Map<string, RawClass>
	readonly exports: Map<string, LocalExport>
	readonly exportAll: readonly string[]
	readonly refs: Map<string, RawRef>
	readonly exportedRefs: ReadonlySet<string>
}

type LocalExport =
	| { readonly kind: 'local'; readonly local: string }
	| { readonly kind: 'reexport'; readonly source: string; readonly imported: string }

type ClassOrigin = {
	readonly id: string
	readonly className: string
	readonly raw: RawClass
}

type PackagePlan = {
	readonly packageName: string
	readonly packageRoot: string
	readonly rootEntry: string
	readonly publicEntries: ReadonlyMap<string, string>
	readonly addresses: ReadonlyMap<string, PluginDefinitionAddress>
}

type ResolvedSourceSpace = Readonly<{
	name: string
	realRoot: string
	depth: number
}>

type Replacement = { readonly start: number; readonly end: number; readonly text: string }
type PartOwnerFacts = Readonly<{
	readonly className: string
	readonly occurrences: readonly Readonly<{ fieldName: string; partName: string }>[]
}>
type PartOptionalFacts = Readonly<{
	readonly className: string
	readonly optional: readonly PluginDefinitionAddress[]
}>
type PartRequiredFacts = Readonly<{
	readonly className: string
	readonly requires: readonly PluginDefinitionAddress[]
}>
type DependencyInventoryNode = Readonly<{
	readonly key: string
	readonly kind: 'plugin' | 'part'
	readonly requires: readonly PluginDefinitionAddress[]
	readonly optional: readonly PluginDefinitionAddress[]
	readonly parts: readonly string[]
}>

const AUTHORING_PACKAGES = new Set([
	'@pluxel/core',
	'@pluxel/core/test',
	'@pluxel/runtime',
	'@pluxel/runtime/test',
	'@pluxel/test',
])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const

/**
 * One pass owns Plugin declaration provenance, constructor DI facts, optional refs and package
 * dependency metadata. It deliberately has no loader/resolver fallback for absent packages.
 */
export function createPluginSemanticsPlugin(
	options: PluginSemanticsPluginOptions = {},
): PluginSemanticsCollector {
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
	const exclude = normalizePatterns(options.exclude, ['**/node_modules/**', '**/*.d.*'])
	const sourceRoot = resolve(options.root ?? process.cwd())
	const helperImportSource = options.helperImportSource ?? '@pluxel/runtime/toolchain'
	if (!helperImportSource.endsWith('/toolchain')) {
		throw new TypeError(
			'[pluxel:plugin-semantics] helperImportSource must name a /toolchain subpath',
		)
	}
	const collectedDefinitions = new Map<string, PluginSemanticDefinition>()
	const dependencyInventory = new Map<string, DependencyInventoryNode>()
	const requiredImports = new Map<string, Set<string>>()
	const packageOwnerCache = new Map<string, Promise<string | undefined>>()
	const inferredPackagePlans = new Map<string, Promise<PackagePlan | undefined>>()
	const sourceFileRealpaths = new Map<string, Promise<string>>()
	let resolvedSourceSpaces: Promise<readonly ResolvedSourceSpace[]> | undefined
	let packagePlan: PackagePlan | undefined

	const plugin: ViteCompatPlugin = {
		name: 'pluxel:plugin-semantics',
		enforce: 'pre',
		async buildStart() {
			collectedDefinitions.clear()
			dependencyInventory.clear()
			requiredImports.clear()
			packageOwnerCache.clear()
			inferredPackagePlans.clear()
			sourceFileRealpaths.clear()
			resolvedSourceSpaces = resolveSourceSpaces(sourceRoot, options.sourceSpaces)
			await resolvedSourceSpaces
			packagePlan = options.packageJsonPath
				? await createPackagePlan(options.packageJsonPath, (message) => this.error(message))
				: undefined
		},
		transform: {
			filter: {
				id: { include, exclude },
			},
			async handler(code, rawId) {
				const id = stripQuery(rawId)
				if (code.includes('// [pluxel-plugin-semantics] Injected facts')) return null
				if (!semanticHint(code)) return null
				const ast = parseWithLang(this, code, id)
				if (!ast) this.error(`[pluxel:plugin-semantics] failed to parse ${id}`)
				const analysis = analyzeModule(ast)
				const inferredPackagePlan = packagePlan
					? undefined
					: await inferPackagePlan(id, packageOwnerCache, inferredPackagePlans, (message) =>
							this.error(message),
						)
				const activePackagePlan = packagePlan ?? inferredPackagePlan
				resolvedSourceSpaces ??= resolveSourceSpaces(sourceRoot, options.sourceSpaces)
				const addresses = packagePlan
					? packagePlan.addresses
					: await sourceAddresses(
							analysis,
							id,
							resolvedSourceSpaces,
							sourceFileRealpaths,
							inferredPackagePlan?.addresses,
						)
				const result = await lowerModule({
					analysis,
					code,
					id,
					sourceRoot,
					sourceSpaces: resolvedSourceSpaces,
					sourceFileRealpaths,
					addresses,
					packagePlan: activePackagePlan,
					strictPackagePlan: Boolean(packagePlan),
					helperImportSource,
					error: (message) => this.error(message),
					resolve: async (source) => {
						const resolved = await this.resolve(source, id, { skipSelf: true })
						return resolved?.id ? stripQuery(resolved.id) : undefined
					},
				})

				for (const definition of result.definitions) {
					collectedDefinitions.set(definitionKey(definition.definition), definition)
				}
				for (const node of result.dependencyInventory) {
					dependencyInventory.set(node.key, node)
				}
				if (result.requiredSources.size > 0) {
					requiredImports.set(id, result.requiredSources)
					requiredImports.set(rawId, result.requiredSources)
				}
				return result.code === code ? null : { code: result.code, map: null }
			},
		},
		resolveId(source, importer) {
			if (!packagePlan || !importer) return null
			if (!requiredImports.get(stripQuery(importer))?.has(source)) return null
			return { id: source, external: true }
		},
		buildEnd() {
			if (packagePlan) {
				for (const definition of collectedDefinitions.values()) {
					if (definition.definition.entry.kind === 'package-root') continue
					this.error(
						`[pluxel:plugin-package] ${definition.className} was not mapped to the package root`,
					)
				}
			}
		},
	}

	return {
		plugin,
		snapshot: () =>
			collectReachablePackageDependencies(dependencyInventory, packagePlan?.packageName),
		definitions: () => [...collectedDefinitions.values()],
	}
}

/** Pure AST view used by focused tests and diagnostics. */
export function analyzePluginSemantics(
	ast: Program,
	options: { id?: string; root?: string } = {},
): PluginSemantics {
	const id = resolve(options.id ?? 'src/plugin.ts')
	const root = resolve(options.root ?? dirname(id))
	const analysis = analyzeModule(ast)
	const addresses = lexicalSourceAddresses(analysis, id, root)
	const definitions: PluginSemanticDefinition[] = []
	const error = (message: string): never => {
		throw new Error(message)
	}
	for (const raw of analysis.classes.values()) {
		validateCallerViewPrivateBrand(raw, analysis, id, error)
		validateCallerViewCallableFields(raw, analysis, id, error)
		validateCallerViewDeclaredFields(raw, analysis, id, error)
		if (raw.marked && raw.pluginPartSubclass) {
			error(
				`[pluxel:plugin-part] ${id} ${raw.name} must not use @Plugin; PluginPart has no graph identity`,
			)
		}
		partOccurrences(raw, analysis, id, error)
		if (raw.pluginPartSubclass) validatePluginPartConstructor(raw, id, error)
		if (!raw.marked && !raw.abstract) continue
		const definition = addresses.get(originKey(id, raw.name))
		if (!definition) continue
		definitions.push({
			className: raw.name,
			kind: raw.marked ? 'plugin' : 'abstract',
			definition,
			requires: [],
			optional: [],
		})
	}
	return { definitions, packageDependencies: new Map() }
}

async function lowerModule(options: {
	analysis: ModuleAnalysis
	code: string
	id: string
	sourceRoot: string
	sourceSpaces: Promise<readonly ResolvedSourceSpace[]>
	sourceFileRealpaths: Map<string, Promise<string>>
	addresses: ReadonlyMap<string, PluginDefinitionAddress>
	packagePlan?: PackagePlan
	strictPackagePlan: boolean
	helperImportSource: string
	error(message: string): never
	resolve(source: string): Promise<string | undefined>
}): Promise<{
	code: string
	definitions: PluginSemanticDefinition[]
	dependencyInventory: DependencyInventoryNode[]
	requiredSources: Set<string>
}> {
	const { analysis, id } = options
	const requiredSources = new Set<string>()
	const replacements: Replacement[] = []
	const refAddresses = new Map<string, PluginDefinitionAddress>()

	for (const ref of analysis.refs.values()) {
		if (analysis.exportedRefs.has(ref.name)) {
			options.error(`[pluxel:plugin-ref] ${id} ${ref.name} must not be exported`)
		}
		const address = await resolveTypeAddress(ref.targetType, analysis, id, options, true)
		refAddresses.set(ref.name, address)
		const start = numberPosition(ref.call.start, options.error, `${id} ref start`)
		const end = numberPosition(ref.call.end, options.error, `${id} ref end`)
		replacements.push({
			start,
			end,
			text: `__pluxelDefinePluginRef(${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, definition: address })})`,
		})
	}

	const definitions: PluginSemanticDefinition[] = []
	const dependencyInventory: DependencyInventoryNode[] = []
	const partOwners: PartOwnerFacts[] = []
	const partRequired: PartRequiredFacts[] = []
	const partOptional: PartOptionalFacts[] = []
	for (const raw of analysis.classes.values()) {
		validateCallerViewPrivateBrand(raw, analysis, id, options.error)
		validateCallerViewCallableFields(raw, analysis, id, options.error)
		validateCallerViewDeclaredFields(raw, analysis, id, options.error)
		if (raw.marked && raw.pluginPartSubclass) {
			options.error(
				`[pluxel:plugin-part] ${id} ${raw.name} must not use @Plugin; PluginPart has no graph identity`,
			)
		}
		const occurrences = partOccurrences(raw, analysis, id, options.error)
		const partTargets = await resolvePartTargets(occurrences, analysis, id, options)
		if (occurrences.length > 0) {
			partOwners.push({ className: raw.name, occurrences })
		}
		if (raw.pluginPartSubclass) {
			validatePluginPartConstructor(raw, id, options.error)
			const requires = await constructorRequirements(raw, analysis, id, options, requiredSources)
			if (requires.length > 0) partRequired.push({ className: raw.name, requires })
			const optional = optionalRequirements(raw, analysis, refAddresses, id, options.error)
			if (optional.length > 0) partOptional.push({ className: raw.name, optional })
			dependencyInventory.push({
				key: originKey(id, raw.name),
				kind: 'part',
				requires,
				optional,
				parts: partTargets,
			})
		}
		if (!raw.marked && !raw.abstract) continue
		const address = options.addresses.get(originKey(id, raw.name))
		if (!address) {
			if (options.strictPackagePlan && raw.marked) {
				options.error(
					`[pluxel:plugin-package] ${id} marked Plugin ${raw.name} must have one unique package-root named export`,
				)
			}
			continue
		}
		if (raw.marked) validateMarker(raw, id, analysis, options.error)
		const requires = raw.marked
			? await constructorRequirements(raw, analysis, id, options, requiredSources)
			: []
		const optional = raw.marked
			? optionalRequirements(raw, analysis, refAddresses, id, options.error)
			: []
		const provides = raw.marked ? await markerProvider(raw, analysis, id, options) : undefined
		definitions.push({
			className: raw.name,
			kind: raw.marked ? 'plugin' : 'abstract',
			definition: address,
			requires,
			optional,
			...(provides ? { provides } : {}),
		})
		if (raw.marked) {
			dependencyInventory.push({
				key: originKey(id, raw.name),
				kind: 'plugin',
				requires,
				optional,
				parts: partTargets,
			})
		}
	}
	validateLocalPartContainment(partOwners, analysis, id, options.error)

	let transformed = applyReplacements(options.code, replacements)
	if (
		definitions.length > 0 ||
		replacements.length > 0 ||
		partOwners.length > 0 ||
		partRequired.length > 0 ||
		partOptional.length > 0
	) {
		const imports = [
			definitions.length > 0 ? '__setPluginDefinition as __pluxelSetPluginDefinition' : undefined,
			replacements.length > 0 ? '__definePluginRef as __pluxelDefinePluginRef' : undefined,
			partOwners.length > 0 ? '__setPluginParts as __pluxelSetPluginParts' : undefined,
			partRequired.length > 0
				? '__setPluginPartRequires as __pluxelSetPluginPartRequires'
				: undefined,
			partOptional.length > 0
				? '__setPluginPartOptional as __pluxelSetPluginPartOptional'
				: undefined,
		].filter((value): value is string => Boolean(value))
		const lines = [
			'// [pluxel-plugin-semantics] Injected facts',
			`import { ${imports.join(', ')} } from ${JSON.stringify(options.helperImportSource)};`,
		]
		for (const definition of definitions) {
			lines.push(
				`__pluxelSetPluginDefinition(${definition.className}, ${JSON.stringify({
					abiVersion: PLUGIN_LOWERING_ABI_VERSION,
					kind: definition.kind,
					definition: definition.definition,
					constructorRequires: definition.requires,
					optional: definition.optional,
					...(definition.provides ? { provides: definition.provides } : {}),
				})});`,
			)
		}
		for (const owner of partOwners) {
			const occurrences = owner.occurrences
				.map((item) => `{ fieldName: ${JSON.stringify(item.fieldName)}, Part: ${item.partName} }`)
				.join(', ')
			lines.push(
				`__pluxelSetPluginParts(${owner.className}, { abiVersion: ${PLUGIN_LOWERING_ABI_VERSION}, occurrences: [${occurrences}] });`,
			)
		}
		for (const part of partRequired) {
			lines.push(
				`__pluxelSetPluginPartRequires(${part.className}, ${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, requires: part.requires })});`,
			)
		}
		for (const part of partOptional) {
			lines.push(
				`__pluxelSetPluginPartOptional(${part.className}, ${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, optional: part.optional })});`,
			)
		}
		transformed = `${transformed}\n${lines.join('\n')}\n`
	}
	return { code: transformed, definitions, dependencyInventory, requiredSources }
}

function collectReachablePackageDependencies(
	inventory: ReadonlyMap<string, DependencyInventoryNode>,
	ownerPackage: string | undefined,
): Map<string, PluginDependencyMode> {
	const dependencies = new Map<string, PluginDependencyMode>()
	const visited = new Set<string>()
	const record = (address: PluginDefinitionAddress, mode: PluginDependencyMode) => {
		if (address.entry.kind !== 'package-root') return
		const packageName = address.entry.packageName
		if (packageName === ownerPackage || AUTHORING_PACKAGES.has(packageName)) return
		if (mode === 'required' || !dependencies.has(packageName)) {
			dependencies.set(packageName, mode)
		}
	}
	const visit = (key: string) => {
		if (visited.has(key)) return
		visited.add(key)
		const node = inventory.get(key)
		if (!node) return
		for (const address of node.optional) record(address, 'optional')
		for (const address of node.requires) record(address, 'required')
		for (const part of node.parts) visit(part)
	}
	for (const node of inventory.values()) {
		if (node.kind === 'plugin') visit(node.key)
	}
	return dependencies
}

async function resolvePartTargets(
	occurrences: readonly Readonly<{ fieldName: string; partName: string }>[],
	analysis: ModuleAnalysis,
	id: string,
	options: Parameters<typeof lowerModule>[0],
): Promise<readonly string[]> {
	const targets: string[] = []
	for (const occurrence of occurrences) {
		if (analysis.classes.has(occurrence.partName)) {
			targets.push(originKey(id, occurrence.partName))
			continue
		}
		const binding = analysis.imports.get(occurrence.partName)
		if (!binding || isBareSpecifier(binding.source)) continue
		const resolved = await options.resolve(binding.source)
		if (!resolved) {
			options.error(
				`[pluxel:plugin-part] ${id} could not resolve local Part import ${binding.source}`,
			)
		}
		const clean = resolve(stripQuery(resolved))
		const modules = new Map<string, Promise<ModuleAnalysis>>()
		const readModule = (moduleId: string): Promise<ModuleAnalysis> => {
			const moduleKey = resolve(stripQuery(moduleId))
			let pending = modules.get(moduleKey)
			if (!pending) {
				pending = readFile(moduleKey, 'utf8').then((source) => {
					const ast = parseStandaloneWithLang(source, moduleKey)
					if (!ast) {
						options.error(`[pluxel:plugin-part] ${id} could not inspect ${moduleKey}`)
					}
					return analyzeModule(ast)
				})
				modules.set(moduleKey, pending)
			}
			return pending
		}
		const origin = await resolveExportOrigin(
			clean,
			binding.imported,
			readModule,
			new Set(),
			options.error,
		)
		if (!origin?.raw.pluginPartSubclass) {
			options.error(
				`[pluxel:plugin-part] ${id} ${occurrence.partName} must resolve to one direct PluginPart subclass`,
			)
		}
		targets.push(originKey(origin.id, origin.className))
	}
	return Object.freeze(targets)
}

function analyzeModule(ast: Program): ModuleAnalysis {
	const imports = collectImports(ast)
	const classes = new Map<string, RawClass>()
	const exports = new Map<string, LocalExport>()
	const exportAll: string[] = []
	const refs = new Map<string, RawRef>()
	const exportedRefs = new Set<string>()

	const registerClass = (node: AstNode) => {
		const name = readIdentifier(node.id)
		if (!name) return
		const marker = findPluginMarker(node, imports)
		classes.set(name, {
			node,
			name,
			marked: Boolean(marker),
			abstract: node.abstract === true,
			basePluginSubclass: extendsBasePlugin(node, imports),
			pluginPartSubclass: extendsPluginPart(node, imports),
			...(marker ? { marker } : {}),
		})
	}

	for (const statement of ast.body ?? []) {
		const node = statement as unknown as AstNode
		if (node.type === 'ClassDeclaration') registerClass(node)
		if (node.type === 'VariableDeclaration') collectPluginRefs(node, imports, refs, false)
		if (node.type === 'ExportAllDeclaration') {
			const source = readLiteralString(node.source)
			if (source && node.exportKind !== 'type') exportAll.push(source)
			continue
		}
		if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportDefaultDeclaration') {
			continue
		}
		if (node.type === 'ExportDefaultDeclaration') {
			const declaration = node.declaration as AstNode | undefined
			if (declaration?.type === 'ClassDeclaration') registerClass(declaration)
			continue
		}
		if (node.exportKind === 'type') continue
		const declaration = node.declaration as AstNode | undefined
		if (declaration?.type === 'ClassDeclaration') {
			registerClass(declaration)
			const name = readIdentifier(declaration.id)
			if (name) exports.set(name, { kind: 'local', local: name })
		}
		if (declaration?.type === 'VariableDeclaration') {
			collectPluginRefs(declaration, imports, refs, true)
			for (const rawDeclaration of arrayOf(declaration.declarations)) {
				const name = readIdentifier((rawDeclaration as AstNode).id)
				if (name) exportedRefs.add(name)
			}
		}
		const source = readLiteralString(node.source)
		for (const rawSpecifier of arrayOf(node.specifiers)) {
			const specifier = rawSpecifier as AstNode
			if (specifier.exportKind === 'type') continue
			const exported = propertyName(specifier.exported)
			const local = propertyName(specifier.local)
			if (!exported || !local) continue
			if (source) exports.set(exported, { kind: 'reexport', source, imported: local })
			else {
				exports.set(exported, { kind: 'local', local })
				if (refs.has(local)) exportedRefs.add(local)
			}
		}
	}
	for (const raw of classes.values()) {
		if (raw.abstract && !raw.basePluginSubclass && !raw.pluginPartSubclass && !raw.marked) {
			classes.delete(raw.name)
		}
	}
	const declaredRefCalls = new Set([...refs.values()].map((ref) => ref.call.start))
	walkAst(ast, (node) => {
		if (node.type !== 'CallExpression' || !isAuthoringCall(node, 'definePluginRef', imports)) return
		if (!declaredRefCalls.has(node.start)) {
			throw new Error(
				'[pluxel:plugin-ref] definePluginRef<T>() must be assigned to a non-exported module-level const',
			)
		}
	})
	return { ast, imports, classes, exports, exportAll, refs, exportedRefs }
}

function collectImports(ast: Program): Map<string, ImportBinding> {
	const imports = new Map<string, ImportBinding>()
	for (const statement of ast.body ?? []) {
		const node = statement as unknown as AstNode
		if (node.type !== 'ImportDeclaration') continue
		const source = readLiteralString(node.source)
		if (!source) continue
		for (const raw of arrayOf(node.specifiers)) {
			const specifier = raw as AstNode
			const local = readIdentifier(specifier.local)
			if (!local) continue
			const namespace = specifier.type === 'ImportNamespaceSpecifier'
			const imported =
				specifier.type === 'ImportDefaultSpecifier'
					? 'default'
					: (readIdentifier(specifier.imported) ?? local)
			imports.set(local, {
				source,
				imported,
				local,
				namespace,
				typeOnly: node.importKind === 'type' || specifier.importKind === 'type',
			})
		}
	}
	return imports
}

function collectPluginRefs(
	declaration: AstNode,
	imports: Map<string, ImportBinding>,
	refs: Map<string, RawRef>,
	_exported: boolean,
): void {
	if (declaration.kind !== 'const') return
	for (const rawDeclaration of arrayOf(declaration.declarations)) {
		const item = rawDeclaration as AstNode
		const name = readIdentifier(item.id)
		const call = item.init as AstNode | undefined
		if (
			!name ||
			call?.type !== 'CallExpression' ||
			!isAuthoringCall(call, 'definePluginRef', imports)
		) {
			continue
		}
		const args = arrayOf(call.arguments)
		const typeArguments = (call.typeArguments as AstNode | undefined)?.params
		const params = arrayOf(typeArguments)
		const targetType = params.length === 1 ? simpleTypeReference(params[0]) : undefined
		if (args.length > 0 || !targetType) {
			throw new Error(
				`[pluxel:plugin-ref] ${name} expects definePluginRef<RootPluginType>() with no runtime arguments`,
			)
		}
		refs.set(name, { name, call, targetType })
	}
}

async function sourceAddresses(
	analysis: ModuleAnalysis,
	id: string,
	spacesPromise: Promise<readonly ResolvedSourceSpace[]>,
	fileRealpaths: Map<string, Promise<string>>,
	packageAddresses: ReadonlyMap<string, PluginDefinitionAddress> | undefined,
): Promise<Map<string, PluginDefinitionAddress>> {
	const byLocal = new Map<string, string[]>()
	for (const [exportName, target] of analysis.exports) {
		if (target.kind !== 'local') continue
		const binding = analysis.imports.get(target.local)
		if (binding) continue
		const list = byLocal.get(target.local) ?? []
		list.push(exportName)
		byLocal.set(target.local, list)
	}
	const addresses = new Map<string, PluginDefinitionAddress>()
	let sourceEntry: PluginEntryAddress | undefined
	for (const raw of analysis.classes.values()) {
		if (!raw.marked && !raw.abstract) continue
		const origin = originKey(id, raw.name)
		const packageAddress = packageAddresses?.get(origin)
		if (packageAddress) {
			addresses.set(origin, packageAddress)
			continue
		}
		const names = byLocal.get(raw.name) ?? []
		if (names.length > 1) {
			throw new Error(
				`[pluxel:plugin-semantics] ${id} ${raw.name} is exported by multiple root names: ${names.join(', ')}`,
			)
		}
		const exportName = names[0] ?? raw.name
		sourceEntry ??= await canonicalSourceEntry(id, await spacesPromise, fileRealpaths)
		addresses.set(origin, { entry: sourceEntry, exportName })
	}
	return addresses
}

function lexicalSourceAddresses(
	analysis: ModuleAnalysis,
	id: string,
	root: string,
): Map<string, PluginDefinitionAddress> {
	const byLocal = new Map<string, string[]>()
	for (const [exportName, target] of analysis.exports) {
		if (target.kind !== 'local' || analysis.imports.has(target.local)) continue
		const list = byLocal.get(target.local) ?? []
		list.push(exportName)
		byLocal.set(target.local, list)
	}
	const path = lexicalSourcePath(root, id)
	const addresses = new Map<string, PluginDefinitionAddress>()
	for (const raw of analysis.classes.values()) {
		if (!raw.marked && !raw.abstract) continue
		const names = byLocal.get(raw.name) ?? []
		if (names.length > 1) {
			throw new Error(
				`[pluxel:plugin-semantics] ${id} ${raw.name} is exported by multiple root names: ${names.join(', ')}`,
			)
		}
		addresses.set(originKey(id, raw.name), {
			entry: { kind: 'source-entry', sourceSpace: 'app', path },
			exportName: names[0] ?? raw.name,
		})
	}
	return addresses
}

async function constructorRequirements(
	raw: RawClass,
	analysis: ModuleAnalysis,
	id: string,
	options: Parameters<typeof lowerModule>[0],
	requiredSources: Set<string>,
): Promise<PluginDefinitionAddress[]> {
	const members = arrayOf((raw.node.body as AstNode | undefined)?.body)
	const constructor = members.find(
		(value) =>
			(value as AstNode).type === 'MethodDefinition' && (value as AstNode).kind === 'constructor',
	) as AstNode | undefined
	if (!constructor) return []
	const params = arrayOf((constructor.value as AstNode | undefined)?.params)
	const out: PluginDefinitionAddress[] = []
	const seen = new Map<string, Readonly<{ index: number; typeName: string }>>()
	for (const parameter of params) {
		const typeName = parameterTypeName(parameter)
		if (!typeName) {
			options.error(
				`[pluxel:plugin-di] ${id} ${raw.name} constructor parameters must be simple Plugin type references`,
			)
		}
		const binding = analysis.imports.get(typeName)
		if (binding?.typeOnly) {
			options.error(
				`[pluxel:plugin-di] ${id} ${raw.name} required dependency ${typeName} must use a value import`,
			)
		}
		const address = await resolveTypeAddress(typeName, analysis, id, options, false)
		const key = pluginDefinitionIndexKey(address)
		const previous = seen.get(key)
		if (previous) {
			options.error(
				`[pluxel:plugin-di] plugin_dependency_requirement_duplicate: ${id} ${raw.name} constructor parameters ${previous.index} (${previous.typeName}) and ${out.length} (${typeName}) resolve to the same Plugin definition; repeated requirements need an explicit stable role and are not supported`,
			)
		}
		seen.set(key, { index: out.length, typeName })
		out.push(address)
		if (binding && isBareSpecifier(binding.source)) {
			requiredSources.add(binding.source)
		}
	}
	return out
}

function optionalRequirements(
	raw: RawClass,
	analysis: ModuleAnalysis,
	refs: ReadonlyMap<string, PluginDefinitionAddress>,
	id: string,
	error: (message: string) => never,
): PluginDefinitionAddress[] {
	const members = arrayOf((raw.node.body as AstNode | undefined)?.body)
	const init = members.find(
		(value) =>
			(value as AstNode).type === 'MethodDefinition' &&
			propertyName((value as AstNode).key) === 'init',
	) as AstNode | undefined
	const addresses: PluginDefinitionAddress[] = []
	const seen = new Set<string>()
	const directCalls = new Set<unknown>()
	for (const member of members) {
		if ((member as AstNode).type !== 'MethodDefinition') continue
		const body = ((member as AstNode).value as AstNode | undefined)?.body as AstNode | undefined
		for (const statement of arrayOf(body?.body)) {
			const call = directPluginsUse(statement as AstNode)
			if (!call) continue
			directCalls.add(call.start)
			if (member !== init) {
				error(`[pluxel:plugin-ref] ${id} ${raw.name} plugins.use() is only allowed in init()`)
			}
			const args = arrayOf(call.arguments)
			const refName = readIdentifier(args[0])
			const callback = args[1] as AstNode | undefined
			if (args.length !== 2 || !refName || !refs.has(refName)) {
				error(
					`[pluxel:plugin-ref] ${id} ${raw.name} plugins.use() requires a module-level PluginRef and one callback`,
				)
			}
			if (
				(callback?.type !== 'ArrowFunctionExpression' && callback?.type !== 'FunctionExpression') ||
				callback.async === true
			) {
				error(`[pluxel:plugin-ref] ${id} ${raw.name} plugins.use() callback must be synchronous`)
			}
			const address = refs.get(refName)!
			const key = definitionKey(address)
			if (!seen.has(key)) {
				seen.add(key)
				addresses.push(address)
			}
		}
	}
	walkAst(raw.node, (node) => {
		if (node.type !== 'CallExpression' || !isPluginsUseCall(node)) return
		if (!directCalls.has(node.start)) {
			error(
				`[pluxel:plugin-ref] ${id} ${raw.name} plugins.use() must be a direct statement in init()`,
			)
		}
	})
	return addresses
}

async function markerProvider(
	raw: RawClass,
	analysis: ModuleAnalysis,
	id: string,
	options: Parameters<typeof lowerModule>[0],
): Promise<PluginDefinitionAddress | undefined> {
	const expression = raw.marker?.expression as AstNode | undefined
	if (expression?.type !== 'CallExpression') return undefined
	const args = arrayOf(expression.arguments)
	const first = args[0] as AstNode | undefined
	if (first?.type !== 'Identifier') return undefined
	const firstName = readIdentifier(first)
	if (!firstName) return undefined
	if (!analysis.imports.has(firstName) && !analysis.classes.get(firstName)?.abstract)
		return undefined
	return resolveTypeAddress(firstName, analysis, id, options, false)
}

function validateMarker(
	raw: RawClass,
	id: string,
	analysis: ModuleAnalysis,
	error: (message: string) => never,
): void {
	const expression = raw.marker?.expression as AstNode | undefined
	if (!expression || expression.type !== 'CallExpression') return
	const args = arrayOf(expression.arguments)
	let optionsNode: AstNode | undefined
	if (args.length === 1) {
		const first = args[0] as AstNode
		if (first.type === 'ObjectExpression') optionsNode = first
		else if (first.type !== 'Identifier') {
			error(`[pluxel:plugin-marker] ${id} ${raw.name} has an invalid @Plugin argument`)
		}
	} else if (args.length === 2) {
		if ((args[0] as AstNode).type !== 'Identifier') {
			error(`[pluxel:plugin-marker] ${id} ${raw.name} provider token must be an identifier`)
		}
		optionsNode = args[1] as AstNode
	} else if (args.length > 2) {
		error(`[pluxel:plugin-marker] ${id} ${raw.name} has too many @Plugin arguments`)
	}
	if (!optionsNode) return
	if (optionsNode.type !== 'ObjectExpression') {
		error(`[pluxel:plugin-marker] ${id} ${raw.name} options must be an object literal`)
	}
	for (const rawProperty of arrayOf(optionsNode.properties)) {
		const property = rawProperty as AstNode
		if (property.type !== 'Property' || property.computed === true) {
			error(`[pluxel:plugin-marker] ${id} ${raw.name} options must use literal fields`)
		}
		const key = propertyName(property.key)
		if (key === 'displayName') {
			const value = readLiteralString(property.value)
			if (!value?.trim()) {
				error(
					`[pluxel:plugin-marker] ${id} ${raw.name} displayName must be a non-empty string literal`,
				)
			}
			continue
		}
		if (key === 'startTimeoutMs') {
			const value = literalNumber(property.value)
			if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
				error(
					`[pluxel:plugin-marker] ${id} ${raw.name} startTimeoutMs must be a positive integer literal`,
				)
			}
			continue
		}
		if (key === 'forkable') {
			if (literalBoolean(property.value) !== true) {
				error(`[pluxel:plugin-marker] ${id} ${raw.name} forkable must be the literal true`)
			}
			continue
		}
		error(
			`[pluxel:plugin-marker] ${id} ${raw.name} unsupported @Plugin option ${JSON.stringify(key)}`,
		)
	}
	void analysis
}

async function resolveTypeAddress(
	typeName: string,
	analysis: ModuleAnalysis,
	id: string,
	options: Parameters<typeof lowerModule>[0],
	typeOnly: boolean,
): Promise<PluginDefinitionAddress> {
	const binding = analysis.imports.get(typeName)
	if (!binding) {
		const own = options.addresses.get(originKey(id, typeName))
		if (own) return own
		options.error(`[pluxel:plugin-provenance] ${id} cannot prove Plugin type ${typeName}`)
	}
	if (binding.namespace) {
		options.error(`[pluxel:plugin-provenance] ${id} namespace Plugin references are not supported`)
	}
	if (typeOnly && !binding.typeOnly) {
		options.error(
			`[pluxel:plugin-ref] ${id} optional Plugin type ${typeName} must use a direct type-only import`,
		)
	}
	if (!typeOnly && binding.typeOnly) {
		options.error(
			`[pluxel:plugin-di] ${id} required Plugin type ${typeName} must use a direct value import`,
		)
	}
	if (isBareSpecifier(binding.source)) {
		const packageName = packageNameOf(binding.source)
		if (binding.source !== packageName) {
			options.error(
				`[pluxel:plugin-provenance] ${id} Plugin dependencies must come from package root; received ${binding.source}`,
			)
		}
		return {
			entry: { kind: 'package-root', packageName },
			exportName: binding.imported,
		}
	}
	const resolved = await options.resolve(binding.source)
	if (!resolved) {
		options.error(
			`[pluxel:plugin-provenance] ${id} could not resolve local Plugin import ${binding.source}`,
		)
	}
	if (options.packagePlan && resolve(resolved) === resolve(options.packagePlan.rootEntry)) {
		const rootAddress = [...options.packagePlan.addresses.values()].find(
			(address) => address.exportName === binding.imported,
		)
		if (rootAddress) return rootAddress
	}
	const direct = options.addresses.get(originKey(resolved, binding.imported))
	if (direct) return direct
	const source = await readFile(resolved, 'utf8').catch((): undefined => undefined)
	const ast = source ? parseStandaloneWithLang(source, resolved) : null
	if (!ast) {
		options.error(`[pluxel:plugin-provenance] ${id} could not inspect ${resolved}`)
	}
	const target = analyzeModule(ast)
	const moduleCache = new Map<string, Promise<ModuleAnalysis>>([
		[resolve(resolved), Promise.resolve(target)],
	])
	const readModule = (moduleId: string): Promise<ModuleAnalysis> => {
		const clean = resolve(moduleId)
		let pending = moduleCache.get(clean)
		if (!pending) {
			pending = readFile(clean, 'utf8').then((moduleCode) => {
				const moduleAst = parseStandaloneWithLang(moduleCode, clean)
				if (!moduleAst) {
					options.error(`[pluxel:plugin-provenance] ${id} could not inspect ${clean}`)
				}
				return analyzeModule(moduleAst)
			})
			moduleCache.set(clean, pending)
		}
		return pending
	}
	const origin = await resolveExportOrigin(
		resolved,
		binding.imported,
		readModule,
		new Set(),
		options.error,
	)
	if (origin) {
		const planned = options.addresses.get(originKey(origin.id, origin.className))
		if (planned) return planned
		const originModule = await readModule(origin.id)
		const sourceDefinitions = await sourceAddresses(
			originModule,
			origin.id,
			options.sourceSpaces,
			options.sourceFileRealpaths,
			options.packagePlan?.addresses,
		)
		const address = sourceDefinitions.get(originKey(origin.id, origin.className))
		if (address) return address
	}
	options.error(
		`[pluxel:plugin-provenance] ${id} ${binding.source}#${binding.imported} is not one unique Plugin export`,
	)
}

async function inferPackagePlan(
	id: string,
	packageOwnerCache: Map<string, Promise<string | undefined>>,
	inferredPackagePlans: Map<string, Promise<PackagePlan | undefined>>,
	error: (message: string) => never,
): Promise<PackagePlan | undefined> {
	const startDirectory = dirname(resolve(stripQuery(id)))
	let owner = packageOwnerCache.get(startDirectory)
	if (!owner) {
		owner = findNearestPackageJson(startDirectory)
		packageOwnerCache.set(startDirectory, owner)
	}
	const packageJsonPath = await owner
	if (!packageJsonPath) return undefined
	let plan = inferredPackagePlans.get(packageJsonPath)
	if (!plan) {
		plan = readFile(packageJsonPath, 'utf8').then((raw) => {
			let pkg: { exports?: unknown }
			try {
				pkg = JSON.parse(raw) as { exports?: unknown }
			} catch (cause) {
				throw new Error(`[pluxel:plugin-package] invalid JSON in ${packageJsonPath}`, {
					cause,
				})
			}
			if (!hasPluginSourceRoot(pkg.exports)) return undefined
			return createPackagePlan(packageJsonPath, error)
		})
		inferredPackagePlans.set(packageJsonPath, plan)
	}
	return plan
}

async function findNearestPackageJson(startDirectory: string): Promise<string | undefined> {
	let directory = startDirectory
	while (true) {
		const candidate = resolve(directory, 'package.json')
		try {
			await readFile(candidate)
			return candidate
		} catch {
			const parent = dirname(directory)
			if (parent === directory) return undefined
			directory = parent
		}
	}
}

function hasPluginSourceRoot(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const root = (value as Record<string, unknown>)['.']
	if (!root || typeof root !== 'object' || Array.isArray(root)) return false
	return readSourceCondition((root as Record<string, unknown>)['@pluxel/hmr']) !== undefined
}

async function createPackagePlan(
	packageJsonPath: string,
	error: (message: string) => never,
): Promise<PackagePlan> {
	const resolvedPackageJson = resolve(packageJsonPath)
	const packageRoot = dirname(resolvedPackageJson)
	const raw = await readFile(resolvedPackageJson, 'utf8').catch((cause) => {
		throw new Error(`[pluxel:plugin-package] cannot read ${resolvedPackageJson}`, { cause })
	})
	const pkg = JSON.parse(raw) as { name?: unknown; exports?: unknown }
	const packageName = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : undefined
	if (!packageName)
		error(`[pluxel:plugin-package] ${resolvedPackageJson} must declare package name`)
	const publicEntries = readSourceExportEntries(pkg.exports, packageRoot, error)
	const rootEntry = publicEntries.get('.')
	if (!rootEntry) {
		error(
			`[pluxel:plugin-package] ${packageName} root export must expose a source entry via @pluxel/hmr or @pluxel/source`,
		)
	}
	const cache = new Map<string, Promise<ModuleAnalysis>>()
	const readModule = (id: string): Promise<ModuleAnalysis> => {
		const clean = resolve(id)
		let pending = cache.get(clean)
		if (!pending) {
			pending = readFile(clean, 'utf8').then((code) => {
				const ast = parseStandaloneWithLang(code, clean)
				if (!ast) error(`[pluxel:plugin-package] failed to parse public entry module ${clean}`)
				return analyzeModule(ast)
			})
			cache.set(clean, pending)
		}
		return pending
	}

	const enumerate = async (
		entry: string,
		seen = new Set<string>(),
	): Promise<Map<string, ClassOrigin>> => {
		const clean = resolve(entry)
		if (seen.has(clean)) return new Map()
		seen.add(clean)
		const module = await readModule(clean)
		const out = new Map<string, ClassOrigin>()
		for (const exportName of module.exports.keys()) {
			const origin = await resolveExportOrigin(clean, exportName, readModule, seen, error)
			if (origin) out.set(exportName, origin)
		}
		for (const source of module.exportAll) {
			if (isBareSpecifier(source)) continue
			const targetId = await resolveLocalFile(source, clean)
			if (!targetId) error(`[pluxel:plugin-package] cannot resolve ${source} from ${clean}`)
			const nested = await enumerate(targetId, new Set(seen))
			for (const [name, origin] of nested)
				if (name !== 'default' && !out.has(name)) out.set(name, origin)
		}
		return out
	}

	const rootExports = await enumerate(rootEntry)
	const rootModule = await readModule(rootEntry)
	for (const [exportName, target] of rootModule.exports) {
		const binding = target.kind === 'local' ? rootModule.imports.get(target.local) : undefined
		const source = target.kind === 'reexport' ? target.source : binding?.source
		if (source && isBareSpecifier(source) && /(?:Plugin|Backend)$/.test(exportName)) {
			error(
				`[pluxel:plugin-package] ${packageName} root export ${exportName} re-exports a value from ${source}; cross-package Plugin re-exports are forbidden`,
			)
		}
	}
	const addresses = new Map<string, PluginDefinitionAddress>()
	const namesByOrigin = new Map<string, string[]>()
	let concreteCount = 0
	for (const [exportName, origin] of rootExports) {
		if (!origin.raw.marked && !origin.raw.abstract) {
			if (origin.raw.basePluginSubclass) {
				error(
					`[pluxel:plugin-package] ${packageName} root export ${exportName} extends BasePlugin but is missing @Plugin`,
				)
			}
			continue
		}
		if (!isInside(packageRoot, origin.id)) {
			error(
				`[pluxel:plugin-package] ${packageName} root export ${exportName} re-exports a Plugin from another package`,
			)
		}
		if (origin.raw.marked) concreteCount++
		const key = originKey(origin.id, origin.className)
		const names = namesByOrigin.get(key) ?? []
		names.push(exportName)
		namesByOrigin.set(key, names)
		addresses.set(key, {
			entry: { kind: 'package-root', packageName },
			exportName,
		})
	}
	for (const [key, names] of namesByOrigin) {
		if (names.length > 1) {
			error(
				`[pluxel:plugin-package] ${packageName} exports one Plugin constructor by multiple root names: ${names.join(', ')}`,
			)
		}
		void key
	}
	if (concreteCount === 0) {
		error(`[pluxel:plugin-package] ${packageName} root entry does not export a marked Plugin`)
	}
	for (const [subpath, entry] of publicEntries) {
		if (subpath === '.' || subpath === './package.json') continue
		const exports = await enumerate(entry)
		for (const [exportName, origin] of exports) {
			if (origin.raw.marked || origin.raw.abstract) {
				error(
					`[pluxel:plugin-package] ${packageName}${subpath.slice(1)} is plugin-bearing (${exportName}); Plugin exports are only allowed at package root`,
				)
			}
		}
	}
	return { packageName, packageRoot, rootEntry, publicEntries, addresses }
}

async function resolveExportOrigin(
	id: string,
	exportName: string,
	readModule: (id: string) => Promise<ModuleAnalysis>,
	seen: Set<string>,
	error: (message: string) => never,
): Promise<ClassOrigin | undefined> {
	const clean = resolve(stripQuery(id))
	const key = `${clean}#${exportName}`
	if (seen.has(key)) return undefined
	seen.add(key)
	try {
		const module = await readModule(clean)
		const target = module.exports.get(exportName)
		if (target) {
			if (target.kind === 'reexport') {
				if (isBareSpecifier(target.source)) return undefined
				const targetId = await resolveLocalFile(target.source, clean)
				return targetId
					? resolveExportOrigin(targetId, target.imported, readModule, seen, error)
					: undefined
			}
			const raw = module.classes.get(target.local)
			if (raw) return { id: clean, className: target.local, raw }
			const binding = module.imports.get(target.local)
			if (!binding || isBareSpecifier(binding.source)) return undefined
			const targetId = await resolveLocalFile(binding.source, clean)
			return targetId
				? resolveExportOrigin(targetId, binding.imported, readModule, seen, error)
				: undefined
		}
		if (exportName === 'default') return undefined
		let found: ClassOrigin | undefined
		for (const source of module.exportAll) {
			if (isBareSpecifier(source)) continue
			const targetId = await resolveLocalFile(source, clean)
			if (!targetId) continue
			const candidate = await resolveExportOrigin(targetId, exportName, readModule, seen, error)
			if (!candidate) continue
			if (
				found &&
				originKey(found.id, found.className) !== originKey(candidate.id, candidate.className)
			) {
				error(
					`[pluxel:plugin-provenance] ${clean} export ${exportName} is ambiguous across local export-star branches`,
				)
			}
			found = candidate
		}
		return found
	} finally {
		seen.delete(key)
	}
}

function readSourceExportEntries(
	value: unknown,
	packageRoot: string,
	error: (message: string) => never,
): Map<string, string> {
	const entries = new Map<string, string>()
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		error('[pluxel:plugin-package] package exports must be an explicit subpath map')
	}
	for (const [subpath, target] of Object.entries(value as Record<string, unknown>)) {
		if (!subpath.startsWith('.')) continue
		const source = readSourceCondition(target)
		if (!source || !/\.[cm]?[jt]sx?$/.test(source)) continue
		entries.set(subpath, resolve(packageRoot, source))
	}
	return entries
}

function readSourceCondition(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	for (const key of ['@pluxel/hmr', '@pluxel/source', 'development']) {
		const nested = readSourceCondition(record[key])
		if (nested) return nested
	}
	return undefined
}

async function resolveLocalFile(source: string, importer: string): Promise<string | undefined> {
	const base = isAbsolute(source) ? source : resolve(dirname(importer), source)
	const candidates = extname(base)
		? [base]
		: [
				...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
				...SOURCE_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
			]
	for (const candidate of candidates) {
		try {
			await readFile(candidate)
			return resolve(candidate)
		} catch {
			// Try the next TypeScript/JavaScript source form.
		}
	}
	return undefined
}

function findPluginMarker(node: AstNode, imports: Map<string, ImportBinding>): AstNode | undefined {
	for (const raw of arrayOf(node.decorators)) {
		const decorator = raw as AstNode
		const expression = decorator.expression as AstNode | undefined
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
				return decorator
			}
		}
		if (callee?.type === 'MemberExpression' && propertyName(callee.property) === 'Plugin') {
			const binding = imports.get(readIdentifier(callee.object) ?? '')
			if (binding?.namespace && AUTHORING_PACKAGES.has(binding.source)) return decorator
		}
	}
	return undefined
}

function isAuthoringCall(
	call: AstNode,
	importedName: string,
	imports: Map<string, ImportBinding>,
): boolean {
	const callee = call.callee as AstNode | undefined
	if (callee?.type === 'Identifier') {
		const binding = imports.get(readIdentifier(callee) ?? '')
		return Boolean(
			binding &&
			!binding.namespace &&
			binding.imported === importedName &&
			AUTHORING_PACKAGES.has(binding.source),
		)
	}
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== importedName) {
		return false
	}
	const binding = imports.get(readIdentifier(callee.object) ?? '')
	return Boolean(binding?.namespace && AUTHORING_PACKAGES.has(binding.source))
}

function extendsBasePlugin(node: AstNode, imports: Map<string, ImportBinding>): boolean {
	const name = readIdentifier(node.superClass)
	if (!name) return false
	const binding = imports.get(name)
	return Boolean(
		binding &&
		!binding.namespace &&
		binding.imported === 'BasePlugin' &&
		AUTHORING_PACKAGES.has(binding.source),
	)
}

function extendsPluginPart(node: AstNode, imports: Map<string, ImportBinding>): boolean {
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

function partOccurrences(
	raw: RawClass,
	analysis: ModuleAnalysis,
	id: string,
	error: (message: string) => never,
): readonly Readonly<{ fieldName: string; partName: string }>[] {
	const members = arrayOf((raw.node.body as AstNode | undefined)?.body)
	const occurrences: Array<Readonly<{ fieldName: string; partName: string }>> = []
	const directCalls = new Set<unknown>()
	const fields = new Set<string>()
	for (const rawMember of members) {
		const member = rawMember as AstNode
		if (member.type !== 'PropertyDefinition') continue
		const call = partsUse(member.value)
		if (!call) continue
		directCalls.add(call.start)
		if (!raw.marked && !raw.pluginPartSubclass) {
			error(
				`[pluxel:plugin-part] ${id} ${raw.name} declares parts.use() but is not a concrete @Plugin or PluginPart`,
			)
		}
		if (member.static === true) {
			error(`[pluxel:plugin-part] ${id} ${raw.name} parts.use() must be an instance field`)
		}
		if ((member.key as AstNode | undefined)?.type === 'PrivateIdentifier') {
			error(`[pluxel:plugin-part] ${id} ${raw.name} Part field must not use #private syntax`)
		}
		const fieldName = propertyName(member.key)
		if (!fieldName || member.computed === true) {
			error(`[pluxel:plugin-part] ${id} ${raw.name} Part field name must be static`)
		}
		if (fields.has(fieldName)) {
			error(`[pluxel:plugin-part] ${id} ${raw.name} declares duplicate Part field ${fieldName}`)
		}
		fields.add(fieldName)
		const args = arrayOf(call.arguments)
		const argument = args[0] as AstNode | undefined
		const partName = args.length === 1 ? readIdentifier(argument) : undefined
		if (!partName || argument?.type === 'SpreadElement') {
			error(
				`[pluxel:plugin-part] ${id} ${raw.name}.${fieldName} expects parts.use(PluginPartClass) with one value identifier`,
			)
		}
		const binding = analysis.imports.get(partName)
		if (binding?.typeOnly) {
			error(
				`[pluxel:plugin-part] ${id} ${raw.name}.${fieldName} Part ${partName} must use a value import`,
			)
		}
		const local = analysis.classes.get(partName)
		if (!binding && !local?.pluginPartSubclass) {
			error(
				`[pluxel:plugin-part] ${id} ${raw.name}.${fieldName} target ${partName} must be an imported value or direct PluginPart subclass`,
			)
		}
		occurrences.push(Object.freeze({ fieldName, partName }))
	}
	walkAst(raw.node, (node) => {
		if (node.type !== 'CallExpression' || !isPartsUseCall(node)) return
		if (!directCalls.has(node.start)) {
			error(
				`[pluxel:plugin-part] ${id} ${raw.name} parts.use() must be the complete initializer of a normal class field`,
			)
		}
	})
	return Object.freeze(occurrences)
}

function validateLocalPartContainment(
	owners: readonly PartOwnerFacts[],
	analysis: ModuleAnalysis,
	id: string,
	error: (message: string) => never,
): void {
	const edges = new Map(owners.map((owner) => [owner.className, owner.occurrences]))
	const visit = (name: string, path: readonly string[], ancestry: Set<string>) => {
		for (const occurrence of edges.get(name) ?? []) {
			if (!analysis.classes.get(occurrence.partName)?.pluginPartSubclass) continue
			const nextPath = [...path, occurrence.fieldName]
			if (ancestry.has(occurrence.partName)) {
				error(
					`[pluxel:plugin-part] ${id} local PluginPart containment cycle at ${nextPath.join('.')}`,
				)
			}
			const next = new Set([...ancestry, occurrence.partName])
			visit(occurrence.partName, nextPath, next)
		}
	}
	for (const raw of analysis.classes.values()) {
		if (!raw.marked) continue
		visit(raw.name, [], new Set([raw.name]))
	}
}

function validatePluginPartConstructor(
	raw: RawClass,
	id: string,
	error: (message: string) => never,
): void {
	if (raw.abstract) {
		error(`[pluxel:plugin-part] ${id} ${raw.name} must be concrete`)
	}
}

function validateCallerViewPrivateBrand(
	raw: RawClass,
	analysis: ModuleAnalysis,
	id: string,
	error: (message: string) => never,
): void {
	if (!participatesInPluginInheritance(raw, analysis)) return
	for (const value of arrayOf((raw.node.body as AstNode | undefined)?.body)) {
		const member = value as AstNode
		if (member.static === true) continue
		if ((member.key as AstNode | undefined)?.type !== 'PrivateIdentifier') continue
		error(
			`[pluxel:plugin-caller-view] plugin_caller_view_private_brand_unsupported: ${id} ${raw.name} declares an ECMAScript instance #private member; Plugin dependency facades require closure-backed or ordinary TypeScript-private state`,
		)
	}
}

function validateCallerViewCallableFields(
	raw: RawClass,
	analysis: ModuleAnalysis,
	id: string,
	error: (message: string) => never,
): void {
	if (!participatesInPluginInheritance(raw, analysis)) return
	for (const value of arrayOf((raw.node.body as AstNode | undefined)?.body)) {
		const member = value as AstNode
		if (member.static === true || member.type !== 'PropertyDefinition') continue
		const initializer = member.value as AstNode | undefined
		if (!initializer || !isStaticallyCallableFieldInitializer(initializer)) continue
		const name = propertyName(member.key) ?? '<computed>'
		error(
			`[pluxel:plugin-caller-view] plugin_caller_view_callable_field_unsupported: ${id} ${raw.name}.${name} is a function-valued instance field; Plugin dependency callable surfaces must use prototype methods`,
		)
	}
}

function validateCallerViewDeclaredFields(
	raw: RawClass,
	analysis: ModuleAnalysis,
	id: string,
	error: (message: string) => never,
): void {
	if (!participatesInPluginInheritance(raw, analysis)) return
	for (const value of arrayOf((raw.node.body as AstNode | undefined)?.body)) {
		const member = value as AstNode
		if (member.static === true || member.type !== 'PropertyDefinition' || member.declare !== true) {
			continue
		}
		const name = propertyName(member.key) ?? '<computed>'
		error(
			`[pluxel:plugin-caller-view] plugin_caller_view_declared_field_unsupported: ${id} ${raw.name}.${name} is a type-only declared instance field; Plugin dependency facades require construction-time fields or prototype methods`,
		)
	}
}

function isStaticallyCallableFieldInitializer(initializer: AstNode): boolean {
	if (initializer.type === 'ArrowFunctionExpression' || initializer.type === 'FunctionExpression') {
		return true
	}
	if (initializer.type !== 'CallExpression') return false
	const callee = initializer.callee as AstNode | undefined
	return callee?.type === 'MemberExpression' && propertyName(callee.property) === 'bind'
}

function participatesInPluginInheritance(raw: RawClass, analysis: ModuleAnalysis): boolean {
	if (raw.marked || raw.basePluginSubclass) return true
	for (const candidate of analysis.classes.values()) {
		if (!candidate.marked) continue
		const seen = new Set<string>()
		let current: RawClass | undefined = candidate
		while (current) {
			const baseName = readIdentifier(current.node.superClass)
			if (!baseName || seen.has(baseName)) break
			seen.add(baseName)
			const base = analysis.classes.get(baseName)
			if (!base) break
			if (base === raw) return true
			current = base
		}
	}
	return false
}

function partsUse(value: unknown): AstNode | undefined {
	const call = value as AstNode | undefined
	return call?.type === 'CallExpression' && isPartsUseCall(call) ? call : undefined
}

function isPartsUseCall(expression: AstNode): boolean {
	const callee = expression.callee as AstNode | undefined
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'use') return false
	const host = callee.object as AstNode | undefined
	if (host?.type !== 'MemberExpression' || propertyName(host.property) !== 'parts') return false
	return (host.object as AstNode | undefined)?.type === 'ThisExpression'
}

function directPluginsUse(statement: AstNode): AstNode | undefined {
	if (statement.type !== 'ExpressionStatement') return undefined
	const expression = statement.expression as AstNode | undefined
	if (expression?.type !== 'CallExpression') return undefined
	const callee = expression.callee as AstNode | undefined
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'use')
		return undefined
	const host = callee.object as AstNode | undefined
	if (host?.type !== 'MemberExpression' || propertyName(host.property) !== 'plugins')
		return undefined
	return (host.object as AstNode | undefined)?.type === 'ThisExpression' ? expression : undefined
}

function isPluginsUseCall(expression: AstNode): boolean {
	const callee = expression.callee as AstNode | undefined
	if (callee?.type !== 'MemberExpression' || propertyName(callee.property) !== 'use') return false
	const host = callee.object as AstNode | undefined
	if (host?.type !== 'MemberExpression' || propertyName(host.property) !== 'plugins') return false
	return (host.object as AstNode | undefined)?.type === 'ThisExpression'
}

function parameterTypeName(value: unknown): string | undefined {
	let node = value as AstNode | undefined
	if (node?.type === 'TSParameterProperty') node = node.parameter as AstNode | undefined
	const annotation = node?.typeAnnotation as AstNode | undefined
	const type =
		annotation?.type === 'TSTypeAnnotation' ? (annotation.typeAnnotation as AstNode) : annotation
	return simpleTypeReference(type)
}

function simpleTypeReference(value: unknown): string | undefined {
	const node = value as AstNode | undefined
	if (node?.type !== 'TSTypeReference' || node.typeArguments) return undefined
	return readIdentifier(node.typeName)
}

function semanticHint(code: string): boolean {
	return /\b(?:Plugin|PluginPart|BasePlugin|definePluginRef)\b|\.(?:plugins|parts)\.use\s*\(/.test(
		code,
	)
}

function packageNameOf(source: string): string {
	const clean = source.split(/[?#]/, 1)[0] ?? source
	const parts = clean.split('/')
	return clean.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!
}

function isBareSpecifier(source: string): boolean {
	return !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
}

function isInside(root: string, file: string): boolean {
	const path = relative(resolve(root), resolve(file))
	return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

async function resolveSourceSpaces(
	appRoot: string,
	configured: PluginSemanticsPluginOptions['sourceSpaces'],
): Promise<readonly ResolvedSourceSpace[]> {
	const declarations = [
		{ name: 'app', root: appRoot },
		...(configured ?? []).map((space) => ({
			name: space.name,
			root: resolve(appRoot, space.root),
		})),
	]
	const names = new Set<string>()
	const physicalRoots = new Map<string, string>()
	const spaces: ResolvedSourceSpace[] = []
	for (const declaration of declarations) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(declaration.name)) {
			throw new Error(
				`[pluxel:plugin-semantics] invalid source space ${JSON.stringify(declaration.name)}`,
			)
		}
		if (names.has(declaration.name)) {
			throw new Error(
				`[pluxel:plugin-semantics] duplicate source space ${JSON.stringify(declaration.name)}`,
			)
		}
		names.add(declaration.name)
		let realRoot: string
		try {
			realRoot = await realpath(declaration.root)
		} catch (cause) {
			throw new Error(
				`[pluxel:plugin-semantics] source space ${declaration.name} root does not exist: ${declaration.root}`,
				{ cause },
			)
		}
		const duplicate = physicalRoots.get(realRoot)
		if (duplicate) {
			throw new Error(
				`[pluxel:plugin-semantics] source spaces ${duplicate} and ${declaration.name} resolve to the same root`,
			)
		}
		physicalRoots.set(realRoot, declaration.name)
		spaces.push({
			name: declaration.name,
			realRoot,
			depth: realRoot.split(sep).filter(Boolean).length,
		})
	}
	return Object.freeze(spaces.sort((left, right) => right.depth - left.depth))
}

async function canonicalSourceEntry(
	id: string,
	spaces: readonly ResolvedSourceSpace[],
	fileRealpaths: Map<string, Promise<string>>,
): Promise<Extract<PluginEntryAddress, { kind: 'source-entry' }>> {
	let realFilePromise = fileRealpaths.get(id)
	if (!realFilePromise) {
		realFilePromise = realpath(id)
		fileRealpaths.set(id, realFilePromise)
	}
	let realFile: string
	try {
		realFile = await realFilePromise
	} catch (cause) {
		fileRealpaths.delete(id)
		throw new Error(`[pluxel:plugin-semantics] Plugin source entry does not exist: ${id}`, {
			cause,
		})
	}
	for (const space of spaces) {
		const nativePath = relative(space.realRoot, realFile)
		if (
			!nativePath ||
			isAbsolute(nativePath) ||
			nativePath === '..' ||
			nativePath.startsWith(`..${sep}`)
		) {
			continue
		}
		const path = nativePath.split(sep).join('/')
		if (
			path.includes('\\') ||
			path.includes('?') ||
			path.includes('#') ||
			path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
		) {
			throw new Error(
				`[pluxel:plugin-semantics] Plugin source entry cannot form a canonical POSIX path: ${realFile}`,
			)
		}
		return Object.freeze({ kind: 'source-entry', sourceSpace: space.name, path })
	}
	throw new Error(
		`[pluxel:plugin-semantics] Plugin source entry ${realFile} is outside configured source spaces; add an explicit sourceSpaces mapping or expose it as a package-root named export`,
	)
}

function lexicalSourcePath(root: string, id: string): string {
	const nativePath = relative(resolve(root), resolve(id))
	if (
		!nativePath ||
		isAbsolute(nativePath) ||
		nativePath === '..' ||
		nativePath.startsWith(`..${sep}`)
	) {
		throw new Error(`[pluxel:plugin-semantics] ${id} is outside source space app`)
	}
	return nativePath.split(sep).join('/')
}

function definitionKey(address: PluginDefinitionAddress): string {
	return pluginDefinitionIndexKey(address)
}

function originKey(id: string, className: string): string {
	return `${resolve(stripQuery(id))}\0${className}`
}

function stripQuery(id: string): string {
	return id.split(/[?#]/, 1)[0] ?? id
}

function propertyName(value: unknown): string | undefined {
	return readIdentifier(value) ?? readLiteralString(value)
}

function literalNumber(value: unknown): number | undefined {
	const node = value as { type?: unknown; value?: unknown } | undefined
	return node?.type === 'Literal' && typeof node.value === 'number' ? node.value : undefined
}

function literalBoolean(value: unknown): boolean | undefined {
	const node = value as { type?: unknown; value?: unknown } | undefined
	return node?.type === 'Literal' && typeof node.value === 'boolean' ? node.value : undefined
}

function arrayOf(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function numberPosition(value: unknown, error: (message: string) => never, label: string): number {
	if (typeof value === 'number') return value
	return error(`[pluxel:plugin-semantics] cannot locate ${label}`)
}

function applyReplacements(code: string, replacements: readonly Replacement[]): string {
	let out = code
	for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
		out = `${out.slice(0, replacement.start)}${replacement.text}${out.slice(replacement.end)}`
	}
	return out
}
