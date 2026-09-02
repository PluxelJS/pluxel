import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_SHARED_MODULES,
	createWorkbenchFederationProducerPlan,
	workbenchFederationProducerName,
	type WorkbenchFederationDescriptorIdentity,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import type { WorkbenchContentSet } from '@pluxel/core/internal'
import type { Program } from 'oxc-parser'
import { dirname, extname, isAbsolute, relative, resolve } from 'pathe'
import { resolvePackageJsonPathWithOxc, resolveWithOxc } from '../resolver/oxc.ts'
import { collectImportSpecifiers } from '../rolldown/plugins/importCollector.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import { resolveWorkbenchFederationShared } from './build-contract.ts'

type Node = {
	type?: unknown
	start?: unknown
	end?: unknown
	name?: unknown
	value?: unknown
	[key: string]: unknown
}

type PluginOwner = Readonly<{
	className: string
	definition: PluginDefinitionAddress
}>

type ImportBinding = Readonly<{
	source: string
	resolved?: string
	imported: string
	namespace: boolean
}>

type ExportBinding =
	| Readonly<{ kind: 'local'; local: string }>
	| Readonly<{ kind: 'reexport'; source: string; resolved?: string; imported: string }>

type ModuleFacts = Readonly<{
	id: string
	code: string
	ast: Program
	imports: ReadonlyMap<string, ImportBinding>
	exports: ReadonlyMap<string, ExportBinding>
	exportAll: readonly Readonly<{ source: string; resolved?: string }>[]
	constants: ReadonlyMap<string, Node>
	functions: ReadonlyMap<string, Node>
}>

type PublishFact = Readonly<{
	owner: PluginOwner
	moduleId: string
	definitionExpression: Node
	hasBindings: boolean
}>

type BindingRef = Readonly<{
	moduleId: string
	localName: string
}>

type Renderer = Readonly<{
	moduleId: string
	entryPath: string
}>

type RendererGraphImport = Readonly<{
	specifier: string
	kind: 'static' | 'dynamic'
	typeOnly: boolean
	start?: number
	end?: number
	target?: string
}>

type RendererGraphModule = Readonly<{
	path: string
	source: string
	ast: Program
	imports: readonly RendererGraphImport[]
}>

type MarkdownDocument = Readonly<{
	kind: 'markdown-document'
	moduleId: string
	sourcePath: string
	slots: ReadonlyMap<string, WorkbenchSemanticContentSlot>
}>

type Placement = Readonly<{ kind: 'placement' }>

type Descriptor =
	| Readonly<{ kind: 'view'; renderer: Renderer }>
	| Readonly<{ kind: 'attachment'; renderer: Renderer }>
	| Readonly<{ kind: 'content'; document: MarkdownDocument; placement: Placement }>
	| Readonly<{
			kind: 'attachment-placement'
			provider: DefinedEntry
	  }>

type Definition = Readonly<{
	binding: BindingRef
	exportName: string
	entries: ReadonlyMap<string, Descriptor>
}>

type DefinedEntry = Readonly<{
	definition: Definition
	key: string
	descriptor: Descriptor
}>

type FunctionValue = Readonly<{
	moduleId: string
	node: Node
}>

type RecordValue = ReadonlyMap<string, SemanticValue>

type SemanticValue =
	| string
	| number
	| boolean
	| null
	| Renderer
	| Descriptor
	| Definition
	| DefinedEntry
	| FunctionValue
	| MarkdownDocument
	| Placement
	| RecordValue
	| WorkbenchNamespace

type WorkbenchNamespace = Readonly<{ kind: 'workbench-namespace' }>

type EvaluationEnvironment = ReadonlyMap<string, SemanticValue>

const WORKBENCH_NAMESPACE: WorkbenchNamespace = Object.freeze({
	kind: 'workbench-namespace',
})
const WORKBENCH_IMPORTS = new Set(['@pluxel/runtime/workbench'])
const WORKBENCH_REACT_IMPORTS = new Set(['@pluxel/runtime/workbench/react'])
const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/
const RESERVED_ENTRY_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'then'])
const GENERATED_ABI_VERSION = 3
const BUILD_REVISION_VERSION = 2
const FIXED_SHARED_PACKAGES = new Set(
	WORKBENCH_FEDERATION_SHARED_MODULES.map(packageNameFromSpecifier),
)
const SOURCE_RESOLVE_OPTIONS = {
	conditionNames: [
		'@pluxel/hmr',
		'@pluxel/source',
		'development',
		'browser',
		'import',
		'module',
		'default',
	],
	extensions: [
		'.tsx',
		'.ts',
		'.jsx',
		'.js',
		'.mts',
		'.mjs',
		'.cts',
		'.cjs',
		'.css',
		'.scss',
		'.sass',
		'.less',
		'.json',
	],
	tsconfig: 'auto' as const,
}

export type WorkbenchSemanticModuleInput = Readonly<{
	id: string
	code: string
	ast: Program
	owners: readonly PluginOwner[]
	resolve(source: string): Promise<string | undefined>
}>

export type WorkbenchSemanticProducerCompilation = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Package root containing the generated Bridge and resolving the producer dependency graph. */
	root: string
}>

export type WorkbenchSemanticContentSlot =
	| Readonly<{
			kind: 'data'
			key: string
	  }>
	| Readonly<{
			kind: 'action'
			key: string
			label: string
			input: 'none' | 'dialog' | 'embedded'
			confirm?: string
	  }>

export type WorkbenchSemanticContentCompilation = Readonly<{
	contentSet: WorkbenchContentSet
	digest: string
	bytes: Uint8Array
	/** Package root containing the Markdown source or packaged Content artifact. */
	root: string
	/** Exact Markdown source dependencies. Empty when reusing a packaged artifact. */
	sources: readonly string[]
}>

type WorkbenchSemanticCompilationSnapshot = Readonly<{
	producers: readonly WorkbenchSemanticProducerCompilation[]
	content: readonly WorkbenchSemanticContentCompilation[]
}>

export type WorkbenchSemanticLowering = Readonly<{
	reset(): void
	invalidate(): void
	collect(input: WorkbenchSemanticModuleInput): Promise<void>
	plans(): Promise<readonly WorkbenchFederationProducerPlan[]>
	compilations(): Promise<readonly WorkbenchSemanticProducerCompilation[]>
	contentCompilations(): Promise<readonly WorkbenchSemanticContentCompilation[]>
}>

/**
 * Semantic Workbench compiler. It interprets only a closed, side-effect-free subset of module
 * expressions rooted at the final `workbench.define(...)` binding. Plugin modules are never
 * evaluated, imported, or executed by the toolchain.
 */
