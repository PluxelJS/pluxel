import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isStandardSchemaV1 } from '../../services/config/standardSchema'
import type { PluginConstructor, PluginIdentifier } from '../types'
import {
	parsePluginNodeAddress,
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from './identity'
import { getForkId } from './fork-identity'
import {
	clonePluginPartOwnerFacts,
	getPluginPartConfig,
	getPluginPartFactsRevision,
	getPluginPartOccurrences,
	getPluginPartOptional,
	type PartConfigDeclaration,
} from './part-definition'

export type PluginDefinitionKind = 'plugin' | 'abstract'

export type PluginDefinitionFacts = Readonly<{
	readonly kind: PluginDefinitionKind
	readonly definition: PluginDefinitionAddress
	/** Ordered by constructor parameter index. */
	readonly requires: readonly PluginDefinitionAddress[]
	/** Static optional restart edges declared by direct init-time plugins.use() calls. */
	readonly optional: readonly PluginDefinitionAddress[]
	/** Explicit abstract provider relation from @Plugin(AbstractToken). */
	readonly provides?: PluginDefinitionAddress
}>

export type PluginConfigDefinition = Readonly<{
	readonly fieldName: string
	readonly schema: StandardSchemaV1
	readonly source?: string
	readonly owner?: PartConfigDeclaration
	readonly parts: readonly Readonly<{
		readonly path: readonly string[]
		readonly declaration?: PartConfigDeclaration
	}>[]
}>

const factsByConstructor = new WeakMap<PluginIdentifier, PluginDefinitionFacts>()
const configByConstructor = new WeakMap<PluginConstructor, PartConfigDeclaration>()
const definitionFactsCache = new WeakMap<
	PluginIdentifier,
	{ revision: number; facts: PluginDefinitionFacts }
>()
const configDefinitionCache = new WeakMap<
	PluginConstructor,
	{ revision: number; definition?: PluginConfigDefinition }
>()

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new TypeError(
			`[pluxel/core] ${label} must be a non-empty string without surrounding whitespace`,
		)
	}
	return value
}

function normalizeAddresses(
	input: readonly PluginDefinitionAddress[] | undefined,
	label: string,
): readonly PluginDefinitionAddress[] {
	if (input === undefined) return Object.freeze([])
	if (!Array.isArray(input)) throw new TypeError(`[pluxel/core] ${label} must be an array`)
	return Object.freeze(input.map((address) => parsePluginDefinitionAddress(address)))
}

function assertUniqueAddresses(addresses: readonly PluginDefinitionAddress[], label: string): void {
	const seen = new Set<string>()
	for (let index = 0; index < addresses.length; index++) {
		const key = pluginDefinitionIndexKey(addresses[index]!)
		if (seen.has(key)) {
			throw new TypeError(
				`[pluxel/core] ${label} contains a duplicate definition at index ${index}`,
			)
		}
		seen.add(key)
	}
}

export function __setPluginDefinition(
	ctor: PluginIdentifier,
	input: {
		readonly kind: PluginDefinitionKind
		readonly definition: PluginDefinitionAddress
		readonly requires?: readonly PluginDefinitionAddress[]
		readonly optional?: readonly PluginDefinitionAddress[]
		readonly provides?: PluginDefinitionAddress
	},
): void {
	if (typeof ctor !== 'function')
		throw new TypeError('[pluxel/core] Plugin definition target must be a constructor')
	if (input.kind !== 'plugin' && input.kind !== 'abstract') {
		throw new TypeError('[pluxel/core] Plugin definition kind must be plugin or abstract')
	}
	const requires = normalizeAddresses(input.requires, 'Plugin required definition facts')
	assertUniqueAddresses(requires, 'Plugin required definition facts')
	const facts: PluginDefinitionFacts = Object.freeze({
		kind: input.kind,
		definition: parsePluginDefinitionAddress(input.definition),
		requires,
		optional: normalizeAddresses(input.optional, 'Plugin optional definition facts'),
		...(input.provides === undefined
			? {}
			: { provides: parsePluginDefinitionAddress(input.provides) }),
	})
	if (
		facts.kind === 'abstract' &&
		(facts.requires.length > 0 || facts.optional.length > 0 || facts.provides)
	) {
		throw new TypeError('[pluxel/core] Abstract Plugin definition facts cannot declare edges')
	}
	const previous = factsByConstructor.get(ctor)
	if (previous && previous !== facts) {
		throw new Error('[pluxel/core] Plugin constructor already has definition facts')
	}
	factsByConstructor.set(ctor, facts)
}

