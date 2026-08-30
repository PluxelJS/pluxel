import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
	createWorkbenchFederationProducerPlan,
	workbenchFederationProducerName,
	type WorkbenchFederationDescriptorIdentity,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import type { Program } from 'oxc-parser'
import { dirname, extname, isAbsolute, relative, resolve } from 'pathe'
import { resolveWithOxc } from '../resolver/oxc.ts'
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
}>

type BindingRef = Readonly<{
	moduleId: string
	localName: string
}>

type Renderer = Readonly<{
	moduleId: string
	entryPath: string
}>

type Descriptor =
	| Readonly<{ kind: 'view'; renderer: Renderer }>
	| Readonly<{ kind: 'attachment'; renderer: Renderer }>
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
	| RecordValue
	| WorkbenchNamespace

type WorkbenchNamespace = Readonly<{ kind: 'workbench-namespace' }>

type EvaluationEnvironment = ReadonlyMap<string, SemanticValue>

const WORKBENCH_NAMESPACE: WorkbenchNamespace = Object.freeze({
	kind: 'workbench-namespace',
})
const WORKBENCH_IMPORTS = new Set(['@pluxel/runtime/workbench'])
const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/
const RESERVED_ENTRY_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'then'])
const GENERATED_ABI_VERSION = 1

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

export type WorkbenchSemanticLowering = Readonly<{
	reset(): void
	invalidate(): void
	collect(input: WorkbenchSemanticModuleInput): Promise<void>
	plans(): Promise<readonly WorkbenchFederationProducerPlan[]>
	compilations(): Promise<readonly WorkbenchSemanticProducerCompilation[]>
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
	let finalized: Promise<readonly WorkbenchSemanticProducerCompilation[]> | undefined

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
			if (args.length !== 2) {
				throw semanticError(id, `${className} publish() must receive definition and bindings`)
			}
			const key = pluginDefinitionIndexKey(owner.definition)
			if (nextPublications.has(key)) {
				throw semanticError(id, `${className} has duplicate Workbench publication ownership`)
			}
			nextPublications.set(key, {
				owner,
				moduleId: id,
				definitionExpression: args[0]!,
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
		return finalized
	}
	const plans = async (): Promise<readonly WorkbenchFederationProducerPlan[]> => {
		const currentCompilations = await compilations()
		return Object.freeze(currentCompilations.map((compilation) => compilation.plan))
	}

	const finalizePlans = async (): Promise<readonly WorkbenchSemanticProducerCompilation[]> => {
		const lowered: WorkbenchSemanticProducerCompilation[] = []
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
			const buildRoot = resolveProducerBuildRoot(sourceRoot, publication.moduleId)
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
			lowered.push(Object.freeze({ plan, root: buildRoot }))
		}
		return Object.freeze(lowered)
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
					case 'tab':
					case 'route':
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

	return Object.freeze({ reset, invalidate, collect, plans, compilations })
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
		.update(`${input.definition.binding.moduleId}#${input.definition.exportName}\n`)
		.update(`${input.renderer.entryPath}\n`)
		.digest('hex')
		.slice(0, 16)
	const generatedDir = resolve(
		input.root,
		'.pluxel/workbench-generated',
		input.producer,
		entryRevision,
	)
	const bridgePath = resolve(generatedDir, `${input.identity.key}.tsx`)
	const definitionImport = relativeImport(bridgePath, input.definition.binding.moduleId)
	const rendererImport = relativeImport(bridgePath, input.renderer.entryPath)
	const source = [
		'// Generated by @pluxel/rolldown. Do not edit.',
		`import { createWorkbenchBridge } from '@pluxel/runtime/internal/workbench-react'`,
		`import { ${input.definition.exportName} as Definition } from ${JSON.stringify(definitionImport)}`,
		`import Renderer from ${JSON.stringify(rendererImport)}`,
		'',
		`export default createWorkbenchBridge(${JSON.stringify(input.identity)}, Definition.${input.identity.key}, Renderer)`,
		'',
	].join('\n')
	await mkdir(generatedDir, { recursive: true })
	const previous = await readFile(bridgePath, 'utf-8').catch((): undefined => undefined)
	if (previous !== source) await writeFile(bridgePath, source, 'utf-8')
	return normalizeRelativePath(relative(input.root, bridgePath), 'generated Bridge entry')
}

async function buildRevisionFor(
	root: string,
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
	hash.update(`compat:${resolveWorkbenchFederationShared(root).signature}\n`)
	hash.update(`owner:${JSON.stringify(owner)}\n`)
	hash.update(
		`definition:${relative(root, definition.binding.moduleId)}#${definition.exportName}\n`,
	)
	for (const entry of entries) {
		hash.update(`entry:${JSON.stringify(entry.descriptor)}:${entry.bridgeEntryPath}\n`)
	}
	await hashDependencyState(hash, root)
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
	const packageMetadata = new Set<string>()
	while (queue.length > 0) {
		const file = resolve(queue.shift()!)
		if (visited.has(file)) continue
		visited.add(file)
		const content = await readFile(file, 'utf-8').catch((cause) => {
			throw new Error(`[workbench-semantic] renderer source is unavailable: ${file}`, { cause })
		})
		hash.update(`file:${normalizeGraphPath(root, file)}\n`)
		hash.update(content)
		for (const specifier of sourceImports(file, content)) {
			const hit = resolveImport(file, specifier)
			if (!hit) continue
			if (isBareSpecifier(specifier)) {
				if (hit.packageJsonPath) packageMetadata.add(hit.packageJsonPath)
				continue
			}
			if (existsSync(hit.path)) queue.push(hit.path)
		}
	}
	for (const packageJson of [...packageMetadata].sort()) {
		hash.update(`package:${packageJson}\n`)
		hash.update(await readFile(packageJson, 'utf-8').catch(() => ''))
	}
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
	const hit = resolveWithOxc(dirname(importer), specifier, {
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
		tsconfig: 'auto',
	})
	return hit ? { path: hit.path, packageJsonPath: hit.packageJsonPath } : null
}

function resolveSource(importer: string, source: string): string | undefined {
	return resolveImport(importer, source)?.path
}

function isBareSpecifier(source: string): boolean {
	return !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
}

async function hashDependencyState(
	hash: ReturnType<typeof createHash>,
	root: string,
): Promise<void> {
	for (const file of findDependencyStateFiles(root)) {
		hash.update(`dependency-state:${file}\n`)
		hash.update(await readFile(file))
	}
}

function findDependencyStateFiles(start: string): string[] {
	const names = [
		'pnpm-lock.yaml',
		'pnpm-workspace.yaml',
		'package-lock.json',
		'yarn.lock',
		'bun.lock',
		'bun.lockb',
	]
	let current = resolve(start)
	for (let depth = 0; depth < 12; depth += 1) {
		const files = names.map((name) => resolve(current, name)).filter((file) => existsSync(file))
		if (files.length > 0) return files.sort()
		const parent = resolve(current, '..')
		if (parent === current) break
		current = parent
	}
	return []
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

function normalizeGraphPath(root: string, file: string): string {
	const path = relative(root, file).replaceAll('\\', '/')
	return path.startsWith('../') ? `external:${file.replaceAll('\\', '/')}` : path
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
		(value.kind === 'view' || value.kind === 'attachment' || value.kind === 'attachment-placement')
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