export function createWorkbenchSemanticLowering(root: string): WorkbenchSemanticLowering {
	const sourceRoot = resolve(root)
	const modules = new Map<string, ModuleFacts>()
	const publications = new Map<string, PublishFact>()
	const loadingModules = new Map<string, Promise<ModuleFacts>>()
	let finalized: Promise<WorkbenchSemanticCompilationSnapshot> | undefined

	const reset = () => {
		modules.clear()
		publications.clear()
		loadingModules.clear()
		finalized = undefined
	}
	const invalidate = () => {
		finalized = undefined
	}

	const collect = async (input: WorkbenchSemanticModuleInput): Promise<void> => {
		finalized = undefined
		const id = stripQuery(resolve(input.id))
		const facts = await moduleFacts(id, input.code, input.ast, input.resolve)
		modules.set(id, facts)
		const owners = new Map(input.owners.map((owner) => [owner.className, owner] as const))
		const nextPublications = new Map<string, PublishFact>()

		for (const statement of input.ast.body as unknown as Node[]) {
			const declaration = unwrapDeclaration(statement)
			if (declaration?.type !== 'ClassDeclaration') continue
			const className = identifierName(declaration.id)
			if (!className) continue
			const calls = collectPublishCalls(declaration)
			if (calls.length === 0) continue
			const owner = owners.get(className)
			if (!owner) {
				throw semanticError(
					id,
					`${className} calls ctx.workbench.publish(), but only the owning @Plugin class may publish`,
				)
			}
			if (calls.length !== 1) {
				throw semanticError(id, `${className} must publish exactly once`)
			}
			const call = calls[0]!
			if (!isUnconditionalInitPublication(declaration, call)) {
				throw semanticError(
					id,
					`${className} publication must be one unconditional statement in init()`,
				)
			}
			const args = nodes(call.arguments)
			if (args.length === 0 || args.length > 2) {
				throw semanticError(
					id,
					`${className} publish() must receive definition and optional bindings`,
				)
			}
			const key = pluginDefinitionIndexKey(owner.definition)
			if (nextPublications.has(key)) {
				throw semanticError(id, `${className} has duplicate Workbench publication ownership`)
			}
			nextPublications.set(key, {
				owner,
				moduleId: id,
				definitionExpression: args[0]!,
				hasBindings: args.length === 2,
			})
		}

		// Vite may concurrently transform one module for prefetch and evaluation. Treat collection as
		// an atomic module snapshot so repeated transforms are idempotent and HMR can remove a
		// publication, while still rejecting two distinct modules that claim the same owner.
		for (const [key, publication] of nextPublications) {
			const current = publications.get(key)
			if (current && current.moduleId !== id) {
				throw semanticError(
					id,
					`${publication.owner.className} has duplicate Workbench publication ownership`,
				)
			}
		}
		for (const [key, publication] of publications) {
			if (publication.moduleId === id) publications.delete(key)
		}
		for (const [key, publication] of nextPublications) publications.set(key, publication)
	}

	const compilations = (): Promise<readonly WorkbenchSemanticProducerCompilation[]> => {
		finalized ??= finalizePlans()
		return finalized.then((snapshot) => snapshot.producers)
	}
	const plans = async (): Promise<readonly WorkbenchFederationProducerPlan[]> => {
		const currentCompilations = await compilations()
		return Object.freeze(currentCompilations.map((compilation) => compilation.plan))
	}
	const contentCompilations = (): Promise<readonly WorkbenchSemanticContentCompilation[]> => {
		finalized ??= finalizePlans()
		return finalized.then((snapshot) => snapshot.content)
	}

	const finalizePlans = async (): Promise<WorkbenchSemanticCompilationSnapshot> => {
		const producers: WorkbenchSemanticProducerCompilation[] = []
		const content: WorkbenchSemanticContentCompilation[] = []
		for (const publication of [...publications.values()].sort((left, right) =>
			pluginDefinitionIndexKey(left.owner.definition).localeCompare(
				pluginDefinitionIndexKey(right.owner.definition),
			),
		)) {
			const definitionBinding = await resolveDefinitionBinding(
				publication.moduleId,
				publication.definitionExpression,
				new Set(),
			)
			const definition = await evaluateDefinition(definitionBinding)
			const requiresBindings = [...definition.entries.values()].some(
				(descriptor) => descriptor.kind !== 'content' || descriptor.document.slots.size > 0,
			)
			if (publication.hasBindings !== requiresBindings) {
				throw semanticError(
					publication.moduleId,
					requiresBindings
						? 'publish() requires bindings for every View, Attachment, and interactive Content'
						: 'static Content-only publish() must not receive bindings',
				)
			}
			const buildRoot = resolveProducerBuildRoot(sourceRoot, publication.moduleId)
			const contentEntries = [...definition.entries]
				.filter(
					(entry): entry is [string, Extract<Descriptor, { kind: 'content' }>] =>
						entry[1].kind === 'content',
				)
				.sort(([left], [right]) => left.localeCompare(right))
			if (contentEntries.length > 0) {
				const { compileWorkbenchContentSet } = await import('./content-compiler.ts')
				content.push(
					await compileWorkbenchContentSet({
						definition: publication.owner.definition,
						root: buildRoot,
						entries: contentEntries.map(([key, descriptor]) => ({
							key,
							sourcePath: descriptor.document.sourcePath,
							slots: [...descriptor.document.slots.values()],
						})),
					}),
				)
			}
			const localEntries = [...definition.entries]
				.filter(
					(entry): entry is [string, Extract<Descriptor, { renderer: Renderer }>] =>
						entry[1].kind === 'view' || entry[1].kind === 'attachment',
				)
				.sort(([left], [right]) => left.localeCompare(right))
			if (localEntries.length === 0) continue

			const producer = workbenchFederationProducerName(publication.owner.definition)
			const generatedEntries = await Promise.all(
				localEntries.map(async ([key, descriptor]) => {
					const identity: WorkbenchFederationDescriptorIdentity = Object.freeze({
						kind: descriptor.kind,
						owner: publication.owner.definition,
						key,
					})
					const bridgeEntryPath = await writeBridgeEntry({
						root: buildRoot,
						producer,
						identity,
						definition,
						renderer: descriptor.renderer,
					})
					return { descriptor: identity, bridgeEntryPath, renderer: descriptor.renderer }
				}),
			)
			const buildRevision = await buildRevisionFor(
				buildRoot,
				sourceRoot,
				publication.owner.definition,
				definition,
				generatedEntries,
			)
			const plan = createWorkbenchFederationProducerPlan({
				definition: publication.owner.definition,
				buildRevision,
				entries: generatedEntries.map(({ descriptor, bridgeEntryPath }) => ({
					descriptor,
					bridgeEntryPath,
				})),
			})
			producers.push(Object.freeze({ plan, root: buildRoot }))
		}
		return Object.freeze({
			producers: Object.freeze(producers),
			content: Object.freeze(content),
		})
	}

	const getModule = async (id: string): Promise<ModuleFacts> => {
		const canonicalId = stripQuery(resolve(id))
		const collected = modules.get(canonicalId)
		if (collected) return collected
		let pending = loadingModules.get(canonicalId)
		if (!pending) {
			pending = (async () => {
				const code = await readFile(canonicalId, 'utf-8').catch((cause) => {
					throw new Error(`[workbench-semantic] cannot read imported module ${canonicalId}`, {
						cause,
					})
				})
				const ast = parseStandaloneWithLang(code, canonicalId)
				if (!ast) throw semanticError(canonicalId, 'failed to parse imported definition module')
				const facts = await moduleFacts(canonicalId, code, ast, async (source) =>
					resolveSource(canonicalId, source),
				)
				modules.set(canonicalId, facts)
				return facts
			})()
			loadingModules.set(canonicalId, pending)
		}
		return pending
	}

	const resolveDefinitionBinding = async (
		moduleId: string,
		expression: Node,
		seen: Set<string>,
	): Promise<BindingRef> => {
		const value = unwrapExpression(expression)
		if (value.type !== 'Identifier' || typeof value.name !== 'string') {
			throw semanticError(
				moduleId,
				'publish() first argument must be a statically traceable final workbench.define() binding',
			)
		}
		const marker = `${moduleId}\0${value.name}`
		if (seen.has(marker)) throw semanticError(moduleId, 'cyclic Workbench definition binding')
		seen.add(marker)
		const module = await getModule(moduleId)
		const imported = module.imports.get(value.name)
		if (imported) {
			if (imported.namespace || !imported.resolved) {
				throw semanticError(moduleId, `cannot resolve definition import ${value.name}`)
			}
			return resolveExportBinding(imported.resolved, imported.imported, seen)
		}
		const initializer = module.constants.get(value.name)
		if (!initializer) {
			throw semanticError(moduleId, `definition binding ${value.name} must be a module-level const`)
		}
		const unwrapped = unwrapExpression(initializer)
		if (isWorkbenchCall(unwrapped, module, 'define')) return { moduleId, localName: value.name }
		if (unwrapped.type === 'Identifier') {
			return resolveDefinitionBinding(moduleId, unwrapped, seen)
		}
		throw semanticError(
			moduleId,
			`${value.name} must be the final workbench.define(...) binding, not a dynamic expression`,
		)
	}

	const resolveExportBinding = async (
		moduleId: string,
		exportName: string,
		seen: Set<string>,
	): Promise<BindingRef> => {
		const marker = `export:${moduleId}\0${exportName}`
		if (seen.has(marker)) throw semanticError(moduleId, `cyclic re-export ${exportName}`)
		seen.add(marker)
		const module = await getModule(moduleId)
		const exported = module.exports.get(exportName)
		if (!exported) {
			const candidates: BindingRef[] = []
			for (const exportedModule of module.exportAll) {
				if (!exportedModule.resolved) continue
				try {
					candidates.push(
						await resolveExportBinding(exportedModule.resolved, exportName, new Set(seen)),
					)
				} catch (error) {
					if (!isMissingExportError(error)) throw error
				}
			}
			const unique = new Map(
				candidates.map((candidate) => [`${candidate.moduleId}\0${candidate.localName}`, candidate]),
			)
			if (unique.size === 1) return [...unique.values()][0]!
			if (unique.size > 1) {
				throw semanticError(moduleId, `ambiguous re-exported Workbench definition ${exportName}`)
			}
			throw semanticError(moduleId, `imported Workbench definition export ${exportName} is missing`)
		}
		if (exported.kind === 'reexport') {
			if (!exported.resolved) {
				throw semanticError(moduleId, `cannot resolve re-export ${exportName}`)
			}
			return resolveExportBinding(exported.resolved, exported.imported, seen)
		}
		return resolveDefinitionBinding(moduleId, { type: 'Identifier', name: exported.local }, seen)
	}

	const evaluateDefinition = async (binding: BindingRef): Promise<Definition> => {
		const module = await getModule(binding.moduleId)
		const initializer = module.constants.get(binding.localName)
		if (!initializer) throw semanticError(binding.moduleId, 'definition binding disappeared')
		const call = unwrapExpression(initializer)
		if (!isWorkbenchCall(call, module, 'define')) {
			throw semanticError(binding.moduleId, `${binding.localName} is not workbench.define(...)`)
		}
		const args = nodes(call.arguments)
		if (args.length !== 1) {
			throw semanticError(
				binding.moduleId,
				'workbench.define() must receive one final entry record',
			)
		}
		const entriesValue = await evaluateExpression(binding.moduleId, args[0]!, new Map(), new Set())
		if (!(entriesValue instanceof Map)) {
			throw semanticError(binding.moduleId, 'workbench.define() entries must resolve to one record')
		}
		const exportName = exportedName(module, binding.localName)
		if (!exportName) {
			throw semanticError(
				binding.moduleId,
				`${binding.localName} must be a named export so generated Bridge entries can import its exact descriptor`,
			)
		}
		const entries = new Map<string, Descriptor>()
		for (const [key, entry] of entriesValue) {
			assertEntryKey(binding.moduleId, key)
			if (!isDescriptor(entry)) {
				throw semanticError(
					binding.moduleId,
					`${binding.localName}.${key} is not a Workbench descriptor`,
				)
			}
			entries.set(key, entry)
		}
		if (entries.size === 0) {
			throw semanticError(binding.moduleId, `${binding.localName} must not be empty`)
		}
		return Object.freeze({
			binding,
			exportName,
			entries: entries as ReadonlyMap<string, Descriptor>,
		})
	}

	const evaluateExpression = async (
		moduleId: string,
		expression: Node,
		environment: EvaluationEnvironment,
		stack: Set<string>,
	): Promise<SemanticValue> => {
		const node = unwrapExpression(expression)
		const module = await getModule(moduleId)
		switch (node.type) {
			case 'Literal':
				if (
					typeof node.value === 'string' ||
					typeof node.value === 'number' ||
					typeof node.value === 'boolean' ||
					node.value === null
				) {
					return node.value as string | number | boolean | null
				}
				break
			case 'Identifier': {
				const name = String(node.name)
				if (environment.has(name)) return environment.get(name)!
				const imported = module.imports.get(name)
				if (imported) {
					if (WORKBENCH_IMPORTS.has(imported.source) && imported.imported === 'workbench') {
						return WORKBENCH_NAMESPACE
					}
					if (!imported.resolved || imported.namespace) {
						throw semanticError(moduleId, `unsupported imported value ${name}`)
					}
					const targetModule = await getModule(imported.resolved)
					const target = targetModule.exports.get(imported.imported)
					if (!target) {
						const definitionBinding = await resolveExportBinding(
							imported.resolved,
							imported.imported,
							new Set(),
						)
						return evaluateDefinition(definitionBinding)
					}
					if (target.kind !== 'local') {
						throw semanticError(moduleId, `cannot statically evaluate re-exported value ${name}`)
					}
					return evaluateIdentifier(imported.resolved, target.local, environment, stack)
				}
				return evaluateIdentifier(moduleId, name, environment, stack)
			}
			case 'ObjectExpression': {
				const record = new Map<string, SemanticValue>()
				for (const property of nodes(node.properties)) {
					if (property.type === 'SpreadElement') {
						const spread = await evaluateExpression(
							moduleId,
							object(property.argument)!,
							environment,
							stack,
						)
						if (!(spread instanceof Map)) {
							throw semanticError(moduleId, 'Workbench entry spread must resolve to a record')
						}
						for (const [key, value] of spread) record.set(key, value)
						continue
					}
					if (property.type !== 'Property' || property.computed === true) {
						throw semanticError(moduleId, 'Workbench entry record requires static properties')
					}
					const key = propertyName(property.key)
					if (!key) throw semanticError(moduleId, 'Workbench entry key must be static')
					const valueNode = object(property.value)
					if (!valueNode) throw semanticError(moduleId, `Workbench entry ${key} has no value`)
					record.set(key, await evaluateExpression(moduleId, valueNode, environment, stack))
				}
				return record
			}
			case 'TemplateLiteral': {
				const expressions = nodes(node.expressions)
				const quasis = nodes(node.quasis)
				let output = ''
				for (let index = 0; index < quasis.length; index += 1) {
					const quasi = quasis[index]!
					const text = object(quasi.value)
					output += String(text?.cooked ?? text?.raw ?? '')
					const expressionNode = expressions[index]
					if (expressionNode) {
						const value = await evaluateExpression(moduleId, expressionNode, environment, stack)
						if (!isPrimitive(value)) {
							throw semanticError(moduleId, 'template interpolation must be a static primitive')
						}
						output += String(value)
					}
				}
				return output
			}
			case 'MemberExpression': {
				const base = await evaluateExpression(moduleId, object(node.object)!, environment, stack)
				const key = memberName(node)
				if (!key) throw semanticError(moduleId, 'computed Workbench member is not static')
				if (isDefinition(base)) {
					const descriptor = base.entries.get(key)
					if (!descriptor) throw semanticError(moduleId, `definition has no entry ${key}`)
					return Object.freeze({ definition: base, key, descriptor })
				}
				if (base instanceof Map && base.has(key)) return base.get(key)!
				throw semanticError(moduleId, `unsupported static member access .${key}`)
			}
			case 'CallExpression':
				return evaluateCall(moduleId, node, environment, stack)
			case 'ArrowFunctionExpression':
			case 'FunctionExpression':
			case 'FunctionDeclaration':
				return Object.freeze({ moduleId, node })
		}
		throw semanticError(
			moduleId,
			`dynamic Workbench topology expression ${String(node.type ?? 'unknown')} is not supported`,
		)
	}

	const evaluateIdentifier = async (
		moduleId: string,
		name: string,
		environment: EvaluationEnvironment,
		stack: Set<string>,
	): Promise<SemanticValue> => {
		const marker = `${moduleId}\0${name}`
		if (stack.has(marker)) throw semanticError(moduleId, `cyclic static value ${name}`)
		const nextStack = new Set(stack).add(marker)
		const module = await getModule(moduleId)
		const initializer = module.constants.get(name)
		if (initializer) {
			if (isWorkbenchCall(unwrapExpression(initializer), module, 'define')) {
				return evaluateDefinition({ moduleId, localName: name })
			}
			return evaluateExpression(moduleId, initializer, environment, nextStack)
		}
		const fn = module.functions.get(name)
		if (fn) return Object.freeze({ moduleId, node: fn })
		throw semanticError(moduleId, `cannot statically resolve ${name}`)
	}

	const parseContentSlots = async (
		moduleId: string,
		expression: Node | undefined,
		environment: EvaluationEnvironment,
		stack: Set<string>,
	): Promise<ReadonlyMap<string, WorkbenchSemanticContentSlot>> => {
		if (!expression) return new Map()
		const resolved = await resolveStaticValueNode(
			moduleId,
			expression,
			'workbench.markdown() slots',
			new Set(),
		)
		if (resolved.node.type !== 'ObjectExpression') {
			throw semanticError(moduleId, 'workbench.markdown() slots must resolve to one static record')
		}
		const slots = new Map<string, WorkbenchSemanticContentSlot>()
		for (const property of nodes(resolved.node.properties)) {
			if (property.type !== 'Property' || property.computed === true) {
				throw semanticError(moduleId, 'workbench.markdown() slots require exact static properties')
			}
			const key = propertyName(property.key)
			if (!key) throw semanticError(moduleId, 'workbench.markdown() slot key must be static')
			assertEntryKey(moduleId, key)
			if (slots.has(key)) {
				throw semanticError(moduleId, `workbench.markdown() slot ${key} is duplicated`)
			}
			const value = object(property.value)
			if (!value) throw semanticError(moduleId, `workbench.markdown() slot ${key} has no value`)
			slots.set(key, await parseContentSlot(resolved.moduleId, key, value, environment, stack))
		}
		return new Map([...slots].sort(([left], [right]) => left.localeCompare(right)))
	}

	const parseContentSlot = async (
		moduleId: string,
		key: string,
		expression: Node,
		environment: EvaluationEnvironment,
		stack: Set<string>,
	): Promise<WorkbenchSemanticContentSlot> => {
		const resolved = await resolveStaticValueNode(
			moduleId,
			expression,
			`Workbench Content slot ${key}`,
			new Set(),
		)
		const call = resolved.node
		const module = await getModule(resolved.moduleId)
		if (call.type !== 'CallExpression') {
			throw semanticError(moduleId, `Workbench Content slot ${key} must be workbench.data/action()`)
		}
		const args = nodes(call.arguments)
		if (isWorkbenchCall(call, module, 'data')) {
			if (args.length !== 1) {
				throw semanticError(
					moduleId,
					`workbench.data() for slot ${key} requires one schema binding`,
				)
			}
			await assertSchemaBinding(resolved.moduleId, args[0]!, environment)
			return Object.freeze({ kind: 'data', key })
		}
		if (!isWorkbenchCall(call, module, 'action') || args.length !== 1) {
			throw semanticError(moduleId, `Workbench Content slot ${key} must be workbench.data/action()`)
		}
		const options = await staticObjectProperties(
			resolved.moduleId,
			args[0]!,
			`workbench.action() for slot ${key}`,
		)
		const allowed = new Set(['label', 'input', 'form', 'confirm'])
		for (const option of options.keys()) {
			if (!allowed.has(option)) {
				throw semanticError(
					moduleId,
					`workbench.action() for slot ${key} has unknown option ${option}`,
				)
			}
		}
		const labelNode = options.get('label')
		if (!labelNode) {
			throw semanticError(moduleId, `workbench.action() for slot ${key} requires label`)
		}
		const label = await evaluateExpression(resolved.moduleId, labelNode, environment, stack)
		if (typeof label !== 'string' || label.length === 0) {
			throw semanticError(moduleId, `workbench.action() for slot ${key} requires a static label`)
		}
		const confirmNode = options.get('confirm')
		const confirm = confirmNode
			? await evaluateExpression(resolved.moduleId, confirmNode, environment, stack)
			: undefined
		if (confirm !== undefined && (typeof confirm !== 'string' || confirm.length === 0)) {
			throw semanticError(
				moduleId,
				`workbench.action() for slot ${key} requires static confirmation text`,
			)
		}
		const inputNode = options.get('input')
		const formNode = options.get('form')
		if (!inputNode) {
			if (formNode) {
				throw semanticError(moduleId, `workbench.action() for slot ${key} form requires input`)
			}
			return Object.freeze({
				kind: 'action',
				key,
				label,
				input: 'none',
				...(confirm === undefined ? {} : { confirm: confirm as string }),
			})
		}
		await assertSchemaBinding(resolved.moduleId, inputNode, environment)
		let input: 'dialog' | 'embedded' = 'dialog'
		if (formNode) {
			const form = await evaluateExpression(resolved.moduleId, formNode, environment, stack)
			if (form !== 'embedded') {
				throw semanticError(moduleId, `workbench.action() for slot ${key} form must be "embedded"`)
			}
			input = 'embedded'
		}
		return Object.freeze({
			kind: 'action',
			key,
			label,
			input,
			...(confirm ? { confirm: confirm as string } : {}),
		})
	}

	const assertSchemaBinding = async (
		moduleId: string,
		expression: Node,
		environment: EvaluationEnvironment,
	): Promise<void> => {
		const node = unwrapExpression(expression)
		if (node.type !== 'Identifier' || typeof node.name !== 'string' || environment.has(node.name)) {
			throw semanticError(moduleId, 'Workbench Content schema must be a module-level binding')
		}
		const module = await getModule(moduleId)
		if (!module.constants.has(node.name) && !module.imports.has(node.name)) {
			throw semanticError(
				moduleId,
				`Workbench Content schema binding ${node.name} is not traceable`,
			)
		}
	}

	const staticObjectProperties = async (
		moduleId: string,
		expression: Node,
		label: string,
	): Promise<ReadonlyMap<string, Node>> => {
		const resolved = await resolveStaticValueNode(moduleId, expression, label, new Set())
		if (resolved.node.type !== 'ObjectExpression') {
			throw semanticError(moduleId, `${label} must resolve to one static record`)
		}
		const result = new Map<string, Node>()
		for (const property of nodes(resolved.node.properties)) {
			if (property.type !== 'Property' || property.computed === true) {
				throw semanticError(moduleId, `${label} requires exact static properties`)
			}
			const key = propertyName(property.key)
			if (!key) throw semanticError(moduleId, `${label} property key must be static`)
			if (result.has(key)) throw semanticError(moduleId, `${label} property ${key} is duplicated`)
			const value = object(property.value)
			if (!value) throw semanticError(moduleId, `${label} property ${key} has no value`)
			result.set(key, value)
		}
		return result
	}

	const resolveStaticValueNode = async (
		moduleId: string,
		expression: Node,
		label: string,
		seen: Set<string>,
	): Promise<Readonly<{ moduleId: string; node: Node }>> => {
		const node = unwrapExpression(expression)
		if (node.type !== 'Identifier' || typeof node.name !== 'string') {
			return Object.freeze({ moduleId, node })
		}
		const marker = `${moduleId}\0${node.name}`
		if (seen.has(marker)) throw semanticError(moduleId, `${label} has a cyclic binding`)
		seen.add(marker)
		const module = await getModule(moduleId)
		const imported = module.imports.get(node.name)
		if (imported) {
			if (imported.namespace || !imported.resolved) {
				throw semanticError(moduleId, `${label} import ${node.name} is not statically traceable`)
			}
			return resolveStaticExportNode(imported.resolved, imported.imported, label, seen)
		}
		const initializer = module.constants.get(node.name)
		if (!initializer)
			throw semanticError(moduleId, `${label} binding ${node.name} is not traceable`)
		return resolveStaticValueNode(moduleId, initializer, label, seen)
	}

	const resolveStaticExportNode = async (
		moduleId: string,
		exportName: string,
		label: string,
		seen: Set<string>,
	): Promise<Readonly<{ moduleId: string; node: Node }>> => {
		const module = await getModule(moduleId)
		const exported = module.exports.get(exportName)
		if (!exported) throw semanticError(moduleId, `${label} export ${exportName} is missing`)
		if (exported.kind === 'reexport') {
			if (!exported.resolved) {
				throw semanticError(moduleId, `${label} re-export ${exportName} is not traceable`)
			}
			return resolveStaticExportNode(exported.resolved, exported.imported, label, seen)
		}
		return resolveStaticValueNode(
			moduleId,
			{ type: 'Identifier', name: exported.local },
			label,
			seen,
		)
	}

	const evaluateCall = async (
		moduleId: string,
		call: Node,
		environment: EvaluationEnvironment,
		stack: Set<string>,
	): Promise<SemanticValue> => {
		const module = await getModule(moduleId)
		const callee = unwrapExpression(object(call.callee)!)
		const args = nodes(call.arguments)
		if (callee.type === 'MemberExpression') {
			const method = memberName(callee)
			const objectNode = object(callee.object)!
			if (isWorkbenchMember(callee, module)) {
				switch (method) {
					case 'markdown': {
						if ((args.length !== 2 && args.length !== 3) || !isImportMetaUrl(args[0]!)) {
							throw semanticError(
								moduleId,
								'workbench.markdown() must use import.meta.url, one literal relative path, and optional static slots',
							)
						}
						const path = literalString(args[1])
						if (path === null || (!path.startsWith('./') && !path.startsWith('../'))) {
							throw semanticError(moduleId, 'workbench.markdown() path must be a relative literal')
						}
						if (path.includes('\\') || path.includes('?') || path.includes('#')) {
							throw semanticError(moduleId, 'workbench.markdown() path must be normalized')
						}
						if (extname(path).toLowerCase() !== '.md') {
							throw semanticError(
								moduleId,
								'workbench.markdown() source must use the .md extension',
							)
						}
						return Object.freeze({
							kind: 'markdown-document',
							moduleId,
							sourcePath: resolve(dirname(moduleId), path),
							slots: await parseContentSlots(moduleId, args[2], environment, stack),
						})
					}
					case 'entry': {
						if (args.length !== 2 || !isImportMetaUrl(args[0]!)) {
							throw semanticError(
								moduleId,
								'workbench.entry() must use import.meta.url and one literal relative path',
							)
						}
						const path = await evaluateExpression(moduleId, args[1]!, environment, stack)
						if (typeof path !== 'string' || (!path.startsWith('./') && !path.startsWith('../'))) {
							throw semanticError(moduleId, 'workbench.entry() path must be module-relative')
						}
						if (path.includes('\\') || path.includes('?') || path.includes('#')) {
							throw semanticError(moduleId, 'workbench.entry() path must be normalized')
						}
						return Object.freeze({ moduleId, entryPath: resolve(dirname(moduleId), path) })
					}
					case 'view':
					case 'attachment': {
						if (args.length !== 1) {
							throw semanticError(moduleId, `workbench.${method}() must receive one record`)
						}
						const options = await evaluateExpression(moduleId, args[0]!, environment, stack)
						if (!(options instanceof Map) || !isRenderer(options.get('renderer'))) {
							throw semanticError(moduleId, `workbench.${method}() requires a static renderer`)
						}
						return Object.freeze({ kind: method, renderer: options.get('renderer')! })
					}
					case 'content': {
						if (args.length !== 1) {
							throw semanticError(moduleId, 'workbench.content() must receive one record')
						}
						const options = await evaluateExpression(moduleId, args[0]!, environment, stack)
						if (!(options instanceof Map)) {
							throw semanticError(moduleId, 'workbench.content() must receive one static record')
						}
						const keys = [...options.keys()].sort()
						if (keys.length !== 2 || keys[0] !== 'document' || keys[1] !== 'placement') {
							throw semanticError(
								moduleId,
								'workbench.content() requires exactly document and placement',
							)
						}
						const document = options.get('document')
						const placement = options.get('placement')
						if (!isMarkdownDocument(document) || !isPlacement(placement)) {
							throw semanticError(
								moduleId,
								'workbench.content() requires workbench.markdown() and a static placement',
							)
						}
						return Object.freeze({ kind: 'content', document, placement })
					}
					case 'tab':
					case 'route':
						return Object.freeze({ kind: 'placement' })
					case 'icons':
						return new Map()
					case 'define':
						throw semanticError(moduleId, 'nested workbench.define() is not a valid entry value')
				}
			}
			const base = await evaluateExpression(moduleId, objectNode, environment, stack)
			if (method === 'place' && isDefinedEntry(base) && base.descriptor.kind === 'attachment') {
				if (args.length !== 1) {
					throw semanticError(moduleId, 'Attachment.place() must receive one static placement')
				}
				await evaluateExpression(moduleId, args[0]!, environment, stack)
				return Object.freeze({ kind: 'attachment-placement', provider: base })
			}
		}

		const callable = await evaluateExpression(moduleId, callee, environment, stack)
		if (!isFunctionValue(callable)) {
			throw semanticError(
				moduleId,
				'Workbench topology may call only a statically resolved pure helper',
			)
		}
		const parameters = nodes(callable.node.params)
		if (parameters.length !== args.length) {
			throw semanticError(moduleId, 'static Workbench helper arguments do not match its parameters')
		}
		const childEnvironment = new Map<string, SemanticValue>()
		for (let index = 0; index < parameters.length; index += 1) {
			const parameter = unwrapExpression(parameters[index]!)
			if (parameter.type !== 'Identifier' || typeof parameter.name !== 'string') {
				throw semanticError(moduleId, 'static Workbench helper parameters must be identifiers')
			}
			childEnvironment.set(
				parameter.name,
				await evaluateExpression(moduleId, args[index]!, environment, stack),
			)
		}
		const body = object(callable.node.body)
		if (!body) throw semanticError(callable.moduleId, 'static Workbench helper has no body')
		if (body.type !== 'BlockStatement') {
			return evaluateExpression(callable.moduleId, body, childEnvironment, stack)
		}
		const statements = nodes(body.body)
		if (statements.length !== 1 || statements[0]?.type !== 'ReturnStatement') {
			throw semanticError(
				callable.moduleId,
				'static Workbench helper must contain exactly one unconditional return',
			)
		}
		const returned = object(statements[0]!.argument)
		if (!returned)
			throw semanticError(callable.moduleId, 'static Workbench helper must return a value')
		return evaluateExpression(callable.moduleId, returned, childEnvironment, stack)
	}

	return Object.freeze({ reset, invalidate, collect, plans, compilations, contentCompilations })
}