export function getPluginDefinitionFacts(ctor: PluginIdentifier): PluginDefinitionFacts {
	const direct = factsByConstructor.get(ctor)
	if (!direct) {
		const name = (ctor as { readonly name?: string }).name || '<anonymous>'
		throw new Error(
			`[pluxel/core] Plugin definition was not lowered for ${name}. Load Plugin source through the Pluxel Vite/Rolldown semantic pass.`,
		)
	}
	if (direct.kind === 'abstract') return direct
	const revision = getPluginPartFactsRevision()
	const cached = definitionFactsCache.get(ctor)
	if (cached?.revision === revision) return cached.facts
	const optional = mergeOptionalDefinitions(direct.optional, collectPartOptional(ctor))
	const facts =
		optional.length === direct.optional.length &&
		optional.every((address, index) => address === direct.optional[index])
			? direct
			: Object.freeze({ ...direct, optional: Object.freeze(optional) })
	definitionFactsCache.set(ctor, { revision, facts })
	return facts
}

export function hasPluginDefinitionFacts(ctor: PluginIdentifier): boolean {
	return factsByConstructor.has(ctor)
}

/** Host/route projection from a lowered implementation generation to its durable node address. */
export function pluginNodeAddressOf(ctor: PluginConstructor): PluginNodeAddress {
	const definition = getPluginDefinitionFacts(ctor).definition
	const forkId = getForkId(ctor)
	return parsePluginNodeAddress(
		forkId ? { definition, variant: 'fork', forkId } : { definition, variant: 'default' },
	)
}

export function clonePluginDefinitionFacts(from: PluginIdentifier, to: PluginIdentifier): void {
	const facts = factsByConstructor.get(from)
	if (!facts) throw new Error('[pluxel/core] Cannot clone missing Plugin definition facts')
	factsByConstructor.set(to, facts)
	const config = configByConstructor.get(from as PluginConstructor)
	if (config) configByConstructor.set(to as PluginConstructor, config)
	clonePluginPartOwnerFacts(from, to)
}

export function __setPluginConfig(
	ctor: PluginConstructor,
	input: {
		readonly fieldName: string
		readonly schema: StandardSchemaV1
		readonly source?: string
	},
): void {
	if (typeof ctor !== 'function')
		throw new TypeError('[pluxel/core] Plugin config target must be a constructor')
	const fieldName = nonEmpty(input.fieldName, 'Plugin config field name')
	if (!isStandardSchemaV1(input.schema)) {
		throw new TypeError('[pluxel/core] Plugin config must implement Standard Schema v1')
	}
	if (configByConstructor.has(ctor)) {
		throw new Error('[pluxel/core] A Plugin may declare exactly one object config schema')
	}
	configByConstructor.set(
		ctor,
		Object.freeze({
			fieldName,
			schema: input.schema,
			...(input.source === undefined ? {} : { source: String(input.source) }),
		}),
	)
	configDefinitionCache.delete(ctor)
}

export function getPluginConfigDefinition(
	ctor: PluginConstructor,
): PluginConfigDefinition | undefined {
	const revision = getPluginPartFactsRevision()
	const cached = configDefinitionCache.get(ctor)
	if (cached?.revision === revision) return cached.definition
	const root = buildConfigNode(ctor, [], configByConstructor.get(ctor), new Set([ctor]))
	const definition = root ? createConfigDefinition(root) : undefined
	configDefinitionCache.set(ctor, { revision, definition })
	return definition
}

type ConfigNode = Readonly<{
	readonly path: readonly string[]
	readonly own?: PartConfigDeclaration
	readonly children: readonly Readonly<{ readonly key: string; readonly node: ConfigNode }>[]
}>

function definitionAddressKey(address: PluginDefinitionAddress): string {
	return pluginDefinitionIndexKey(address)
}

function mergeOptionalDefinitions(
	direct: readonly PluginDefinitionAddress[],
	parts: readonly PluginDefinitionAddress[],
): PluginDefinitionAddress[] {
	const out: PluginDefinitionAddress[] = []
	const seen = new Set<string>()
	for (const address of [...direct, ...parts]) {
		const key = definitionAddressKey(address)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(address)
	}
	return out
}

function collectPartOptional(owner: Function): PluginDefinitionAddress[] {
	const out: PluginDefinitionAddress[] = []
	const visit = (current: Function, ancestry: Set<Function>) => {
		for (const occurrence of getPluginPartOccurrences(current)) {
			if (ancestry.has(occurrence.Part)) {
				throw new Error(
					`[pluxel/core] PluginPart containment cycle through ${occurrence.fieldName}`,
				)
			}
			out.push(...getPluginPartOptional(occurrence.Part))
			const next = new Set([...ancestry, occurrence.Part])
			visit(occurrence.Part, next)
		}
	}
	visit(owner, new Set([owner]))
	return out
}

function buildConfigNode(
	owner: Function,
	path: readonly string[],
	own: PartConfigDeclaration | undefined,
	ancestry: Set<Function>,
): ConfigNode | undefined {
	const children: Array<{ key: string; node: ConfigNode }> = []
	for (const occurrence of getPluginPartOccurrences(owner)) {
		if (ancestry.has(occurrence.Part)) {
			throw new Error(
				`[pluxel/core] PluginPart containment cycle at ${[...path, occurrence.fieldName].join('.')}`,
			)
		}
		const nextAncestry = new Set([...ancestry, occurrence.Part])
		const child = buildConfigNode(
			occurrence.Part,
			Object.freeze([...path, occurrence.fieldName]),
			getPluginPartConfig(occurrence.Part),
			nextAncestry,
		)
		if (child) children.push({ key: occurrence.fieldName, node: child })
	}
	if (!own && children.length === 0) return undefined
	return Object.freeze({
		path: Object.freeze([...path]),
		...(own ? { own } : {}),
		children: Object.freeze(children.map((child) => Object.freeze(child))),
	})
}