function resolveProducerBuildRoot(sourceRoot: string, publicationModuleId: string): string {
	let directory = dirname(resolve(publicationModuleId))
	for (;;) {
		if (existsSync(resolve(directory, 'package.json'))) return directory
		const parent = dirname(directory)
		if (parent === directory) return sourceRoot
		directory = parent
	}
}

async function moduleFacts(
	id: string,
	code: string,
	ast: Program,
	resolveSpecifier: (source: string) => Promise<string | undefined>,
): Promise<ModuleFacts> {
	const imports = new Map<string, ImportBinding>()
	const exports = new Map<string, ExportBinding>()
	const exportAll: Array<Readonly<{ source: string; resolved?: string }>> = []
	const constants = new Map<string, Node>()
	const functions = new Map<string, Node>()
	for (const statement of ast.body as unknown as Node[]) {
		if (statement.type === 'ImportDeclaration') {
			const source = literalString(statement.source)
			if (!source) continue
			const resolved = WORKBENCH_IMPORTS.has(source)
				? undefined
				: await resolveSpecifier(source).then((value) => value && stripQuery(resolve(value)))
			for (const specifier of nodes(statement.specifiers)) {
				const local = identifierName(specifier.local)
				if (!local) continue
				if (specifier.type === 'ImportNamespaceSpecifier') {
					imports.set(local, { source, resolved, imported: '*', namespace: true })
				} else if (specifier.type === 'ImportDefaultSpecifier') {
					imports.set(local, { source, resolved, imported: 'default', namespace: false })
				} else if (specifier.type === 'ImportSpecifier') {
					imports.set(local, {
						source,
						resolved,
						imported: propertyName(specifier.imported) ?? local,
						namespace: false,
					})
				}
			}
			continue
		}

		const declaration = unwrapDeclaration(statement)
		if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
			for (const declarator of nodes(declaration.declarations)) {
				const name = identifierName(declarator.id)
				const initializer = object(declarator.init)
				if (name && initializer) constants.set(name, initializer)
			}
		}
		if (declaration?.type === 'FunctionDeclaration') {
			const name = identifierName(declaration.id)
			if (name) functions.set(name, declaration)
		}

		if (statement.type === 'ExportNamedDeclaration') {
			const source = literalString(statement.source)
			const resolved = source
				? await resolveSpecifier(source).then((value) => value && stripQuery(resolve(value)))
				: undefined
			for (const specifier of nodes(statement.specifiers)) {
				const exported = propertyName(specifier.exported)
				const local = propertyName(specifier.local)
				if (!exported || !local) continue
				exports.set(
					exported,
					source
						? { kind: 'reexport', source, resolved, imported: local }
						: { kind: 'local', local },
				)
			}
			const declaredName = declaration ? declarationName(declaration) : undefined
			if (declaredName) exports.set(declaredName, { kind: 'local', local: declaredName })
		}
		if (statement.type === 'ExportDefaultDeclaration') {
			const declaredName = declarationName(statement)
			if (declaredName) exports.set('default', { kind: 'local', local: declaredName })
		}
		if (statement.type === 'ExportAllDeclaration') {
			const source = literalString(statement.source)
			if (!source) continue
			const resolved = await resolveSpecifier(source).then(
				(value) => value && stripQuery(resolve(value)),
			)
			exportAll.push({ source, resolved })
		}
	}
	return Object.freeze({
		id,
		code,
		ast,
		imports,
		exports,
		exportAll: Object.freeze(exportAll),
		constants,
		functions,
	})
}

function collectPublishCalls(classNode: Node): Node[] {
	const calls: Node[] = []
	walk(classNode.body, (node) => {
		if (node.type === 'CallExpression' && isPublishCallee(node.callee)) calls.push(node)
	})
	return calls
}

function isPublishCallee(input: unknown): boolean {
	const publish = unwrapExpression(object(input) ?? {})
	if (publish.type !== 'MemberExpression' || memberName(publish) !== 'publish') return false
	const workbench = unwrapExpression(object(publish.object) ?? {})
	if (workbench.type !== 'MemberExpression' || memberName(workbench) !== 'workbench') return false
	const ctx = unwrapExpression(object(workbench.object) ?? {})
	if (ctx.type !== 'MemberExpression' || memberName(ctx) !== 'ctx') return false
	return unwrapExpression(object(ctx.object) ?? {}).type === 'ThisExpression'
}

function isUnconditionalInitPublication(classNode: Node, call: Node): boolean {
	for (const element of nodes(object(classNode.body)?.body)) {
		if (element.type !== 'MethodDefinition' || propertyName(element.key) !== 'init') continue
		const body = object(object(element.value)?.body)
		if (body?.type !== 'BlockStatement') return false
		return nodes(body.body).some(
			(statement) =>
				statement.type === 'ExpressionStatement' &&
				unwrapExpression(object(statement.expression) ?? {}) === call,
		)
	}
	return false
}