function createConfigDefinition(root: ConfigNode): PluginConfigDefinition {
	const parts: Array<{ path: readonly string[]; declaration?: PartConfigDeclaration }> = []
	const visit = (node: ConfigNode) => {
		if (node.path.length > 0) {
			parts.push({ path: node.path, ...(node.own ? { declaration: node.own } : {}) })
		}
		for (const child of node.children) visit(child.node)
	}
	visit(root)
	const source = configNodeSource(root)
	return Object.freeze({
		fieldName: root.own?.fieldName ?? 'config',
		// Preserve the existing Plugin-only schema contract, including object identity.
		// A composite validator is only needed once a Part contributes a subtree.
		schema: root.children.length === 0 && root.own ? root.own.schema : createConfigTreeSchema(root),
		...(source === undefined ? {} : { source }),
		...(root.own ? { owner: root.own } : {}),
		parts: Object.freeze(parts.map((part) => Object.freeze(part))),
	})
}

function configNodeSource(node: ConfigNode): string | undefined {
	if (node.own && node.own.source === undefined) return undefined
	const children: string[] = []
	for (const child of node.children) {
		const source = configNodeSource(child.node)
		if (source === undefined) return undefined
		children.push(`${JSON.stringify(child.key)}:v.optional(${source},{})`)
	}
	const childObject = children.length > 0 ? `v.object({${children.join(',')}})` : undefined
	if (node.own?.source && childObject) return `v.intersect([${node.own.source},${childObject}])`
	return node.own?.source ?? childObject
}

function createConfigTreeSchema(root: ConfigNode): StandardSchemaV1 {
	return Object.freeze({
		'~standard': Object.freeze({
			version: 1 as const,
			vendor: 'pluxel',
			validate: async (input: unknown) => await validateConfigNode(root, input),
		}),
	})
}

async function validateConfigNode(
	node: ConfigNode,
	input: unknown,
): Promise<StandardSchemaV1.Result<Record<string, unknown>>> {
	const candidate = input === undefined ? {} : input
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
		return { issues: [{ message: 'Expected an object', path: node.path }] }
	}
	const record = candidate as Record<string, unknown>
	const childKeys = new Set(node.children.map((child) => child.key))
	const output: Record<string, unknown> = {}
	const issues: StandardSchemaV1.Issue[] = []
	if (node.own) {
		const ownInput: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(record)) {
			if (!childKeys.has(key)) ownInput[key] = value
		}
		try {
			const ownResult = await node.own.schema['~standard'].validate(ownInput)
			if (!('value' in ownResult)) {
				for (const issue of ownResult.issues) {
					issues.push({ ...issue, path: [...node.path, ...(issue.path ?? [])] })
				}
			} else if (
				!ownResult.value ||
				typeof ownResult.value !== 'object' ||
				Array.isArray(ownResult.value)
			) {
				issues.push({ message: 'Config schema must produce an object', path: node.path })
			} else {
				Object.assign(output, ownResult.value)
			}
		} catch (error) {
			issues.push({
				message: error instanceof Error ? error.message : String(error),
				path: node.path,
			})
		}
	}
	for (const child of node.children) {
		if (Object.hasOwn(output, child.key)) {
			issues.push({
				message: `Config field conflicts with PluginPart ${child.key}`,
				path: [...node.path, child.key],
			})
			continue
		}
		const childResult = await validateConfigNode(child.node, record[child.key])
		if (!('value' in childResult)) issues.push(...childResult.issues)
		else output[child.key] = childResult.value
	}
	return issues.length > 0 ? { issues: Object.freeze(issues) } : { value: Object.freeze(output) }
}

const PLUGIN_REF = Symbol('PluginRef')

export type PluginRef<T> = Readonly<{
	readonly definition: PluginDefinitionAddress
	readonly [PLUGIN_REF]: (_value: T) => T
}>

export function definePluginRef<T>(): PluginRef<T> {
	throw new Error(
		'[pluxel/core] Plugin ref was not lowered. definePluginRef<T>() must be a non-exported module-level const processed by the Pluxel semantic pass.',
	)
}

export function __definePluginRef<T>(definition: PluginDefinitionAddress): PluginRef<T> {
	return Object.freeze({
		definition: parsePluginDefinitionAddress(definition),
		[PLUGIN_REF]: ((value: T) => value) as (_value: T) => T,
	})
}

export function isPluginRef(value: unknown): value is PluginRef<unknown> {
	return !!value && typeof value === 'object' && PLUGIN_REF in value
}