function isWorkbenchCall(call: Node, module: ModuleFacts, method: string): boolean {
	return (
		call.type === 'CallExpression' &&
		object(call.callee)?.type === 'MemberExpression' &&
		memberName(object(call.callee)!) === method &&
		isWorkbenchMember(object(call.callee)!, module)
	)
}

function isWorkbenchMember(member: Node, module: ModuleFacts): boolean {
	const owner = unwrapExpression(object(member.object) ?? {})
	if (owner.type !== 'Identifier' || typeof owner.name !== 'string') return false
	const imported = module.imports.get(owner.name)
	return Boolean(
		imported && WORKBENCH_IMPORTS.has(imported.source) && imported.imported === 'workbench',
	)
}

function exportedName(module: ModuleFacts, localName: string): string | undefined {
	return [...module.exports]
		.filter(([, binding]) => binding.kind === 'local' && binding.local === localName)
		.map(([name]) => name)
		.filter((name) => name !== 'default')
		.sort()[0]
}

async function writeBridgeEntry(input: {
	root: string
	producer: string
	identity: WorkbenchFederationDescriptorIdentity
	definition: Definition
	renderer: Renderer
}): Promise<string> {
	const entryRevision = createHash('sha256')
		.update(`workbench-generated-entry:${GENERATED_ABI_VERSION}\n`)
		.update(`${JSON.stringify(input.identity)}\n`)
		.update(`definition-export:${input.definition.exportName}\n`)
		.digest('hex')
		.slice(0, 16)
	const generatedDir = resolve(
		input.root,
		'.pluxel/workbench-generated',
		input.producer,
		entryRevision,
	)
	const bridgePath = resolve(generatedDir, `${input.identity.key}.tsx`)
	await mkdir(generatedDir, { recursive: true })
	const projectedRenderer = await writeProjectedRenderer({ ...input, generatedDir })
	const rendererImport = relativeImport(bridgePath, projectedRenderer)
	const source = [
		'// Generated by @pluxel/rolldown. Do not edit.',
		`import { createWorkbenchBridge } from '@pluxel/runtime/internal/workbench-react'`,
		`import Renderer from ${JSON.stringify(rendererImport)}`,
		'',
		`export default createWorkbenchBridge(${JSON.stringify(input.identity)}, Renderer)`,
		'',
	].join('\n')
	const previous = await readFile(bridgePath, 'utf-8').catch((): undefined => undefined)
	if (previous !== source) await writeFile(bridgePath, source, 'utf-8')
	return normalizeRelativePath(relative(input.root, bridgePath), 'generated Bridge entry')
}

async function writeProjectedRenderer(input: {
	generatedDir: string
	identity: WorkbenchFederationDescriptorIdentity
	definition: Definition
	renderer: Renderer
}): Promise<string> {
	const extension = extname(input.renderer.entryPath) || '.tsx'
	const rendererPath = resolve(input.generatedDir, `${input.identity.key}.renderer${extension}`)
	const projectionPath = resolve(input.generatedDir, `${input.identity.key}.definition.ts`)
	const projectionGraph = await collectRendererProjectionGraph(
		input.renderer.entryPath,
		input.definition.binding.moduleId,
		input.definition,
		input.identity,
	)
	if (!projectionGraph) return input.renderer.entryPath
	const clonedPaths = new Map<string, string>()
	const clonedModules = [...projectionGraph.modules]
		.filter(([path]) => projectionGraph.clonePaths.has(path))
		.sort(([left], [right]) => left.localeCompare(right))
	let moduleIndex = 0
	for (const [path] of clonedModules) {
		clonedPaths.set(
			path,
			path === projectionGraph.rendererPath
				? rendererPath
				: resolve(
						input.generatedDir,
						`${input.identity.key}.renderer-module-${moduleIndex++}${extname(path) || '.ts'}`,
					),
		)
	}
	for (const [path, module] of clonedModules) {
		const clonePath = clonedPaths.get(path)!
		const replacements: Array<Readonly<{ start: number; end: number; value: string }>> = []
		for (const item of module.imports) {
			if (!item.target) continue
			let replacementTarget: string | undefined
			if (item.target === projectionGraph.definitionPath && !item.typeOnly) {
				replacementTarget = projectionPath
			} else {
				replacementTarget = clonedPaths.get(item.target)
				if (!replacementTarget && !isBareSpecifier(item.specifier)) {
					replacementTarget = item.target
				}
			}
			if (!replacementTarget) continue
			if (typeof item.start !== 'number' || typeof item.end !== 'number') {
				throw new TypeError(
					`[workbench-semantic] renderer import has no source range: ${module.path}`,
				)
			}
			replacements.push({
				start: item.start,
				end: item.end,
				value: JSON.stringify(relativeImport(clonePath, replacementTarget)),
			})
		}
		let projected = module.source
		for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
			projected = `${projected.slice(0, replacement.start)}${replacement.value}${projected.slice(replacement.end)}`
		}
		const previous = await readFile(clonePath, 'utf-8').catch((): undefined => undefined)
		if (previous !== projected) await writeFile(clonePath, projected, 'utf-8')
	}
	const rendererDeclaration = `workbench.entry(import.meta.url, ${JSON.stringify(`./${input.identity.key}.renderer${extension}`)})`
	// Keep the runtime graph browser-only while deriving the invariant API brands from the author's
	// exact descriptor. `typeof import(...)` exists only in TypeScript's type graph, so Vite never
	// executes the server definition module. Indexing the final definition also works when the entry
	// was produced through helper composition and preserves both Attachment API parameters without
	// trying to recover their source-level generic syntax.
	const sourceDefinitionImport = relativeImport(projectionPath, input.definition.binding.moduleId)
		.replace(/\.(?:tsx?|jsx)$/i, '.js')
		.replace(/\.mts$/i, '.mjs')
		.replace(/\.cts$/i, '.cjs')
	const sourceDescriptor = `(typeof import(${JSON.stringify(sourceDefinitionImport)}))[${JSON.stringify(input.definition.exportName)}][${JSON.stringify(input.identity.key)}]`
	const descriptor =
		input.identity.kind === 'view'
			? `workbench.view({ renderer: ProjectedRenderer, placement: workbench.tab({ label: ${JSON.stringify(input.identity.key)} }) }) as unknown as SourceDescriptor`
			: 'workbench.attachment({ renderer: ProjectedRenderer }) as unknown as SourceDescriptor'
	const projection = [
		'// Generated browser-only Workbench descriptor projection. Do not edit.',
		`import { workbench } from '@pluxel/runtime/workbench'`,
		`type SourceDescriptor = ${sourceDescriptor}`,
		`const ProjectedRenderer = ${rendererDeclaration}`,
		`export const ${input.definition.exportName} = workbench.define({`,
		`\t${JSON.stringify(input.identity.key)}: ${descriptor},`,
		'})',
		'',
	].join('\n')
	const previousProjection = await readFile(projectionPath, 'utf-8').catch(
		(): undefined => undefined,
	)
	if (previousProjection !== projection) await writeFile(projectionPath, projection, 'utf-8')
	return rendererPath
}

async function collectRendererProjectionGraph(
	rendererPath: string,
	definitionPath: string,
	definitionObject: Definition,
	identity: WorkbenchFederationDescriptorIdentity,
): Promise<
	| Readonly<{
			modules: ReadonlyMap<string, RendererGraphModule>
			clonePaths: ReadonlySet<string>
			rendererPath: string
			definitionPath: string
	  }>
	| undefined
> {
	const renderer = await realpath(resolve(rendererPath)).catch(() => resolve(rendererPath))
	const definitionFile = await realpath(resolve(definitionPath)).catch(() =>
		resolve(definitionPath),
	)
	const queue = [renderer]
	const modules = new Map<string, RendererGraphModule>()
	while (queue.length > 0) {
		const path = queue.shift()!
		if (modules.has(path)) continue
		const source = await readFile(path, 'utf-8').catch((cause) => {
			throw new Error(`[workbench-semantic] renderer dependency is unavailable: ${path}`, {
				cause,
			})
		})
		const ast = parseStandaloneWithLang(source, path)
		if (!ast) {
			throw new Error(`[workbench-semantic] cannot verify renderer dependency ${path}`)
		}
		const imports: RendererGraphImport[] = []
		for (const item of collectImportSpecifiers(ast)) {
			const typeOnly = isTypeOnlyRendererImport(ast, item)
			const hit = resolveImport(path, item.specifier)
			const target = hit
				? await realpath(resolve(hit.path)).catch(() => resolve(hit.path))
				: undefined
			imports.push(Object.freeze({ ...item, typeOnly, target }))
			if (
				!typeOnly &&
				target &&
				target !== definitionFile &&
				!isInstalledDependencyPath(target) &&
				['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts'].includes(extname(target))
			) {
				queue.push(target)
			}
		}
		modules.set(path, Object.freeze({ path, source, ast, imports: Object.freeze(imports) }))
	}

	const definitionImports: Array<
		Readonly<{ module: RendererGraphModule; item: RendererGraphImport }>
	> = []
	const rendererCalls: Array<Readonly<{ module: RendererGraphModule; call: Node }>> = []
	for (const module of modules.values()) {
		for (const item of module.imports) {
			if (item.typeOnly || item.target !== definitionFile) continue
			if (item.kind !== 'static') {
				throw new Error(
					`[workbench-semantic] renderer may reference its server definition only through a direct static import: ${rendererPath}`,
				)
			}
			definitionImports.push({ module, item })
		}
		for (const call of collectWorkbenchRendererCalls(module.ast)) {
			rendererCalls.push({ module, call })
		}
	}
	if (definitionImports.length === 0) {
		if (rendererCalls.length > 0) {
			throw new Error(
				`[workbench-semantic] createWorkbenchRenderer() must bind the exact directly imported descriptor for ${identity.key}: ${rendererPath}`,
			)
		}
		return undefined
	}
	if (definitionImports.length !== 1) {
		throw new Error(
			`[workbench-semantic] renderer graph must have exactly one direct server definition import: ${rendererPath}`,
		)
	}
	const boundary = definitionImports[0]!
	const statement = rendererImportStatement(boundary.module.ast, boundary.item)
	if (!statement) {
		throw new Error(
			`[workbench-semantic] cannot locate the direct server definition import: ${boundary.module.path}`,
		)
	}
	assertProjectionImport(statement, definitionObject, boundary.module.path)
	if (rendererCalls.length === 0) {
		if (boundary.module.path !== renderer) {
			throw new Error(
				`[workbench-semantic] renderer may reference its server definition only through a direct static import: ${rendererPath}`,
			)
		}
	} else {
		if (
			rendererCalls.length !== 1 ||
			rendererCalls[0]!.module.path !== boundary.module.path ||
			!isModuleConstInitializer(rendererCalls[0]!.module.ast, rendererCalls[0]!.call) ||
			!isExactWorkbenchRendererCall(
				rendererCalls[0]!.call,
				statement,
				definitionObject,
				identity.key,
			)
		) {
			throw new Error(
				`[workbench-semantic] renderer graph must contain one createWorkbenchRenderer() bound to ${definitionObject.exportName}.${identity.key}: ${rendererPath}`,
			)
		}
	}

	const importers = new Map<string, Set<string>>()
	for (const module of modules.values()) {
		for (const item of module.imports) {
			if (!item.target || !modules.has(item.target)) continue
			let paths = importers.get(item.target)
			if (!paths) {
				paths = new Set()
				importers.set(item.target, paths)
			}
			paths.add(module.path)
		}
	}
	const clonePaths = new Set([boundary.module.path])
	const importerQueue = [boundary.module.path]
	while (importerQueue.length > 0) {
		for (const importer of importers.get(importerQueue.shift()!) ?? []) {
			if (clonePaths.has(importer)) continue
			clonePaths.add(importer)
			importerQueue.push(importer)
		}
	}
	if (!clonePaths.has(renderer)) {
		throw new Error(
			`[workbench-semantic] renderer scope is not statically reachable from its entry: ${rendererPath}`,
		)
	}
	return Object.freeze({
		modules,
		clonePaths,
		rendererPath: renderer,
		definitionPath: definitionFile,
	})
}

function isModuleConstInitializer(ast: Program, call: Node): boolean {
	for (const statement of ast.body as unknown as Node[]) {
		const declaration = unwrapDeclaration(statement)
		if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue
		for (const declarator of nodes(declaration.declarations)) {
			const initializer = object(declarator.init)
			if (initializer && unwrapExpression(initializer) === call) return true
		}
	}
	return false
}

function collectWorkbenchRendererCalls(ast: Program): Node[] {
	const factories = new Set<string>()
	const namespaces = new Set<string>()
	for (const statement of ast.body as unknown as Node[]) {
		if (
			statement.type !== 'ImportDeclaration' ||
			!WORKBENCH_REACT_IMPORTS.has(literalString(statement.source) ?? '') ||
			statement.importKind === 'type'
		) {
			continue
		}
		for (const specifier of nodes(statement.specifiers)) {
			if (
				specifier.type === 'ImportSpecifier' &&
				specifier.importKind !== 'type' &&
				propertyName(specifier.imported) === 'createWorkbenchRenderer'
			) {
				const local = identifierName(specifier.local)
				if (local) factories.add(local)
			}
			if (specifier.type === 'ImportNamespaceSpecifier') {
				const local = identifierName(specifier.local)
				if (local) namespaces.add(local)
			}
		}
	}
	const calls: Node[] = []
	if (factories.size === 0 && namespaces.size === 0) return calls
	walk(ast, (node) => {
		if (node.type !== 'CallExpression') return
		const callee = unwrapExpression(object(node.callee) ?? {})
		if (callee.type === 'Identifier' && factories.has(String(callee.name))) {
			calls.push(node)
			return
		}
		if (callee.type === 'MemberExpression' && memberName(callee) === 'createWorkbenchRenderer') {
			const owner = unwrapExpression(object(callee.object) ?? {})
			if (owner.type === 'Identifier' && namespaces.has(String(owner.name))) calls.push(node)
		}
	})
	return calls
}

function isTypeOnlyRendererImport(
	ast: Program,
	item: Readonly<{ kind: 'static' | 'dynamic'; start?: number; end?: number }>,
): boolean {
	if (item.kind === 'dynamic') return false
	const statement = rendererImportStatement(ast, item)
	if (!statement) return false
	if (statement.importKind === 'type' || statement.exportKind === 'type') return true
	const specifiers = nodes(statement.specifiers)
	return (
		specifiers.length > 0 &&
		specifiers.every(
			(specifier) => specifier.importKind === 'type' || specifier.exportKind === 'type',
		)
	)
}

function rendererImportStatement(
	ast: Program,
	item: Readonly<{ start?: number; end?: number }>,
): Node | undefined {
	return (ast.body as unknown as Node[]).find((statement) => {
		if (
			statement.type !== 'ImportDeclaration' &&
			statement.type !== 'ExportNamedDeclaration' &&
			statement.type !== 'ExportAllDeclaration'
		) {
			return false
		}
		const source = object(statement.source)
		return source?.start === item.start && source.end === item.end
	})
}

function isExactWorkbenchRendererCall(
	call: Node,
	definitionImport: Node,
	definition: Definition,
	entryKey: string,
): boolean {
	const args = nodes(call.arguments)
	if (args.length !== 1) return false
	const descriptor = unwrapExpression(args[0]!)
	if (descriptor.type !== 'MemberExpression' || memberName(descriptor) !== entryKey) return false
	const owner = unwrapExpression(object(descriptor.object) ?? {})
	if (owner.type !== 'Identifier' || typeof owner.name !== 'string') return false
	const specifier = nodes(definitionImport.specifiers)[0]
	return (
		specifier?.type === 'ImportSpecifier' &&
		propertyName(specifier.imported) === definition.exportName &&
		identifierName(specifier.local) === owner.name
	)
}

function assertProjectionImport(
	statement: Node,
	definition: Definition,
	rendererPath: string,
): void {
	if (statement.type !== 'ImportDeclaration') {
		throw new Error(
			`[workbench-semantic] renderer must import ${definition.exportName} directly instead of re-exporting its server definition: ${rendererPath}`,
		)
	}
	const specifiers = nodes(statement.specifiers)
	if (
		statement.importKind === 'type' ||
		specifiers.length !== 1 ||
		specifiers[0]?.type !== 'ImportSpecifier' ||
		specifiers[0]?.importKind === 'type' ||
		propertyName(specifiers[0]!.imported) !== definition.exportName
	) {
		throw new Error(
			`[workbench-semantic] renderer import from its server definition must contain only ${definition.exportName}: ${rendererPath}`,
		)
	}
}

async function buildRevisionFor(
	root: string,
	compatibilityRoot: string,
	owner: PluginDefinitionAddress,
	definition: Definition,
	entries: readonly Readonly<{
		descriptor: WorkbenchFederationDescriptorIdentity
		bridgeEntryPath: string
		renderer: Renderer
	}>[],
): Promise<string> {
	const hash = createHash('sha256')
	hash.update(`workbench-semantic-abi:${GENERATED_ABI_VERSION}\n`)
	hash.update(`workbench-build-revision:${BUILD_REVISION_VERSION}\n`)
	hash.update(`compat:${resolveWorkbenchFederationShared(compatibilityRoot).signature}\n`)
	hash.update(`owner:${JSON.stringify(owner)}\n`)
	hash.update(
		`definition:${relative(root, definition.binding.moduleId)}#${definition.exportName}\n`,
	)
	for (const entry of entries) {
		hash.update(`entry:${JSON.stringify(entry.descriptor)}:${entry.bridgeEntryPath}\n`)
	}
	const roots = [
		...new Set([definition.binding.moduleId, ...entries.map((entry) => entry.renderer.entryPath)]),
	].sort()
	await hashSourceGraph(hash, root, roots)
	return hash.digest('hex').slice(0, 24)
}

async function hashSourceGraph(
	hash: ReturnType<typeof createHash>,
	root: string,
	entryPaths: readonly string[],
): Promise<void> {
	const queue = [...entryPaths]
	const visited = new Set<string>()
	const packageMetadata = new Map<string, PackageFingerprint>()
	const packageDirectories = new Map<string, string | null>()
	const dependencyQueue: PackageFingerprint[] = []
	const expandedDependencies = new Set<string>()
	const rootPackageJson = resolve(root, 'package.json')
	if (existsSync(rootPackageJson)) await readPackageFingerprint(rootPackageJson, packageMetadata)
	while (queue.length > 0 || dependencyQueue.length > 0) {
		if (queue.length === 0) {
			const dependencyPackage = dependencyQueue.shift()!
			if (expandedDependencies.has(dependencyPackage.path)) continue
			expandedDependencies.add(dependencyPackage.path)
			for (const dependency of dependencyPackage.dependencies) {
				const hit = resolveImport(resolve(dependencyPackage.root, 'package.json'), dependency)
				const childPackageJson =
					hit?.packageJsonPath ??
					resolvePackageJsonPathWithOxc(
						dependencyPackage.root,
						dependency,
						SOURCE_RESOLVE_OPTIONS,
					) ??
					findInstalledPackageJson(dependencyPackage.root, dependency)
				if (!childPackageJson) continue
				const childPackage = await readPackageFingerprint(childPackageJson, packageMetadata)
				if (!hit) {
					dependencyPackage.resolutions.add(`${dependency}->${childPackage.identity}`)
					if (!FIXED_SHARED_PACKAGES.has(childPackage.name)) dependencyQueue.push(childPackage)
					continue
				}
				const resolvedPath = await realpath(hit.path).catch(() => resolve(hit.path))
				dependencyPackage.resolutions.add(
					`${dependency}->${childPackage.identity}:${normalizePackagePath(childPackage.root, resolvedPath)}`,
				)
				if (isInstalledDependencyPath(hit.path)) {
					if (!FIXED_SHARED_PACKAGES.has(childPackage.name)) dependencyQueue.push(childPackage)
				} else if (existsSync(hit.path)) {
					queue.push(hit.path)
				}
			}
			continue
		}
		const requestedFile = resolve(queue.shift()!)
		const file = await realpath(requestedFile).catch(() => requestedFile)
		if (visited.has(file)) continue
		visited.add(file)
		const content = await readFile(file, 'utf-8').catch((cause) => {
			throw new Error(`[workbench-semantic] renderer source is unavailable: ${file}`, { cause })
		})
		const sourcePackageJson = findContainingPackageJson(file, packageDirectories)
		const sourcePackage = sourcePackageJson
			? await readPackageFingerprint(sourcePackageJson, packageMetadata)
			: undefined
		hash.update(`file:${normalizeGraphPath(root, file, content, sourcePackage)}\n`)
		hash.update(content)
		for (const specifier of sourceImports(file, content)) {
			const hit = resolveImport(file, specifier)
			if (!hit) continue
			let dependencyPackage: PackageFingerprint | undefined
			if (hit.packageJsonPath) {
				dependencyPackage = await readPackageFingerprint(hit.packageJsonPath, packageMetadata)
				const resolvedPath = await realpath(hit.path).catch(() => resolve(hit.path))
				dependencyPackage.resolutions.add(
					`${specifier}->${normalizePackagePath(dependencyPackage.root, resolvedPath)}`,
				)
			}
			if (!existsSync(hit.path)) continue
			if (!isBareSpecifier(specifier) || !isInstalledDependencyPath(hit.path)) {
				queue.push(hit.path)
			} else if (dependencyPackage && !FIXED_SHARED_PACKAGES.has(dependencyPackage.name)) {
				dependencyQueue.push(dependencyPackage)
			}
		}
	}
	const packageRecords = [...packageMetadata.values()]
		.map((item) => ({
			item,
			sortKey: `${item.identity}\0${item.metadata}\0${[...item.resolutions].sort().join('\0')}`,
		}))
		.sort((left, right) => left.sortKey.localeCompare(right.sortKey))
	for (const { item } of packageRecords) {
		const resolutions = [...item.resolutions].sort()
		hash.update(
			`package:${JSON.stringify({ identity: item.identity, metadata: item.metadata, resolutions })}\n`,
		)
	}
}

type PackageFingerprint = {
	path: string
	root: string
	name: string
	identity: string
	metadata: string
	dependencies: readonly string[]
	resolutions: Set<string>
}

async function readPackageFingerprint(
	packageJsonPath: string,
	packages: Map<string, PackageFingerprint>,
): Promise<PackageFingerprint> {
	const canonicalPath = await realpath(packageJsonPath).catch(() => resolve(packageJsonPath))
	const cached = packages.get(canonicalPath)
	if (cached) return cached
	const manifest = await readFile(canonicalPath, 'utf-8').catch(() => '')
	let name = '<anonymous>'
	let version = '<workspace>'
	let dependencies: readonly string[] = []
	let metadata = '{}'
	try {
		const parsed = JSON.parse(manifest) as Record<string, unknown>
		if (typeof parsed.name === 'string' && parsed.name.length > 0) name = parsed.name
		if (typeof parsed.version === 'string' && parsed.version.length > 0) version = parsed.version
		dependencies = [
			...new Set([
				...recordKeys(parsed.dependencies),
				...recordKeys(parsed.optionalDependencies),
				...recordKeys(parsed.peerDependencies),
			]),
		].sort()
		metadata = canonicalPackageMetadata(parsed)
	} catch {
		// The builder owns invalid package metadata diagnostics; keep fingerprinting deterministic.
	}
	const fingerprint: PackageFingerprint = {
		path: canonicalPath,
		root: dirname(canonicalPath),
		name,
		identity: `${name}@${version}`,
		metadata,
		dependencies,
		resolutions: new Set(),
	}
	packages.set(canonicalPath, fingerprint)
	return fingerprint
}

function recordKeys(value: unknown): string[] {
	return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
}

function findContainingPackageJson(file: string, cache: Map<string, string | null>): string | null {
	let current = dirname(file)
	const searched: string[] = []
	for (;;) {
		if (cache.has(current)) {
			const cached = cache.get(current) ?? null
			for (const directory of searched) cache.set(directory, cached)
			return cached
		}
		searched.push(current)
		const packageJson = resolve(current, 'package.json')
		if (existsSync(packageJson)) {
			for (const directory of searched) cache.set(directory, packageJson)
			return packageJson
		}
		const parent = dirname(current)
		if (parent === current) {
			for (const directory of searched) cache.set(directory, null)
			return null
		}
		current = parent
	}
}

function findInstalledPackageJson(start: string, packageName: string): string | null {
	let current = resolve(start)
	for (;;) {
		const packageJson = resolve(current, 'node_modules', packageName, 'package.json')
		if (existsSync(packageJson)) return packageJson
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

function canonicalPackageMetadata(manifest: Record<string, unknown>): string {
	const fields = [
		'name',
		'version',
		'type',
		'exports',
		'imports',
		'main',
		'module',
		'browser',
		'sideEffects',
		'dependencies',
		'optionalDependencies',
		'peerDependencies',
	] as const
	return JSON.stringify(
		Object.fromEntries(
			fields
				.filter((field) => Object.hasOwn(manifest, field))
				.map((field) => [
					field,
					field === 'exports'
						? canonicalPackageExports(manifest[field])
						: canonicalJsonValue(manifest[field]),
				]),
		),
	)
}

function canonicalPackageExports(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return canonicalJsonValue(value)
	}
	return canonicalJsonValue(
		Object.fromEntries(
			Object.entries(value as Record<string, unknown>).filter(([key]) => key !== './package.json'),
		),
	)
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalJsonValue(item)]),
		)
	}
	return value
}

function sourceImports(file: string, content: string): string[] {
	if (['.css', '.scss', '.sass', '.less'].includes(extname(file))) {
		return [
			...[...content.matchAll(/@(?:import|use|forward)\s+(?:url\()?['"]([^'"]+)['"]/g)].map(
				(match) => match[1]!,
			),
			...[...content.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)].map((match) => match[1]!),
		].filter((specifier) => !specifier.startsWith('#') && !specifier.startsWith('data:'))
	}
	const ast = parseStandaloneWithLang(content, file)
	return ast ? collectImportSpecifiers(ast).map((item) => item.specifier) : []
}

function resolveImport(
	importer: string,
	specifier: string,
): { path: string; packageJsonPath?: string } | null {
	if (/^(?:https?:|data:|node:)/.test(specifier)) return null
	const hit = resolveWithOxc(dirname(importer), specifier, SOURCE_RESOLVE_OPTIONS)
	return hit ? { path: hit.path, packageJsonPath: hit.packageJsonPath } : null
}

function resolveSource(importer: string, source: string): string | undefined {
	return resolveImport(importer, source)?.path
}

function isBareSpecifier(source: string): boolean {
	return !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
}

function packageNameFromSpecifier(specifier: string): string {
	const parts = specifier.split('/')
	return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]!
}

function relativeImport(importer: string, target: string): string {
	let path = relative(dirname(importer), target).replaceAll('\\', '/')
	if (!path.startsWith('.')) path = `./${path}`
	return path
}

function normalizeRelativePath(input: string, label: string): string {
	const value = input.replaceAll('\\', '/')
	if (isAbsolute(value) || !value || value.split('/').some((part) => part === '..')) {
		throw new Error(`[workbench-semantic] ${label} must remain inside the build root`)
	}
	return value.replace(/^\.\//, '')
}

function normalizeGraphPath(
	root: string,
	file: string,
	content: string,
	sourcePackage: PackageFingerprint | undefined,
): string {
	const path = relative(root, file).replaceAll('\\', '/')
	if (!path.startsWith('../') && path !== '..') return path
	if (sourcePackage) {
		return `package-source:${sourcePackage.identity}:${normalizePackagePath(sourcePackage.root, file)}`
	}
	return `external-source:${extname(file)}:${createHash('sha256').update(content).digest('hex')}`
}

function normalizePackagePath(packageRoot: string, file: string): string {
	return relative(packageRoot, file).replaceAll('\\', '/') || '.'
}

function isInstalledDependencyPath(file: string): boolean {
	return file.replaceAll('\\', '/').split('/').includes('node_modules')
}

function isImportMetaUrl(node: Node): boolean {
	const value = unwrapExpression(node)
	return (
		value.type === 'MemberExpression' &&
		memberName(value) === 'url' &&
		object(value.object)?.type === 'MetaProperty'
	)
}

function isDescriptor(value: SemanticValue): value is Descriptor {
	return (
		Boolean(value) &&
		typeof value === 'object' &&
		'kind' in value &&
		(value.kind === 'view' ||
			value.kind === 'attachment' ||
			value.kind === 'content' ||
			value.kind === 'attachment-placement')
	)
}

function isRenderer(value: SemanticValue | undefined): value is Renderer {
	return Boolean(
		value &&
		typeof value === 'object' &&
		'moduleId' in value &&
		'entryPath' in value &&
		typeof value.moduleId === 'string' &&
		typeof value.entryPath === 'string',
	)
}

function isMarkdownDocument(value: SemanticValue | undefined): value is MarkdownDocument {
	return Boolean(
		value &&
		typeof value === 'object' &&
		'kind' in value &&
		value.kind === 'markdown-document' &&
		'sourcePath' in value &&
		typeof value.sourcePath === 'string',
	)
}

function isPlacement(value: SemanticValue | undefined): value is Placement {
	return Boolean(
		value && typeof value === 'object' && 'kind' in value && value.kind === 'placement',
	)
}

function isDefinition(value: SemanticValue): value is Definition {
	return Boolean(
		value &&
		typeof value === 'object' &&
		'binding' in value &&
		'entries' in value &&
		value.entries instanceof Map,
	)
}

function isDefinedEntry(value: SemanticValue): value is DefinedEntry {
	return Boolean(
		value &&
		typeof value === 'object' &&
		'definition' in value &&
		'descriptor' in value &&
		'key' in value,
	)
}

function isFunctionValue(value: SemanticValue): value is FunctionValue {
	return Boolean(
		value &&
		typeof value === 'object' &&
		'moduleId' in value &&
		'node' in value &&
		typeof value.moduleId === 'string',
	)
}

function isPrimitive(value: SemanticValue): value is string | number | boolean | null {
	return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function assertEntryKey(id: string, key: string): void {
	if (!ENTRY_KEY.test(key) || RESERVED_ENTRY_KEYS.has(key)) {
		throw semanticError(id, `invalid Workbench entry key ${JSON.stringify(key)}`)
	}
}

function declarationName(node: Node): string | undefined {
	const declaration = object(node.declaration) ?? node
	if (!declaration) return undefined
	if (declaration.type === 'VariableDeclaration') {
		const declarations = nodes(declaration.declarations)
		return declarations.length === 1
			? (identifierName(declarations[0]?.id) ?? undefined)
			: undefined
	}
	return identifierName(declaration.id) ?? undefined
}

function unwrapDeclaration(statement: Node): Node | undefined {
	return statement.type === 'ExportNamedDeclaration' ||
		statement.type === 'ExportDefaultDeclaration'
		? (object(statement.declaration) ?? undefined)
		: statement
}

function unwrapExpression(input: Node): Node {
	let value = input
	while (
		value.type === 'TSAsExpression' ||
		value.type === 'TSSatisfiesExpression' ||
		value.type === 'TSNonNullExpression' ||
		value.type === 'ChainExpression' ||
		value.type === 'ParenthesizedExpression'
	) {
		value = object(value.expression) ?? value
	}
	return value
}

function memberName(node: Node): string | undefined {
	if (node.computed === true) return literalString(node.property) ?? undefined
	return identifierName(node.property) ?? undefined
}

function propertyName(input: unknown): string | undefined {
	return identifierName(input) ?? literalString(input) ?? undefined
}

function identifierName(input: unknown): string | null {
	const node = object(input)
	return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : null
}

function literalString(input: unknown): string | null {
	const node = object(input)
	return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null
}

function nodes(input: unknown): Node[] {
	return Array.isArray(input)
		? input.map(object).filter((value): value is Node => Boolean(value))
		: []
}

function object(input: unknown): Node | null {
	return input && typeof input === 'object' ? (input as Node) : null
}

function walk(input: unknown, visit: (node: Node) => void): void {
	if (!input || typeof input !== 'object') return
	if (Array.isArray(input)) {
		for (const value of input) walk(value, visit)
		return
	}
	const node = input as Node
	if (typeof node.type === 'string') visit(node)
	for (const [key, value] of Object.entries(node)) {
		if (['type', 'start', 'end', 'loc', 'range', 'comments'].includes(key)) continue
		if (value && typeof value === 'object') walk(value, visit)
	}
}

function stripQuery(id: string): string {
	return id.replace(/[?#].*$/, '')
}

function semanticError(id: string, message: string): Error {
	return new Error(`[workbench-semantic] ${id}: ${message}`)
}

function isMissingExportError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes('definition export') &&
		error.message.includes('is missing')
	)
}
